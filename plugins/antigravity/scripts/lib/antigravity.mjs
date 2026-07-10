/**
 * Antigravity (`agy`) runtime layer for the plugin.
 *
 * `agy` has no persistent JSON-RPC server runtime. Each turn is a stateless
 * one-shot: we spawn `agy -p "<prompt>"` (argv only — `-p` never reads stdin),
 * capture stdout (reliable on non-TTY in agy >= 1.0.10 — no pseudo-TTY needed),
 * and extract the answer between result markers, falling back to raw stdout.
 *
 * Resume is native: `-c` resumes the most-recent conversation for the cwd and
 * `--conversation <id>` targets a specific conversation. The conversation id for
 * a cwd is recorded by `agy` in `cache/last_conversations.json`, so there is no
 * re-feed / local history store to maintain.
 *
 * See `docs/agy-cli.md` for the verified CLI probe these choices are based on.
 *
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { readJsonFile } from "./fs.mjs";
import {
  binaryAvailable,
  DEFAULT_TERMINATION_GRACE_MS as TERMINATION_GRACE_MS,
  terminateProcessTree
} from "./process.mjs";

const SERVICE_NAME = "claude_code_antigravity_plugin";
const TASK_THREAD_PREFIX = "Antigravity Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation state. Pick the next highest-value step and follow through until the task is resolved.";

/** Result markers shared with the prompts under `prompts/`. */
export const RESULT_BEGIN_MARKER = "===ANTIGRAVITY_RESULT_BEGIN===";
export const RESULT_END_MARKER = "===ANTIGRAVITY_RESULT_END===";

/** Default external wait before the runner force-kills the `agy` process. */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** `agy`'s own `--print-timeout` is advisory; keep it under the external kill. */
const PRINT_TIMEOUT = "600s";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Hard cap on the prompt we hand to `agy -p`. The prompt is delivered as a
 * single argv value (`-p` does not read stdin — see docs/agy-cli.md), so it
 * counts against the OS `ARG_MAX` (which also covers the rest of argv plus the
 * whole environment block). 128 KiB keeps a worst-case argv+env well under the
 * smallest `ARG_MAX` we expect (macOS is 1 MiB; constrained CI containers can be
 * far lower) and leaves room for the prompt template wrapper around an inline
 * diff. Reviews whose inline diff would exceed this fall back to self-collect in
 * git.mjs (its inline-diff byte cap is kept below this), so they degrade rather
 * than fail; an oversized prompt that still lands here is rejected with a clear
 * error instead of an opaque `E2BIG`/`spawn` failure.
 */
export const MAX_PROMPT_BYTES = 128 * 1024;

/** Throw a clear, actionable error if `prompt` would overflow `ARG_MAX`. */
export function assertPromptWithinLimit(prompt, maxBytes = MAX_PROMPT_BYTES) {
  const bytes = Buffer.byteLength(String(prompt ?? ""), "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `The Antigravity prompt is ${bytes} bytes, over the ${maxBytes}-byte limit. ` +
        "`agy -p` takes the prompt as a single argv value, so an oversized prompt would exceed the OS ARG_MAX. " +
        "Narrow the review scope (e.g. `--base <ref>` or a smaller working set) or split the task into smaller prompts."
    );
  }
  return bytes;
}

