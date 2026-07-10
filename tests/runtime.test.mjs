import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  buildEnv,
  installFakeAgy,
  FIXTURE_CONVERSATION_ID,
  QUOTA_RESET_WINDOW,
  RESULT_BEGIN_MARKER
} from "./fake-agy-fixture.mjs";
import { isAlive, initGitRepo, makeTempDir, run, waitForDeath, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "antigravity-companion.mjs");

const {
  getAntigravityAvailability,
  getAntigravityAuthStatus,
  getSessionRuntimeStatus,
  interruptTurn,
  extractMarkedOutput,
  readConversationIdForCwd,
  readTranscriptOutput,
  detectBogusConversationWarning,
  detectQuotaExhaustion,
  readAgyLogFile,
  runReview,
  runTurn,
  resolveModelWithEffort,
  resolveTurnTimeoutMs,
  parseStructuredOutput,
  assertPromptWithinLimit,
  MAX_PROMPT_BYTES
} = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "antigravity.mjs"));

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

function withFakeAgy(options = {}) {
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const argvLog = path.join(makeTempDir("antigravity-argv-"), "argv.log");
  const env = buildEnv(binDir, { argvLog, ...options });
  const cwd = makeTempDir("antigravity-cwd-");
  return { binDir, env, cwd, argvLog };
}

