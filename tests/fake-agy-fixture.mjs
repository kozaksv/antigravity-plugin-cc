import fs from "node:fs";
import path from "node:path";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

export const RESULT_BEGIN_MARKER = "===ANTIGRAVITY_RESULT_BEGIN===";
export const RESULT_END_MARKER = "===ANTIGRAVITY_RESULT_END===";

/** The conversation id the fake `agy` maps every cwd to. */
export const FIXTURE_CONVERSATION_ID = "conv-fixture-0001";

/** Reset window the fake `agy` reports in its "quota-exhausted" verbose log. */
export const QUOTA_RESET_WINDOW = "3h59m59s";

/**
 * Install a fake `agy` binary into `binDir` that imitates the one-shot
 * `agy -p "<prompt>"` headless mode the runner depends on. It is a stateless
 * one-shot — read the prompt, print a marked reply, exit 0 — and is NOT an ACP
 * server (no JSON-RPC, no persistent stdio loop).
 *
 *  - `--version` prints a version and exits 0.
 *  - `-p <prompt>` prints a marker-wrapped reply to stdout and exits 0, and
 *    records the cwd -> conversation id mapping in the fake `agy` home
 *    (`cache/last_conversations.json`) plus a transcript JSONL under
 *    `brain/<id>/.system_generated/logs/` so the runner can recover the
 *    conversation id (native resume metadata) and fall back to the transcript.
 *  - resume flags (`-c`, `--conversation <id>`) are accepted and recorded so
 *    tests can assert the runner selected the right resume path.
 *
 * Behaviours (selected via AGY_FIXTURE_BEHAVIOR):
 *  - "ok"              : marker-wrapped reply (default).
 *  - "no-marker"       : raw reply with no markers (exercises the fallback path).
 *  - "transcript-only" : empty stdout, but a transcript with a model reply
 *                        (exercises the transcript-JSONL output-capture fallback,
 *                        i.e. the documented non-TTY stdout-drop resilience).
 *  - "fail"            : prints to stderr and exits 1.
 *  - "hang"            : sleeps far longer than any test timeout (exercises kill).
 *  - "quota-exhausted" : reproduces a real observed failure (agy 1.0.16, 2026-07-04):
 *                        exit 0, empty stdout, NO transcript recorded, but the
 *                        verbose Go log (written to whatever `--log-file <path>`
 *                        the runner passed) contains a RESOURCE_EXHAUSTED (429)
 *                        line with a "Resets in <window>" note.
 *  - "quota-retry-ok"  : writes the SAME RESOURCE_EXHAUSTED verbose log content
 *                        as "quota-exhausted" (a transient retry that DID show
 *                        up in the log), but then completes the turn normally
 *                        (marker-wrapped reply, transcript, exit 0) instead of
 *                        exiting early. Exercises the invariant that a log
 *                        merely MENTIONING RESOURCE_EXHAUSTED must never
 *                        override a turn that produced real, usable output.
 *
 * Regardless of behaviour, a `--conversation <id>` for an id this fixture never
 * issued reproduces real `agy`'s "bogus id -> ran fresh" path: it warns on
 * stderr and then answers fresh (exit 0).
 */
export function installFakeAgy(binDir) {
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "1.0.10-fake";
const BEGIN = ${JSON.stringify(RESULT_BEGIN_MARKER)};
const END = ${JSON.stringify(RESULT_END_MARKER)};
const CONVERSATION_ID = ${JSON.stringify(FIXTURE_CONVERSATION_ID)};
const QUOTA_RESET_WINDOW = ${JSON.stringify(QUOTA_RESET_WINDOW)};
const behavior = process.env.AGY_FIXTURE_BEHAVIOR || "ok";

const argv = process.argv.slice(2);

// Record the full argv so tests can assert which resume flags the runner chose.
if (process.env.AGY_FIXTURE_ARGV_LOG) {
  try {
    fs.appendFileSync(process.env.AGY_FIXTURE_ARGV_LOG, JSON.stringify(argv) + "\\n");
  } catch {
    // best effort
  }
}

if (argv.includes("--version")) {
  process.stdout.write(VERSION + "\\n");
  process.exit(0);
}

function flagValue(name) {
  const idx = argv.indexOf(name);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return null;
}

const prompt = flagValue("-p") ?? flagValue("--print") ?? flagValue("--prompt");
if (prompt == null) {
  process.stderr.write("flag needs an argument: -p\\n");
  process.exit(2);
}

// Record this process's own pid so tests can assert on its liveness (e.g. that
// it does or does not survive its parent wrapper dying) without shelling out to
// \`ps\` to find it. Placed after the early-exit branches above (--version,
// missing -p) so it reflects the real turn's pid, not a short-lived probe.
if (process.env.AGY_FIXTURE_PID_FILE) {
  try {
    fs.writeFileSync(process.env.AGY_FIXTURE_PID_FILE, String(process.pid));
  } catch {
    // best effort
  }
}

if (behavior === "hang") {
  // Sleep effectively forever; the runner must kill us via its own timeout.
  setInterval(() => {}, 1000);
  return;
}

if (behavior === "fail") {
  process.stderr.write("fake agy failure\\n");
  process.exit(1);
}

// Shared by "quota-exhausted" and "quota-retry-ok": writes the same verbose-log
// RESOURCE_EXHAUSTED content either behaviour reproduces. Factored out so the
// two behaviours cannot silently drift apart.
function writeQuotaLog(logFile) {
  if (!logFile) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      "I0704 21:25:29.498251 44290 model_config_manager.go:157] Propagating selected model override to backend\\n" +
        "I0704 21:25:30.244011 44290 log_context.go:117] Encountered retryable api error. retrying in 1.83845231s. Error (The model API is currently overloaded and may experience intermittent errors.): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in " +
        QUOTA_RESET_WINDOW +
        ".\\n" +
        "E0704 21:25:32.482309 44290 log.go:398] agent executor error: model unreachable: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in " +
        QUOTA_RESET_WINDOW +
        ".\\n"
    );
  } catch {
    // best effort, mirrors the other behaviours' best-effort file writes
  }
}