/** Friendly aliases mapped onto concrete `agy models` labels. */
const MODEL_ALIASES = new Map([
  ["flash", "Gemini 3.5 Flash (Medium)"],
  ["flash-high", "Gemini 3.5 Flash (High)"],
  ["flash-low", "Gemini 3.5 Flash (Low)"],
  ["pro", "Gemini 3.1 Pro (High)"],
  ["pro-low", "Gemini 3.1 Pro (Low)"],
  ["sonnet", "Claude Sonnet 4.6 (Thinking)"],
  ["opus", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss", "GPT-OSS 120B (Medium)"],
  ["spark", "Gemini 3.5 Flash (Low)"]
]);

export function resolveModelAlias(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

/** Family used when `--effort` is given without a model. */
const DEFAULT_EFFORT_BASE_MODEL = "Gemini 3.5 Flash";
const EFFORT_SUFFIXES = new Map([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"]
]);

/**
 * `agy` has no effort flag: effort is the `(Low|Medium|High)` suffix of the
 * model label (see `agy models`). Map a normalized effort onto the model:
 *  - no effort -> the (alias-resolved) model unchanged;
 *  - effort + no model -> the default Gemini Flash family at that effort;
 *  - effort + a label ending in an effort suffix -> suffix replaced;
 *  - effort + a bare family name ("Gemini 3.5 Flash") -> suffix appended;
 *  - effort + a label with a NON-effort parenthesized suffix (e.g.
 *    "Claude Sonnet 4.6 (Thinking)") -> a clear error, because silently
 *    dropping the flag is exactly the no-op this replaces.
 */
export function resolveModelWithEffort(model, effort) {
  const resolvedModel = resolveModelAlias(model);
  if (!effort) {
    return resolvedModel;
  }
  const suffix = EFFORT_SUFFIXES.get(String(effort).trim().toLowerCase());
  if (!suffix) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`);
  }

  const base = resolvedModel ?? DEFAULT_EFFORT_BASE_MODEL;
  const suffixMatch = base.match(/^(.*)\s\((?:Low|Medium|High)\)$/);
  if (suffixMatch) {
    return `${suffixMatch[1]} (${suffix})`;
  }
  if (/\(.+\)\s*$/.test(base)) {
    throw new Error(
      `--effort does not apply to model "${base}": its label has no (Low|Medium|High) effort variant in \`agy models\`. ` +
        "Pick a Gemini model (e.g. `flash`, `pro`) or drop --effort."
    );
  }
  return `${base} (${suffix})`;
}

function cleanStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

/** Cap on how much of the `--log-file` tail we ever read (see readAgyLogFile). */
const MAX_LOG_TAIL_BYTES = 1024 * 1024;

/**
 * Best-effort read of the per-turn `--log-file`; never throws. Reads only the
 * LAST `MAX_LOG_TAIL_BYTES` of the file, not the whole thing: a quota-retry
 * turn can run for the full 15-minute timeout with agy's verbose Go logger
 * appending the entire time, so the file can grow arbitrarily large. The
 * RESOURCE_EXHAUSTED line we look for repeats throughout such a log and always
 * appears near the very end (agy keeps retrying until the turn dies), so the
 * tail alone is sufficient — this deliberately will not find a signal that
 * appears ONLY earlier in an oversized file. The tail may start mid-line (or
 * mid multi-byte character); that is fine since we only pattern-match ASCII.
 */
export function readAgyLogFile(logFilePath) {
  if (!logFilePath) {
    return "";
  }
  let fd;
  try {
    fd = fs.openSync(logFilePath, "r");
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - MAX_LOG_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const n = fs.readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (n === 0) {
        break; // EOF reached earlier than fstat reported; use what we got.
      }
      bytesRead += n;
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed, or never opened successfully — nothing to do
      }
    }
  }
}

/** Best-effort cleanup of the per-turn `--log-file`; a leftover temp file is harmless. */
function cleanupAgyLogFile(logFilePath) {
  if (!logFilePath) {
    return;
  }
  try {
    fs.unlinkSync(logFilePath);
  } catch {
    // already gone, or never created — nothing to do
  }
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

/**
 * Extract the model answer from `agy -p` stdout.
 *
 * Prefer the content between the result markers (defined in `prompts/`). When
 * the markers are absent (model ignored the contract), fall back to the trimmed
 * raw stdout so we never silently drop a real answer.
 */
export function extractMarkedOutput(stdout) {
  const text = String(stdout ?? "");
  const begin = text.indexOf(RESULT_BEGIN_MARKER);
  if (begin !== -1) {
    const afterBegin = begin + RESULT_BEGIN_MARKER.length;
    const end = text.indexOf(RESULT_END_MARKER, afterBegin);
    const inner = end === -1 ? text.slice(afterBegin) : text.slice(afterBegin, end);
    return { text: inner.trim(), markerFound: true };
  }
  return { text: text.trim(), markerFound: false };
}

/** Base dir `agy` shares with Gemini CLI (`~/.gemini/antigravity-cli`). */
function antigravityHome(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

/** Look up the conversation id `agy` mapped to this cwd, if any. */
export function readConversationIdForCwd(cwd, env = process.env) {
  try {
    const cacheFile = path.join(antigravityHome(env), "cache", "last_conversations.json");
    const map = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!map || typeof map !== "object") {
      return null;
    }
    // `agy` keys the cache by the process cwd, which on some platforms (macOS)
    // is the symlink-resolved path. Try the literal, resolved, and realpath forms.
    const candidates = new Set([cwd, path.resolve(cwd)]);
    try {
      candidates.add(fs.realpathSync(cwd));
    } catch {
      // realpath can fail if cwd no longer exists; ignore.
    }
    for (const key of candidates) {
      if (typeof map[key] === "string") {
        return map[key];
      }
    }
    return null;
  } catch {
    return null;
  }
}

function googleAccountPath(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".gemini", "google_accounts.json");
}