function readArgvInvocations(argvLog) {
  if (!fs.existsSync(argvLog)) {
    return [];
  }
  return fs
    .readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A dirty git repo (uncommitted tracked change) so `resolveReviewTarget`'s
 * "auto" scope picks working-tree mode without needing an explicit --scope. */
function makeDirtyGitRepo() {
  const cwd = makeTempDir("antigravity-review-cwd-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  return cwd;
}

/**
 * A fake `agy` whose structured-output reply for the Nth `-p` invocation is
 * driven by an on-disk `replies` array (each call selects the next entry,
 * clamped to the last once exhausted) — unlike `installFakeAgy`'s fixed
 * "Reviewed: ..." reply, this lets tests script exactly what JSON (valid,
 * schema-invalid, or non-JSON) `agy` returns turn by turn, to exercise
 * schema validation and bounded repair. It otherwise mirrors the shared
 * fixture: records the cwd -> conversation id mapping (unless
 * `skipConversationId`) and a transcript, and logs argv to
 * `AGY_FIXTURE_ARGV_LOG` so callers can assert on resume flags.
 */
function installStructuredFakeAgy(binDir, { conversationId = "conv-structured-0001" } = {}) {
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "1.0.10-fake-structured";
const BEGIN = ${JSON.stringify(RESULT_BEGIN_MARKER)};
const END = "===ANTIGRAVITY_RESULT_END===";
const CONVERSATION_ID = ${JSON.stringify(conversationId)};

const argv = process.argv.slice(2);

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

const prompt = flagValue("-p");
if (prompt == null) {
  process.stderr.write("flag needs an argument: -p\\n");
  process.exit(2);
}

// Each invocation is a fresh process, so the "which reply is this" call index
// is persisted on disk.
let callIndex = 0;
const counterFile = process.env.AGY_STRUCTURED_COUNTER_FILE;
if (counterFile) {
  try {
    callIndex = Number(fs.readFileSync(counterFile, "utf8").trim()) || 0;
  } catch {
    callIndex = 0;
  }
  try {
    fs.writeFileSync(counterFile, String(callIndex + 1));
  } catch {
    // best effort
  }
}

let replies = [""];
try {
  replies = JSON.parse(fs.readFileSync(process.env.AGY_STRUCTURED_REPLIES_FILE, "utf8"));
} catch {
  replies = [""];
}
const reply = replies[Math.min(callIndex, replies.length - 1)];

const home = process.env.HOME || os.homedir();
const agyHome = path.join(home, ".gemini", "antigravity-cli");

if (process.env.AGY_STRUCTURED_SKIP_CONVERSATION !== "1") {
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
}

process.stdout.write(BEGIN + "\\n" + reply + "\\n" + END + "\\n");
process.exit(0);
`;
  writeExecutable(scriptPath, source);
  return scriptPath;
}

/** Build an isolated env for `installStructuredFakeAgy`: fake HOME (with a
 * Google account so availability/auth probes succeed), argv log, a replies
 * file, and a fresh call counter. */
function withStructuredFakeAgy({ replies = [""], skipConversationId = false, conversationId } = {}) {
  const binDir = makeTempDir("antigravity-structured-bin-");
  installStructuredFakeAgy(binDir, { conversationId });

  const fakeHome = makeTempDir("antigravity-structured-home-");
  const geminiDir = path.join(fakeHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "tester@example.com" }));

  const argvLog = path.join(makeTempDir("antigravity-structured-argv-"), "argv.log");
  const repliesFile = path.join(makeTempDir("antigravity-structured-replies-"), "replies.json");
  fs.writeFileSync(repliesFile, JSON.stringify(replies));
  const counterFile = path.join(makeTempDir("antigravity-structured-counter-"), "counter");
  fs.writeFileSync(counterFile, "0");

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AGY_FIXTURE_ARGV_LOG: argvLog,
    AGY_STRUCTURED_REPLIES_FILE: repliesFile,
    AGY_STRUCTURED_COUNTER_FILE: counterFile,
    CLAUDE_PLUGIN_DATA: path.join(fakeHome, "plugin-data")
  };
  if (skipConversationId) {
    env.AGY_STRUCTURED_SKIP_CONVERSATION = "1";
  }

  return { binDir, env, argvLog, counterFile };
}

function promptInvocations(argvLog) {
  return readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
}

test("getAntigravityAvailability reports available when agy is on PATH", () => {
  const { env, cwd } = withFakeAgy();
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    const status = getAntigravityAvailability(cwd);
    assert.equal(status.available, true);
    assert.match(status.detail, /one-shot runner available/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("getAntigravityAvailability reports unavailable when agy is missing", () => {
  const emptyBin = makeTempDir("antigravity-empty-bin-");
  const previousPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const status = getAntigravityAvailability(makeTempDir());
    assert.equal(status.available, false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("getSessionRuntimeStatus is always direct (no shared runtime)", () => {
  const status = getSessionRuntimeStatus();
  assert.equal(status.mode, "direct");
  assert.equal(status.endpoint, null);
});

test("interruptTurn is a no-op because turns are killed by pid", async () => {
  const result = await interruptTurn();
  assert.equal(result.attempted, false);
  assert.equal(result.interrupted, false);
});

test("extractMarkedOutput prefers marker content and falls back to raw stdout", () => {
  const marked = extractMarkedOutput(`noise\n${RESULT_BEGIN_MARKER}\nhello\n===ANTIGRAVITY_RESULT_END===\ntrailing`);
  assert.equal(marked.markerFound, true);
  assert.equal(marked.text, "hello");

  const fallback = extractMarkedOutput("just plain text\n");
  assert.equal(fallback.markerFound, false);
  assert.equal(fallback.text, "just plain text");
});

test("getAntigravityAuthStatus reports logged in via a one-shot probe", async () => {
  const { env, cwd } = withFakeAgy();
  const status = await getAntigravityAuthStatus(cwd, { env });
  assert.equal(status.available, true);
  assert.equal(status.loggedIn, true);
  assert.equal(status.authMethod, "google");
});

test("getAntigravityAuthStatus reports not logged in when the probe fails", async () => {
  const { env, cwd } = withFakeAgy({ behavior: "fail" });
  const status = await getAntigravityAuthStatus(cwd, { env });
  assert.equal(status.loggedIn, false);
  assert.equal(status.requiresAuth, true);
});

test("getAntigravityAuthStatus runs its probe from a throwaway tmp cwd, never the workspace cwd", async () => {
  // The fake agy records the cwd -> conversation id mapping in
  // <HOME>/.gemini/antigravity-cli/cache/last_conversations.json exactly like
  // real agy (see fake-agy-fixture.mjs and docs/agy-cli.md). If the auth probe
  // ran in the workspace cwd, it would overwrite the workspace's own
  // "most-recent conversation" entry with this disposable "OK" turn, stealing
  // the fast `-c` resume path from the next real task/review in that workspace.
  const { env, cwd } = withFakeAgy();
  const status = await getAntigravityAuthStatus(cwd, { env });
  assert.equal(status.loggedIn, true);

  const cacheFile = path.join(env.HOME, ".gemini", "antigravity-cli", "cache", "last_conversations.json");
  const map = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(map, cwd),
    false,
    `workspace cwd ${cwd} must not appear in the conversation cache: ${JSON.stringify(map)}`
  );
});

test("runTurn captures marker output and the conversation id", async () => {
  const { env, cwd } = withFakeAgy();
  const result = await runTurn(cwd, { prompt: "Investigate the bug", env });
  assert.equal(result.status, 0);
  assert.equal(result.markerFound, true);
  assert.match(result.finalMessage, /Reviewed: Investigate the bug/);
  assert.equal(result.threadId, "conv-fixture-0001");
  assert.equal(readConversationIdForCwd(cwd, env), "conv-fixture-0001");
});

test("runTurn falls back to raw stdout when the model omits markers", async () => {
  const { env, cwd } = withFakeAgy({ behavior: "no-marker" });
  const result = await runTurn(cwd, { prompt: "no markers here", env });
  assert.equal(result.status, 0);
  assert.equal(result.markerFound, false);
  assert.match(result.finalMessage, /Reviewed: no markers here/);
});

test("runTurn falls back to the transcript JSONL when stdout drops (exit 0, empty stdout)", async () => {
  const { env, cwd } = withFakeAgy({ behavior: "transcript-only" });
  const result = await runTurn(cwd, { prompt: "capture from transcript", env });
  // exit 0 with empty stdout must NOT be trusted on its own: the runner reads the
  // conversation transcript to recover the real answer.
  assert.equal(result.status, 0);
  assert.equal(result.markerFound, false);
  assert.equal(result.rawStdout.trim(), "");
  assert.equal(result.outputSource, "transcript");
  assert.match(result.finalMessage, /Reviewed: capture from transcript/);
});

test("readTranscriptOutput returns the last model PLANNER_RESPONSE", async () => {
  const { env, cwd } = withFakeAgy();
  await runTurn(cwd, { prompt: "seed the transcript", env });
  const text = readTranscriptOutput(FIXTURE_CONVERSATION_ID, env);
  assert.match(text, /Reviewed: seed the transcript/);
});

test("runTurn resumes the cwd's most-recent conversation via -c", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  // First turn establishes the cwd -> conversation mapping.
  await runTurn(cwd, { prompt: "first turn", env });
  // Resuming the SAME conversation id that is most-recent for the cwd must take
  // the fast `-c` (continue) path, not the slower `--conversation <id>` path.
  const resumed = await runTurn(cwd, {
    prompt: "second turn",
    env,
    resumeThreadId: FIXTURE_CONVERSATION_ID
  });
  assert.equal(resumed.status, 0);
  assert.equal(resumed.resumedFresh, false);

  const invocations = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  const resumeArgv = invocations.at(-1);
  assert.ok(resumeArgv.includes("-c"), `expected -c in ${JSON.stringify(resumeArgv)}`);
  assert.equal(resumeArgv.includes("--conversation"), false);
});

test("runTurn targets a specific id via --conversation when it is not the cwd's latest", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const resumed = await runTurn(cwd, {
    prompt: "resume a specific id",
    env,
    resumeThreadId: "some-other-conversation"
  });
  assert.equal(resumed.status, 0);
  // The requested id is not the cwd's most-recent (the cwd has no prior turn), so
  // the runner must target it explicitly and surface the bogus-id fresh run.
  assert.equal(resumed.resumedFresh, true);

  const resumeArgv = readArgvInvocations(argvLog).find((argv) => argv.includes("--conversation"));
  assert.ok(resumeArgv, "expected a --conversation invocation");
  assert.equal(resumeArgv[resumeArgv.indexOf("--conversation") + 1], "some-other-conversation");
});

test("detectBogusConversationWarning recognizes agy's not-found warning", () => {
  assert.equal(
    detectBogusConversationWarning('Warning: conversation "abc" not found.'),
    true
  );
  assert.equal(detectBogusConversationWarning("all good"), false);
});

test("detectQuotaExhaustion recognizes agy's RESOURCE_EXHAUSTED log line and extracts the reset window", () => {
  const logText =
    "Encountered retryable api error. retrying in 1.8s. Error: RESOURCE_EXHAUSTED (code 429): " +
    "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h59m59s.";
  const result = detectQuotaExhaustion(logText);
  assert.ok(result);
  assert.equal(result.resetsIn, "3h59m59s");

  assert.equal(detectQuotaExhaustion("all good, no errors here"), null);
  assert.equal(detectQuotaExhaustion(""), null);

  // Go's time.Duration.String() omits leading zero-value components, so a
  // sub-hour reset prints as "12m34s" (no "h") or "45s" (no "h" or "m") — not
  // always the full "h..m..s" shape the regex must also still accept.
  assert.equal(
    detectQuotaExhaustion(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 12m34s."
    ).resetsIn,
    "12m34s"
  );
  assert.equal(
    detectQuotaExhaustion(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 45s."
    ).resetsIn,
    "45s"
  );
});

test("readAgyLogFile reads only the tail of an oversized --log-file", () => {
  const logPath = path.join(makeTempDir("antigravity-logtail-"), "agy.log");
  // Filler well over the intended tail cap; the real RESOURCE_EXHAUSTED signal
  // is appended only at the very end, mirroring real agy (it keeps retrying
  // until the turn dies, so the terminal quota line is always near EOF).
  const filler = "I0704 00:00:00.000000 1 noise.go:1] retrying, nothing to see here\n".repeat(20000);
  const quotaTail =
    "E0704 23:59:59.000000 1 log.go:398] agent executor error: model unreachable: RESOURCE_EXHAUSTED (code 429): " +
    "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h3m4s.\n";
  fs.writeFileSync(logPath, filler + quotaTail, "utf8");
  const fileSizeBytes = fs.statSync(logPath).size;
  assert.ok(fileSizeBytes > 1024 * 1024, "test log must exceed the intended tail cap to be meaningful");

  const text = readAgyLogFile(logPath);
  // The whole point of the cap: never materialize the entire oversized file.
  assert.ok(text.length < fileSizeBytes, "readAgyLogFile must not read the entire oversized log file");

  const quota = detectQuotaExhaustion(text);
  assert.ok(quota, "the quota signal near EOF must still be found within the tail");
  assert.equal(quota.resetsIn, "2h3m4s");
});

test("runTurn surfaces a QUOTA_EXHAUSTED error when agy exits 0 with empty output but its log shows RESOURCE_EXHAUSTED", async () => {
  const { env, cwd, argvLog } = withFakeAgy({ behavior: "quota-exhausted" });
  const result = await runTurn(cwd, { prompt: "review please", env });

  // Real agy: exit 0, no marker, no transcript — must NOT read as generic
  // "no usable output"; the verbose log (via --log-file) names the real cause.
  assert.equal(result.status, 1);
  assert.ok(result.error);
  assert.equal(result.error.code, "QUOTA_EXHAUSTED");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /quota/i);
  assert.match(result.error.message, new RegExp(QUOTA_RESET_WINDOW));

  const invocations = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  const lastArgv = invocations.at(-1);
  assert.ok(lastArgv.includes("--log-file"), `expected --log-file in ${JSON.stringify(lastArgv)}`);
});

test("runTurn does not classify a turn as QUOTA_EXHAUSTED when it still produced a usable final message", async () => {
  // Invariant-pinning test, not a regression reproduction: this passes against
  // today's code already, because the quota-log check in runOneShot is gated
  // behind `if (!finalMessage)`. The fixture's log contains the exact same
  // RESOURCE_EXHAUSTED content as "quota-exhausted" (a transient retry that
  // shows up in the verbose log), but the turn still succeeds — a log that
  // merely MENTIONS RESOURCE_EXHAUSTED must never override real output. This
  // guards that gate against a future refactor that starts consulting the log
  // unconditionally.
  const { env, cwd } = withFakeAgy({ behavior: "quota-retry-ok" });
  const result = await runTurn(cwd, { prompt: "retry then succeed", env });

  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.equal(result.markerFound, true);
  assert.match(result.finalMessage, /Reviewed: retry then succeed/);
});

test("runTurn surfaces a failure when agy exits non-zero", async () => {
  const { env, cwd } = withFakeAgy({ behavior: "fail" });
  const result = await runTurn(cwd, { prompt: "boom", env });
  assert.equal(result.status, 1);
  assert.ok(result.error);
  assert.match(result.stderr, /fake agy failure/);
});

test("runTurn kills a hanging agy process via its own timeout", async () => {
  const { env, cwd } = withFakeAgy({ behavior: "hang" });
  const result = await runTurn(cwd, { prompt: "hang forever", env, timeoutMs: 500 });
  assert.equal(result.status, 1);
  assert.ok(result.error);
  assert.match(result.error.message, /timeout|terminated/i);
});

test("resolveTurnTimeoutMs: explicit options.timeoutMs wins over env and default", () => {
  // Explicit caller override beats a (larger) env value and the default.
  assert.equal(
    resolveTurnTimeoutMs({ timeoutMs: 500, env: { ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS: "999999999" } }),
    500
  );
});

test("resolveTurnTimeoutMs: reads a valid env var as the fallback when no explicit timeout", () => {
  assert.equal(
    resolveTurnTimeoutMs({ env: { ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS: "270000" } }),
    270000
  );
});

test("resolveTurnTimeoutMs: ignores an invalid env var and falls back to the default", () => {
  for (const bad of ["not-a-number", "0", "-5", "NaN", ""]) {
    assert.equal(
      resolveTurnTimeoutMs({ env: { ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS: bad } }),
      DEFAULT_TURN_TIMEOUT_MS,
      `env value ${JSON.stringify(bad)} must be ignored`
    );
  }
});

test("resolveTurnTimeoutMs: uses the default when neither an explicit timeout nor env is set", () => {
  assert.equal(resolveTurnTimeoutMs({ env: {} }), DEFAULT_TURN_TIMEOUT_MS);
});

test("runTurn honors ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS end-to-end (env shrinks the inner turn budget)", async () => {
  // No explicit options.timeoutMs — the only timeout source is the env var the
  // foreground commands / stop hook export. A hanging agy must be killed by the
  // wrapper's own internal timer sourced from that env var, proving the runtime
  // actually reads it (not just the .md command that sets it).
  const { env, cwd } = withFakeAgy({ behavior: "hang" });
  env.ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS = "500";
  const result = await runTurn(cwd, { prompt: "hang forever", env });
  assert.equal(result.status, 1);
  assert.ok(result.error);
  assert.match(result.error.message, /timeout|terminated/i);
});

async function waitForPidFile(pidFile, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
    if (raw) {
      return Number(raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fake agy never wrote its pid to ${pidFile}`);
}

test("an external SIGTERM to the companion process also kills the detached agy child (not just the wrapper)", async () => {
  // Reproduces the real failure mode behind reported "agy timeouts": a caller
  // that wraps a review/task command in its OWN external timeout (a Bash tool
  // timeout, a CI step timeout, feature-pipeline's `timeout=600000`) can only
  // signal the wrapper process it spawned. Before this fix that left the
  // detached `agy` child (its own process group, per docs/agy-cli.md
  // "Concurrency") running forever as an orphan — nothing ever timed it out.
  const pidFile = path.join(makeTempDir("antigravity-agypid-"), "agy.pid");
  const { env, cwd } = withFakeAgy({ behavior: "hang", pidFile });

  const wrapper = spawn(process.execPath, [SCRIPT, "task", "hang please", "-C", cwd], {
    env,
    stdio: "ignore"
  });

  // Hoisted above the try so the finally block can still reach it. If the
  // guard under test ever regresses (agy outlives the wrapper), the assertion
  // below throws and, without this, the fake agy fixture would leak as a
  // hung process for the rest of the test run instead of being cleaned up.
  let agyPid = null;
  try {
    agyPid = await waitForPidFile(pidFile);
    assert.ok(isAlive(agyPid), "fake agy should be running before the wrapper is signalled");

    // Simulate an external supervisor killing only the wrapper it spawned — it
    // has no idea a detached grandchild even exists.
    wrapper.kill("SIGTERM");

    assert.equal(
      await waitForDeath(agyPid),
      true,
      "the detached agy child must not outlive the wrapper's own death"
    );
  } finally {
    if (isAlive(wrapper.pid)) {
      wrapper.kill("SIGKILL");
    }
    if (agyPid !== null && isAlive(agyPid)) {
      process.kill(agyPid, "SIGKILL");
    }
  }
});

test("runReview returns the model review text", async () => {
  const { env, cwd } = withFakeAgy();
  const result = await runReview(cwd, { prompt: "Review the diff", env });
  assert.equal(result.status, 0);
  assert.match(result.reviewText, /Reviewed: Review the diff/);
  assert.equal(result.sourceThreadId, result.threadId);
});

// A2: non-write runs (review, adversarial-review, `task` without `--write`)
// pass `--sandbox` to `agy`; `task --write` never does. See docs/agy-cli.md
// for `--sandbox` and buildAgyArgs (antigravity.mjs) for the argv assembly.
test("runReview (native review) argv includes --sandbox", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const result = await runReview(cwd, { prompt: "Review the diff", env });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  assert.ok(promptRuns[0].includes("--sandbox"), "review argv should include --sandbox");
});