if (behavior === "quota-exhausted") {
  writeQuotaLog(flagValue("--log-file"));
  // Real agy: exits 0 with nothing on stdout and no transcript once every retry
  // inside the turn hits RESOURCE_EXHAUSTED — the failure lives ONLY in the
  // verbose log, never on stdout/stderr/exit-code.
  process.exit(0);
}

if (behavior === "quota-retry-ok") {
  // Same verbose-log content as "quota-exhausted", but deliberately does NOT
  // exit here: falls through to the normal success path below (marker reply +
  // transcript), reproducing a turn where a retry logged RESOURCE_EXHAUSTED but
  // still went on to succeed.
  writeQuotaLog(flagValue("--log-file"));
}

const home = process.env.HOME || os.homedir();
const agyHome = path.join(home, ".gemini", "antigravity-cli");

// Reproduce real \`agy\`'s "bogus conversation id -> warn, then run fresh" path.
const requestedConversation = flagValue("--conversation");
if (requestedConversation && requestedConversation !== CONVERSATION_ID) {
  process.stderr.write('Warning: conversation "' + requestedConversation + '" not found.\\n');
}

// Record the cwd -> conversation id mapping the way real \`agy\` does.
try {
  const cacheDir = path.join(agyHome, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, "last_conversations.json");
  let map = {};
  try {
    map = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    map = {};
  }
  map[process.cwd()] = CONVERSATION_ID;
  fs.writeFileSync(cacheFile, JSON.stringify(map, null, 2));
} catch {
  // best effort
}

const reply = "Reviewed: " + prompt.slice(0, 40).replace(/\\s+/g, " ").trim();

// Always write the structured transcript JSONL (the reliable structured source
// real \`agy\` keeps under brain/<id>/.system_generated/logs/).
try {
  const logsDir = path.join(agyHome, "brain", CONVERSATION_ID, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const lines = [
    JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: prompt }),
    JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: reply })
  ];
  fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), lines.join("\\n") + "\\n");
} catch {
  // best effort
}

if (behavior === "transcript-only") {
  // Simulate a stdout-drop: nothing usable on stdout, transcript is the only
  // source. exit 0, so the runner must NOT trust the exit code alone.
  process.exit(0);
}

if (behavior === "no-marker") {
  process.stdout.write(reply + "\\n");
} else {
  process.stdout.write(BEGIN + "\\n" + reply + "\\n" + END + "\\n");
}
process.exit(0);
`;
  writeExecutable(scriptPath, source);
  return scriptPath;
}

/**
 * Build an environment where the fake `agy` is on PATH and `agy`'s home points
 * at an isolated temp directory (so tests never read or write the real
 * `~/.gemini`). `googleAccount: true` writes a fake `google_accounts.json` so
 * the auth probe reports a Google login. `argvLog` points the fixture at a file
 * where it appends each invocation's argv (for resume-path assertions).
 * `pidFile` points the fixture at a file where it writes its own pid (for
 * liveness/orphan assertions).
 */
export function buildEnv(binDir, options = {}) {
  const fakeHome = options.home ?? makeTempDir("antigravity-home-");
  if (options.googleAccount !== false) {
    const geminiDir = path.join(fakeHome, ".gemini");
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "tester@example.com" }));
  }

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AGY_FIXTURE_BEHAVIOR: options.behavior ?? "ok",
    // Keep state under the fake home so jobs/state never touch the real machine.
    CLAUDE_PLUGIN_DATA: path.join(fakeHome, "plugin-data")
  };

  if (options.argvLog) {
    env.AGY_FIXTURE_ARGV_LOG = options.argvLog;
  }

  if (options.pidFile) {
    env.AGY_FIXTURE_PID_FILE = options.pidFile;
  }

  return env;
}