/**
 * Reliable structured fallback when stdout marker parsing fails: read the
 * conversation's transcript JSONL and return the last model reply
 * (`source:"MODEL"`, `type:"PLANNER_RESPONSE"`). See `docs/agy-cli.md`.
 */
export function readTranscriptOutput(conversationId, env = process.env) {
  if (!conversationId) {
    return "";
  }
  const logsDir = path.join(
    antigravityHome(env),
    "brain",
    conversationId,
    ".system_generated",
    "logs"
  );
  for (const fileName of ["transcript.jsonl", "transcript_full.jsonl"]) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(logsDir, fileName), "utf8");
    } catch {
      continue;
    }
    let latest = "";
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry && entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE" && typeof entry.content === "string") {
        latest = entry.content;
      }
    }
    if (latest.trim()) {
      return latest.trim();
    }
  }
  return "";
}

/** Detect agy's "bogus conversation id -> ran fresh" warning in stderr. */
export function detectBogusConversationWarning(stderr) {
  return /conversation\b.*\b(not found|does not exist)/i.test(String(stderr ?? ""));
}

const QUOTA_EXHAUSTED_RE = /RESOURCE_EXHAUSTED|Individual quota reached/i;
// Go's time.Duration.String() omits leading zero-value components, so a
// sub-hour reset prints as "12m34s" (no hours) or "45s" (no hours or minutes),
// and can carry a fractional second (e.g. "1.5s"). Every component but the
// trailing seconds is therefore optional.
const QUOTA_RESET_RE = /Resets in ((?:[0-9]+h)?(?:[0-9]+m)?[0-9]+(?:\.[0-9]+)?s)/i;

/**
 * Detect agy's RESOURCE_EXHAUSTED (429) quota message. This never reaches the
 * process's own stdout/stderr or exit code (agy retries a few times and then
 * exits 0 with nothing usable) — it only appears in agy's own verbose log,
 * which the runner captures via `--log-file` (see readAgyLogFile).
 */
export function detectQuotaExhaustion(logText) {
  const normalized = String(logText ?? "");
  if (!normalized || !QUOTA_EXHAUSTED_RE.test(normalized)) {
    return null;
  }
  const resetMatch = normalized.match(QUOTA_RESET_RE);
  return { resetsIn: resetMatch ? resetMatch[1] : null };
}