test("runTurn for adversarial-review (sandbox:true, no write) argv includes --sandbox", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const result = await runTurn(cwd, {
    prompt: "Adversarial review the diff",
    env,
    sandbox: true,
    skipPermissions: true
  });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  assert.ok(promptRuns[0].includes("--sandbox"), "adversarial-review argv should include --sandbox");
});

test("runTurn for task --write argv does NOT include --sandbox", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const result = await runTurn(cwd, {
    prompt: "Fix the bug",
    env,
    write: true,
    sandbox: false
  });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  assert.ok(!promptRuns[0].includes("--sandbox"), "task --write argv should NOT include --sandbox");
});

test("ANTIGRAVITY_COMPANION_NO_SANDBOX=1 disables --sandbox even for review", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const noSandboxEnv = { ...env, ANTIGRAVITY_COMPANION_NO_SANDBOX: "1" };
  const result = await runReview(cwd, { prompt: "Review the diff", env: noSandboxEnv });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  assert.ok(
    !promptRuns[0].includes("--sandbox"),
    "ANTIGRAVITY_COMPANION_NO_SANDBOX=1 should suppress --sandbox"
  );
});

test("ANTIGRAVITY_COMPANION_NO_SANDBOX with a non-'1' value does NOT disable --sandbox", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const looseEnv = { ...env, ANTIGRAVITY_COMPANION_NO_SANDBOX: "true" };
  const result = await runReview(cwd, { prompt: "Review the diff", env: looseEnv });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  assert.ok(
    promptRuns[0].includes("--sandbox"),
    "only the exact string '1' should disable --sandbox"
  );
});

