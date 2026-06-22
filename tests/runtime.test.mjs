import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  buildEnv,
  installFakeAgy,
  FIXTURE_CONVERSATION_ID,
  RESULT_BEGIN_MARKER
} from "./fake-agy-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

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
  runReview,
  runTurn,
  parseStructuredOutput,
  assertPromptWithinLimit,
  MAX_PROMPT_BYTES
} = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "antigravity.mjs"));

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

test("runReview returns the model review text", async () => {
  const { env, cwd } = withFakeAgy();
  const result = await runReview(cwd, { prompt: "Review the diff", env });
  assert.equal(result.status, 0);
  assert.match(result.reviewText, /Reviewed: Review the diff/);
  assert.equal(result.sourceThreadId, result.threadId);
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