function buildAgyArgs(prompt, options = {}) {
  const args = ["-p", prompt, "--print-timeout", options.printTimeout ?? PRINT_TIMEOUT];

  // Resume: prefer `-c` (most-recent-in-cwd) — it is the fast path per
  // docs/agy-cli.md. `--conversation <id>` is slower and prone to hanging past
  // `--print-timeout`, so only use it when we must target a specific id that is
  // NOT already the most-recent conversation for this cwd.
  if (options.resumeWithContinue) {
    args.push("-c");
  } else if (options.resumeConversationId) {
    args.push("--conversation", options.resumeConversationId);
  } else if (options.resumeLatest) {
    args.push("-c");
  }

  const model = resolveModelAlias(options.model);
  if (model) {
    args.push("--model", model);
  }

  // Headless `agy -p` blocks on interactive permission prompts. Both write runs
  // and read-only review runs instruct `agy` to execute tool/git commands
  // (e.g. read-only git inspection in self-collect review contexts), so either
  // can stall until the external timeout. Skip the prompt whenever the run is
  // allowed to invoke tools headlessly.
  if (options.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  // Non-write runs (review, adversarial-review, `task` without `--write`) pass
  // `options.sandbox = true` so `agy` runs under its own terminal-restriction
  // sandbox (docs/agy-cli.md: `--sandbox`) even though we already had to grant
  // `--dangerously-skip-permissions` above (self-collect review still needs to
  // run read-only git inspection commands headlessly). `task --write` runs are
  // expected to edit the workspace, so they never set `options.sandbox` and
  // never get this flag. Escape hatch for environments where `--sandbox`
  // interferes with a run: `ANTIGRAVITY_COMPANION_NO_SANDBOX=1` (validated
  // strict-equality parse — any other value is ignored, not truthy-coerced).
  const sandboxEnv = options.env ?? process.env;
  const sandboxDisabled = sandboxEnv.ANTIGRAVITY_COMPANION_NO_SANDBOX === "1";
  if (options.sandbox && !sandboxDisabled) {
    args.push("--sandbox");
  }

  // Routes agy's verbose Go log to a path we control, so a turn that produces
  // no usable stdout (e.g. RESOURCE_EXHAUSTED, which agy never surfaces on
  // stdout/stderr/exit-code) can still be diagnosed after the fact.
  if (options.logFilePath) {
    args.push("--log-file", options.logFilePath);
  }

  return args;
}

/**
 * Guard against an external kill of THIS process (a Bash-tool timeout, a CI
 * step timeout, `feature-pipeline`'s own wrapping timeout, Ctrl-C, ...)
 * orphaning the detached `agy` child. `agy` is spawned `detached: true` in its
 * own process group specifically so our OWN timeout above can signal it as a
 * group — but that same detachment means an external SIGTERM/SIGINT to only
 * this process's pid never reaches `agy`, which then runs forever (its
 * `--print-timeout` is advisory, not a hard kill; see docs/agy-cli.md). Install
 * this for the lifetime of the child and forward the signal before we exit.
 *
 * This guard is POSIX-only. On win32, Node emulates an externally-sent SIGTERM
 * as a hard `TerminateProcess`, so no JS `SIGTERM`/`SIGINT` listener ever runs
 * — the handler below is simply never invoked. That is acceptable there: `agy`
 * is also not spawned `detached` on win32 (see the `spawn` call below), so it
 * shares this process's console/job object instead of living in its own
 * detached group, and is not at risk of being orphaned the way a detached
 * POSIX child is.
 */
function installExternalKillGuard(getChildPid) {
  const handler = (signal) => {
    const pid = getChildPid();
    if (Number.isFinite(pid)) {
      // Non-blocking SIGTERM only (escalate: false): this process is agy's
      // actual OS parent, so the default synchronous SIGTERM->grace->SIGKILL
      // escalation would block on Atomics.wait — freezing the very event loop
      // that reaps agy via SIGCHLD. That turns a clean, instant death into a
      // zombie for the entire grace window (kill(pid, 0) reports a zombie as
      // alive), which we'd otherwise wait out for nothing. Fire-and-forget
      // instead; docs/agy-cli.md's own testing found a single SIGTERM
      // sufficient to kill a live `agy` (no SIGKILL needed) — that SIGTERM is
      // what ends it, not reparenting. Reparenting to init on our exit does
      // not hasten a live agy's death; it only guarantees the resulting
      // zombie gets reaped once we are gone, since reaping applies to an
      // already-exited (zombie) process, not a live one.
      terminateProcessTree(pid, { escalate: false });
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  };
}

/**
 * Resolve the internal per-turn kill timeout (ms). Precedence:
 *   1. An explicit positive `options.timeoutMs` (caller override) always wins.
 *   2. Otherwise `ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS` from the run env, when
 *      it parses to a finite number > 0. This is the knob a foreground command
 *      (Bash 600s ceiling) and the stop-review hook (spawnSync 840s budget) use
 *      to shrink the wrapper's internal budget BELOW the external kill, so the
 *      wrapper self-times-out and reaps `agy` first instead of being killed
 *      mid-turn — an external kill of the wrapper would orphan the detached
 *      `agy` process tree.
 *   3. Otherwise the built-in default.
 * A present-but-invalid env value (NaN, <= 0, non-numeric) is ignored with a
 * stderr note rather than silently swallowed, so a typo can't quietly restore
 * the 900s default and re-lose the timeout race.
 */
export function resolveTurnTimeoutMs(options = {}) {
  const explicit = Number(options.timeoutMs);
  if (explicit > 0) {
    return explicit;
  }
  const env = options.env ?? process.env;
  const raw = env?.ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    process.stderr.write(
      `Ignoring invalid ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS=${JSON.stringify(String(raw))}; ` +
        "expected a positive number of milliseconds. Falling back to the default turn timeout.\n"
    );
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

/**
 * Run a single `agy -p` turn. Spawns without a shell (argv array), captures
 * stdout/stderr, and owns its own timeout + process-tree kill because
 * `--print-timeout` is advisory only.
 */
function spawnAgyTurn(cwd, prompt, options = {}) {
  return new Promise((resolve) => {
    const args = buildAgyArgs(prompt, options);
    const child = spawn("agy", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    // Install the external-kill guard BEFORE onSpawn below. onSpawn (job-file
    // bookkeeping) does several synchronous fs calls that can take a few ms —
    // an external SIGTERM landing in that window, before this process has any
    // SIGTERM listener, would hit Node's default disposition (immediate exit)
    // and skip the guard entirely, leaving agy unprotected. Registering first
    // closes that race (proven flaky in testing: the child's own startup can
    // finish, and get signalled, before a listener-after-bookkeeping ever runs).
    const removeExternalKillGuard = installExternalKillGuard(() => child.pid);

    // Surface the real `agy` child pid so the caller can persist it for cancel.
    // The Node wrapper's `process.pid` is NOT the agy process (and on a detached
    // spawn the agy process tree outlives a wrapper kill), so cancel must target
    // this pid / its process group.
    if (typeof options.onSpawn === "function" && Number.isFinite(child.pid)) {
      try {
        options.onSpawn(child.pid);
      } catch {
        // Recording the pid is best effort; never fail the turn over it.
      }
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let spawnError = null;

    const timeoutMs = resolveTurnTimeoutMs(options);
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      // In-process timeout path: send SIGTERM now without the synchronous grace
      // wait (that would block this event loop), then escalate to SIGKILL via an
      // async timer if `agy` has not exited and closed the pipe by then.
      terminateProcessTree(child.pid ?? Number.NaN, { escalate: false });
      killTimer = setTimeout(() => {
        terminateProcessTree(child.pid ?? Number.NaN, { escalate: false, signalOverride: "SIGKILL" });
      }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      removeExternalKillGuard();
      resolve({
        status: spawnError ? 1 : code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        error: spawnError
      });
    });
  });
}

export function getAntigravityAvailability(cwd, options = {}) {
  const versionStatus = binaryAvailable("agy", ["--version"], {
    cwd,
    env: options.env ?? process.env
  });
  if (!versionStatus.available) {
    return versionStatus;
  }
  return {
    available: true,
    detail: `${versionStatus.detail}; one-shot runner available`
  };
}

/**
 * `agy` has no shared persistent runtime. Each command spawns its own one-shot
 * `agy -p` process, so the session is always "direct".
 */
export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Each Antigravity review or task spawns its own one-shot `agy -p` process.",
    endpoint: null
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "agy",
    authMethod: null,
    verified: null,
    requiresAuth: null,
    ...fields
  };
}

/**
 * Probe auth by running a cheap one-shot. `agy` reads its Google OAuth login
 * from `~/.gemini`, so a successful one-shot proves the configured credentials
 * work without consuming meaningful model budget. A logged-in Google account at
 * `~/.gemini/google_accounts.json` is treated as the supporting signal.
 */
export async function getAntigravityAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getAntigravityAvailability(cwd, { env });
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresAuth: null
    };
  }

  const hasGoogleAccount = fs.existsSync(googleAccountPath(env));

  try {
    const result = await spawnAgyTurn(cwd, "Reply with exactly: OK", {
      env,
      timeoutMs: options.timeoutMs ?? 60 * 1000,
      printTimeout: "45s"
    });
    const { text } = extractMarkedOutput(result.stdout);
    if (result.status === 0 && (text || result.stdout.trim())) {
      return buildAuthStatus({
        loggedIn: true,
        detail: hasGoogleAccount ? "Authenticated (Google account)" : "Authenticated",
        authMethod: hasGoogleAccount ? "google" : "agy",
        verified: true,
        requiresAuth: false
      });
    }

    const detail =
      cleanStderr(result.stderr) ||
      (result.timedOut ? "auth probe timed out" : "auth probe returned no output");
    return buildAuthStatus({
      loggedIn: false,
      detail,
      requiresAuth: true
    });
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      requiresAuth: true
    });
  }
}