test("self-collect review (includeDiff===false) under sandbox still builds correct argv", async () => {
  // Self-collect review instructs `agy` to run its own read-only git inspection
  // commands, so it needs BOTH `--sandbox` (non-write hardening) AND
  // `--dangerously-skip-permissions` (so those headless git commands don't
  // stall on an interactive permission prompt).
  const { env, cwd, argvLog } = withFakeAgy();
  const selfCollectPrompt =
    "Inspect the working tree yourself with read-only git commands before reviewing.";
  const result = await runReview(cwd, { prompt: selfCollectPrompt, env });
  assert.equal(result.status, 0);
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.equal(promptRuns.length, 1);
  const argv = promptRuns[0];
  assert.ok(argv.includes("--sandbox"), "self-collect review argv should include --sandbox");
  assert.ok(
    argv.includes("--dangerously-skip-permissions"),
    "self-collect review argv should still skip permissions so headless git inspection does not hang"
  );
  assert.equal(argv[argv.indexOf("-p") + 1], selfCollectPrompt);
});

test("assertPromptWithinLimit accepts prompts up to the cap and rejects oversized ones", () => {
  assert.equal(assertPromptWithinLimit("small prompt"), Buffer.byteLength("small prompt"));
  // Exactly at the limit is allowed.
  const atLimit = "x".repeat(MAX_PROMPT_BYTES);
  assert.equal(assertPromptWithinLimit(atLimit), MAX_PROMPT_BYTES);
  // One byte over throws an actionable error mentioning the ARG_MAX rationale.
  assert.throws(
    () => assertPromptWithinLimit("x".repeat(MAX_PROMPT_BYTES + 1)),
    /over the .* limit|ARG_MAX/i
  );
});

test("runTurn rejects a prompt that would overflow ARG_MAX before spawning agy", async () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const oversized = "y".repeat(MAX_PROMPT_BYTES + 1024);
  await assert.rejects(
    () => runTurn(cwd, { prompt: oversized, env }),
    /over the .* limit|ARG_MAX/i
  );
  // The runner must NOT have spawned a one-shot `agy -p` with the oversized
  // prompt (an `agy --version` availability probe is fine).
  const promptRuns = readArgvInvocations(argvLog).filter((argv) => argv.includes("-p"));
  assert.deepEqual(promptRuns, []);
});

test("parseStructuredOutput parses fenced JSON and reports parse errors", () => {
  const ok = parseStructuredOutput('```json\n{"verdict":"approve"}\n```');
  assert.deepEqual(ok.parsed, { verdict: "approve" });
  assert.equal(ok.parseError, null);

  const bad = parseStructuredOutput("not json");
  assert.equal(bad.parsed, null);
  assert.ok(bad.parseError);
});

test("companion task --json includes the QUOTA_EXHAUSTED error in the payload, not just an empty rawOutput", () => {
  const { env, cwd } = withFakeAgy({ behavior: "quota-exhausted" });

  const result = run("node", [SCRIPT, "task", "--json", "do the thing"], { cwd, env });
  // The task failed (quota exhausted), so the wrapper's own exit code is
  // non-zero — but the JSON payload on stdout must still carry the reason.
  assert.equal(result.status, 1, result.stdout);
  const payload = JSON.parse(result.stdout);
  // Before this fix, `error` was omitted from the task payload entirely: only
  // {"status":1,"threadId":null,"rawOutput":"","touchedFiles":[],"reasoningSummary":[]}
  // reached callers like stop-review-gate-hook.mjs, which had nothing usable to
  // show besides that raw dump.
  assert.ok(payload.error, `expected payload.error to be present in ${result.stdout}`);
  assert.equal(payload.error.code, "QUOTA_EXHAUSTED");
  assert.equal(payload.error.retryable, false);
  assert.match(payload.error.message, /quota/i);
});