/**
 * One-shot `agy -p` has no out-of-band interrupt channel: each turn owns its own
 * `agy` process, which the caller terminates directly via the tracked pid. There
 * is no shared runtime to route a cancel through.
 */
export async function interruptTurn() {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: "Antigravity turns are cancelled by terminating the tracked `agy` process."
  };
}

function ensureAvailable(cwd, env = process.env) {
  const availability = getAntigravityAvailability(cwd, { env });
  if (!availability.available) {
    throw new Error(
      "Antigravity CLI (`agy`) is not installed. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then rerun `/antigravity:setup`."
    );
  }
}

async function runOneShot(cwd, options = {}) {
  const env = options.env ?? process.env;
  ensureAvailable(cwd, env);

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Antigravity run.");
  }
  // `agy -p` delivers the prompt via argv, so cap it before spawn to stay under
  // ARG_MAX. README documents this cap; enforce it here rather than letting the
  // OS reject the spawn with an opaque E2BIG.
  assertPromptWithinLimit(prompt, options.maxPromptBytes ?? MAX_PROMPT_BYTES);

  // Resume strategy (see docs/agy-cli.md): prefer `-c` (most-recent-in-cwd) — it
  // is the fast path and consistently honors output. Only fall back to the
  // slower, hang-prone `--conversation <id>` when the targeted id is NOT already
  // the most-recent conversation for this cwd.
  const requestedResumeId = options.resumeThreadId || null;
  let resumeConversationId = null;
  let resumeWithContinue = false;
  if (requestedResumeId) {
    const latestForCwd = readConversationIdForCwd(cwd, env);
    if (latestForCwd && latestForCwd === requestedResumeId) {
      resumeWithContinue = true;
    } else {
      resumeConversationId = requestedResumeId;
    }
    emitProgress(options.onProgress, `Resuming conversation ${requestedResumeId}.`, "starting");
  } else {
    emitProgress(options.onProgress, "Starting Antigravity conversation.", "starting");
  }

  emitProgress(options.onProgress, "Running `agy -p`.", "running");
  const logFilePath = path.join(
    os.tmpdir(),
    `antigravity-agy-log-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const result = await spawnAgyTurn(cwd, prompt, {
    env,
    model: options.model,
    // Headless runs cannot answer permission prompts. Write runs obviously need
    // it; read-only review runs also instruct agy to run git inspection commands
    // (self-collect), so they must skip permissions too or they hang.
    skipPermissions: options.write || options.skipPermissions === true,
    sandbox: options.sandbox === true,
    resumeConversationId,
    resumeWithContinue,
    timeoutMs: options.timeoutMs,
    onSpawn: options.onSpawn,
    logFilePath
  });

  // After a turn `agy` records the cwd -> conversation id mapping; surface it as
  // the thread id so resume can target this conversation later.
  const recordedConversationId = readConversationIdForCwd(cwd, env);
  const conversationId = recordedConversationId ?? requestedResumeId ?? null;
  const { text: markedText, markerFound } = extractMarkedOutput(result.stdout);
  const stderr = cleanStderr(result.stderr);

  // Resume verification: `--conversation <id>` with a bogus id prints a warning
  // and then runs *fresh* (exit 0). Surface that so callers don't silently treat
  // a fresh conversation as a resumed one.
  const bogusResume =
    Boolean(requestedResumeId) &&
    !resumeWithContinue &&
    detectBogusConversationWarning(result.stderr);
  if (bogusResume) {
    emitProgress(
      options.onProgress,
      `Conversation ${requestedResumeId} was not found; started a fresh conversation.`,
      "running"
    );
  }

  // Resume-target verification (fail-closed). `agy` records the conversation it
  // ACTUALLY operated on in `last_conversations.json`; after a resume turn that
  // recorded id must equal the id we asked to resume. If it does not, the turn
  // ran against the WRONG conversation — the classic case being the `-c`
  // ("continue most-recent") fast path: we picked `-c` because the cache showed
  // `requestedResumeId` was most-recent, but between that check and the spawn a
  // concurrent run in the SAME cwd made a DIFFERENT conversation most-recent, so
  // `-c` continued theirs, not ours. `resumedFresh` only caught the bogus
  // explicit-`--conversation` case, so a schema-valid answer produced against an
  // unrelated conversation would have been silently accepted, breaking the
  // fail-closed invariant. Treat any resume-target mismatch exactly like a fresh
  // (ungrounded) run so callers reject it. Only asserted for resume turns
  // (`requestedResumeId` set); initial turns never set it.
  const resumeTargetMismatch =
    Boolean(requestedResumeId) && recordedConversationId !== requestedResumeId;

  let error = null;
  if (result.error) {
    error = { message: result.error.message };
  } else if (result.timedOut) {
    error = { message: "The `agy` process exceeded the runner timeout and was terminated." };
  } else if (result.status !== 0) {
    error = { message: stderr || `agy exited with status ${result.status}.` };
  }

  // Output verification (docs/agy-cli.md): never trust exit 0 alone. Prefer the
  // marker-delimited stdout; when the marker is missing or empty, fall back to
  // the conversation transcript JSONL (the reliable structured source); only
  // then accept raw stdout. Reject a turn that produced no usable output at all
  // instead of silently returning an empty answer.
  let finalMessage = markerFound ? markedText : "";
  let outputSource = "marker";
  if (!error && !finalMessage) {
    const transcriptText = readTranscriptOutput(conversationId, env);
    if (transcriptText) {
      finalMessage = transcriptText;
      outputSource = "transcript";
    } else if (markedText) {
      // markedText here is the trimmed raw stdout (marker absent) — last resort.
      finalMessage = markedText;
      outputSource = "stdout";
    }
  }
  // agy can swallow a RESOURCE_EXHAUSTED (429) turn entirely: exit 0, empty
  // stdout, no transcript — nothing on any channel this runner already reads.
  // Whenever the turn produced nothing usable, check its verbose log (routed to
  // logFilePath above) before settling for the generic message; the quota
  // signal is strictly more actionable than any error assembled above,
  // including a timeout (agy can spend the whole timeout window retrying a
  // quota it will never recover from within the turn).
  if (!finalMessage) {
    const quota = detectQuotaExhaustion(readAgyLogFile(logFilePath));
    if (quota) {
      error = {
        code: "QUOTA_EXHAUSTED",
        retryable: false,
        message: quota.resetsIn
          ? `Antigravity quota exhausted (RESOURCE_EXHAUSTED). Resets in ${quota.resetsIn}. Not retryable until then.`
          : "Antigravity quota exhausted (RESOURCE_EXHAUSTED). Not retryable right now."
      };
    } else if (!error) {
      error = {
        message:
          "`agy` exited successfully but produced no result marker, no usable stdout, and no transcript output."
      };
    }
  }
  cleanupAgyLogFile(logFilePath);

  const status = error ? 1 : 0;
  if (status === 0) {
    emitProgress(options.onProgress, "Turn completed.", "finalizing");
  } else {
    emitProgress(options.onProgress, `Antigravity error: ${error.message}`, "failed");
  }

  return {
    status,
    threadId: conversationId,
    turnId: null,
    finalMessage,
    rawStdout: result.stdout,
    markerFound,
    outputSource,
    resumedFresh: bogusResume || resumeTargetMismatch,
    reasoningSummary: [],
    turn: { id: conversationId ?? "agy-turn", status: status === 0 ? "completed" : "failed" },
    error,
    stderr,
    touchedFiles: [],
    commandExecutions: []
  };
}

/**
 * `/antigravity:review` (native review). Without a dedicated reviewer mode, this
 * is a one-shot turn whose answer is returned verbatim by the caller.
 */
export async function runReview(cwd, options = {}) {
  ensureAvailable(cwd, options.env ?? process.env);
  const result = await runOneShot(cwd, {
    prompt: options.prompt,
    model: options.model,
    write: false,
    // Read-only review, but the prompt may instruct `agy` to run read-only git
    // inspection commands. In headless `agy -p` those would block on a permission
    // prompt until the external timeout, so skip permissions for the review.
    skipPermissions: true,
    // `runReview` is always a read-only native review (never `--write`), so it
    // always runs under `--sandbox` (see buildAgyArgs); no caller opt-out.
    sandbox: true,
    onProgress: options.onProgress,
    onSpawn: options.onSpawn,
    env: options.env,
    timeoutMs: options.timeoutMs
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: result.threadId,
    turnId: result.turnId,
    reviewText: result.finalMessage,
    reasoningSummary: result.reasoningSummary,
    turn: result.turn,
    error: result.error,
    stderr: result.stderr
  };
}

/** `/antigravity:adversarial-review` and `/antigravity:rescue` task turns. */
export async function runTurn(cwd, options = {}) {
  return runOneShot(cwd, options);
}

/**
 * `agy` owns conversation history in its own SQLite store keyed by cwd, so there
 * is no plugin-named thread list to search. Cross-session resume relies on the
 * plugin's persisted job records (their stored conversation ids) instead.
 */
export async function findLatestTaskThread() {
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

function stripJsonFences(rawOutput) {
  const trimmed = String(rawOutput ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Antigravity did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(stripJsonFences(rawOutput)),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, SERVICE_NAME, TASK_THREAD_PREFIX };