test("companion setup --json reports ready with a fake agy and Google login", () => {
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const env = buildEnv(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.antigravity.available, true);
  assert.equal(report.auth.loggedIn, true);
  assert.equal(report.sessionRuntime.mode, "direct");
});

test("companion setup --json reports needs-attention when agy is missing", () => {
  const emptyBin = makeTempDir("antigravity-empty-bin-");
  const fakeHome = makeTempDir("antigravity-home-");
  // Keep `node` resolvable but exclude any real `agy` from PATH so the runner
  // sees Antigravity as unavailable.
  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${emptyBin}${path.delimiter}${nodeDir}`,
    CLAUDE_PLUGIN_DATA: path.join(fakeHome, "plugin-data")
  };

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.antigravity.available, false);
  assert.match(report.nextSteps.join("\n"), /install\.sh/);
});

// --- A1: adversarial-review structured-output contract and fail-closed validation ---
// Deliberately NO automatic repair turn: resuming "the same" conversation goes
// through agy's shared cwd -> conversation cache, which a concurrent same-repo
// turn can repoint, so a repair could land in a foreign conversation and
// return a schema-valid but ungrounded approve (review escalation, 2026-07-10).

const VALID_REVIEW_JSON = JSON.stringify({
  verdict: "approve",
  summary: "No material findings after adversarial review.",
  findings: [],
  next_steps: []
});

const SCHEMA_INVALID_REVIEW_JSON = JSON.stringify({
  // "maybe" is not in the verdict enum (approve|needs-attention) — valid JSON,
  // invalid against the schema.
  verdict: "maybe",
  summary: "Unsure.",
  findings: [],
  next_steps: []
});

const NON_JSON_REVIEW_TEXT = "I looked at the diff and it seems fine overall, no structured output here.";

test("adversarial-review embeds the serialized review-output schema in the prompt sent to agy", () => {
  const cwd = makeDirtyGitRepo();
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const argvLog = path.join(makeTempDir("antigravity-argv-"), "argv.log");
  const env = buildEnv(binDir, { argvLog });

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.ok(result.stdout, result.stderr);

  const promptRuns = promptInvocations(argvLog);
  assert.ok(promptRuns.length >= 1, "expected at least one -p invocation");
  const initialPrompt = promptRuns[0][promptRuns[0].indexOf("-p") + 1];

  // The {{OUTPUT_SCHEMA}} placeholder must be replaced with the actual
  // serialized JSON Schema (top-level next_steps included), not left dangling.
  assert.equal(initialPrompt.includes("{{OUTPUT_SCHEMA}}"), false);
  assert.match(initialPrompt, /"verdict"/);
  assert.match(initialPrompt, /"next_steps"/);
  assert.match(initialPrompt, /"additionalProperties":\s*false/);
});

test("adversarial-review accepts a schema-valid reply in a single turn", () => {
  const cwd = makeDirtyGitRepo();
  const { env, argvLog } = withStructuredFakeAgy({
    replies: [VALID_REVIEW_JSON]
  });

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stdout || result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.ok(payload.result, "expected a validated result object");
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.parseError, null);
  assert.deepEqual(payload.validationErrors, []);

  // Exactly one turn: the runner never spends extra agy calls on a valid reply.
  assert.equal(promptInvocations(argvLog).length, 1);
});

test("adversarial-review is fail-closed on non-JSON output: explicit error, exactly one turn, no repair", () => {
  const cwd = makeDirtyGitRepo();
  const { env, argvLog } = withStructuredFakeAgy({
    replies: [NON_JSON_REVIEW_TEXT]
  });

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 1, result.stdout || result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.ok(payload.parseError, "expected a parseError explaining the failure");
  assert.notEqual(payload.result?.verdict, "approve");

  // No automatic repair turn: a repair could resume a foreign conversation via
  // the shared cwd cache and come back schema-valid but ungrounded.
  assert.equal(promptInvocations(argvLog).length, 1);
});

test("adversarial-review is fail-closed on schema-invalid JSON: explicit validation error, exactly one turn", () => {
  const cwd = makeDirtyGitRepo();
  const { env, argvLog } = withStructuredFakeAgy({
    replies: [SCHEMA_INVALID_REVIEW_JSON]
  });

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 1, result.stdout || result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.match(payload.parseError, /verdict/);
  assert.ok(
    Array.isArray(payload.validationErrors) && payload.validationErrors.length > 0,
    "expected schema validation errors to be surfaced"
  );

  assert.equal(promptInvocations(argvLog).length, 1);
});

// --- B1: --effort maps onto the agy model-label suffix (agy has no effort flag) ---

test("resolveModelWithEffort maps effort onto model labels and fails on non-effort models", () => {
  // No effort: model (or its alias) passes through untouched.
  assert.equal(resolveModelWithEffort(null, null), null);
  assert.equal(resolveModelWithEffort("flash", null), "Gemini 3.5 Flash (Medium)");

  // Effort without a model: default Gemini Flash family at that effort.
  assert.equal(resolveModelWithEffort(null, "high"), "Gemini 3.5 Flash (High)");

  // Effort replaces an existing (Low|Medium|High) suffix — aliases included.
  assert.equal(resolveModelWithEffort("flash-low", "high"), "Gemini 3.5 Flash (High)");
  assert.equal(resolveModelWithEffort("Gemini 3.1 Pro (High)", "low"), "Gemini 3.1 Pro (Low)");

  // Effort appends to a bare family name.
  assert.equal(resolveModelWithEffort("Gemini 3.5 Flash", "medium"), "Gemini 3.5 Flash (Medium)");

  // A label with a non-effort parenthesized suffix must error, not silently
  // drop the flag (the pre-1.0.2 behavior this replaces).
  assert.throws(() => resolveModelWithEffort("sonnet", "high"), /--effort does not apply to model/);
  assert.throws(() => resolveModelWithEffort(null, "xhigh"), /Unsupported reasoning effort/);
});

test("resolveModelWithEffort rejects effort levels a model family does not offer (no fabricated labels)", () => {
  // `agy models`: Gemini Pro has only Low/High (no Medium); GPT-OSS is
  // Medium-only. Blindly rewriting the suffix produced labels agy rejects.
  assert.throws(() => resolveModelWithEffort("pro", "medium"), /not available for "Gemini 3\.1 Pro".*Low, High/);
  assert.throws(() => resolveModelWithEffort("gpt-oss", "low"), /not available for "GPT-OSS 120B".*Medium/);
  assert.throws(() => resolveModelWithEffort("gpt-oss", "high"), /not available for "GPT-OSS 120B".*Medium/);

  // The levels each family DOES offer still resolve.
  assert.equal(resolveModelWithEffort("pro", "high"), "Gemini 3.1 Pro (High)");
  assert.equal(resolveModelWithEffort("pro", "low"), "Gemini 3.1 Pro (Low)");
  assert.equal(resolveModelWithEffort("gpt-oss", "medium"), "GPT-OSS 120B (Medium)");

  // An unrecognized (future) family is not in the catalog, so it is left to
  // pass through with the suffix applied rather than rejected outright.
  assert.equal(resolveModelWithEffort("Gemini 9 Ultra", "high"), "Gemini 9 Ultra (High)");
});

test("task --effort high reaches agy as --model \"Gemini 3.5 Flash (High)\"", () => {
  const { env, cwd, argvLog } = withFakeAgy();

  const result = run("node", [SCRIPT, "task", "--json", "--effort", "high", "say hi"], { cwd, env });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const [argv] = promptInvocations(argvLog);
  assert.ok(argv, "expected one agy -p invocation");
  const modelIndex = argv.indexOf("--model");
  assert.notEqual(modelIndex, -1, `expected --model in argv ${JSON.stringify(argv)}`);
  assert.equal(argv[modelIndex + 1], "Gemini 3.5 Flash (High)");
});

test("task --model sonnet --effort high fails fast with an actionable error (no silent no-op)", () => {
  const { env, cwd, argvLog } = withFakeAgy();

  const result = run("node", [SCRIPT, "task", "--json", "--model", "sonnet", "--effort", "high", "say hi"], {
    cwd,
    env
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--effort does not apply to model/);
  // Failed before ever spawning agy.
  assert.equal(promptInvocations(argvLog).length, 0);
});

// --- C9: `--timeout-ms 0` must mean "immediate snapshot, no wait" ---

test("status --wait --timeout-ms 0 returns an immediate snapshot instead of falling back to the 240s default", async () => {
  // Before the fix, `waitForSingleJobSnapshot` computed
  // `Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS)`:
  // `Number("0") || DEFAULT` treats 0 as falsy, so an explicit `--timeout-ms 0`
  // silently fell back to polling for up to 240s instead of returning at once.
  const { upsertJob } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs"));

  const workspace = makeTempDir("antigravity-status-wait-workspace-");
  const pluginDataDir = makeTempDir("antigravity-status-wait-data-");
  const jobId = "task-status-wait-zero";

  // `upsertJob` (like the rest of state.mjs) resolves its state root from
  // `process.env.CLAUDE_PLUGIN_DATA` directly (no env-override parameter), so
  // it must be set on THIS process around the write, then restored.
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    upsertJob(workspace, {
      id: jobId,
      status: "running",
      title: "Antigravity Task",
      summary: "still going",
      updatedAt: new Date().toISOString()
    });
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir };
  const startedAt = Date.now();
  const result = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "0", "--json"], {
    cwd: workspace,
    env
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(elapsedMs < 5000, `expected an instant no-wait snapshot, took ${elapsedMs}ms`);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.timeoutMs, 0);
  assert.equal(payload.waitTimedOut, true);
  assert.equal(payload.job.status, "running");
});
