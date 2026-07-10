import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { buildEnv, installFakeAgy } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

const { setConfig } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs"));

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function enableStopGate(workspace, env) {
  // Enable the stop-review gate for this workspace under the same
  // CLAUDE_PLUGIN_DATA the hook (and the `task --json` it spawns) will see.
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    setConfig(workspace, "stopReviewGate", true);
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
  }
}

test("stop-review-gate hook ALLOWS the stop on quota exhaustion, with the actionable reason on stderr", async () => {
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const workspace = makeTempDir("antigravity-stopgate-ws-");
  initGitRepo(workspace);
  // The fake agy's "quota-exhausted" behaviour makes the gated `task --json`
  // turn spawned by the hook fail exactly like real agy does on RESOURCE_EXHAUSTED
  // (exit 0 from agy itself, but the runner surfaces a QUOTA_EXHAUSTED error).
  const env = buildEnv(binDir, { behavior: "quota-exhausted" });
  enableStopGate(workspace, env);

  const { code, stdout, stderr } = await runHook(
    {
      cwd: workspace,
      session_id: "stopgate-quota-test",
      last_assistant_message: "Made some edits to fix the bug."
    },
    env
  );

  assert.equal(code, 0, `hook should exit 0, got stdout=${stdout} stderr=${stderr}`);
  // Blocking on an exhausted quota is an inescapable loop (review-escalation
  // P1): the block reason cannot be fixed, and every subsequent stop attempt
  // re-runs the gate into the same failure until the quota window resets. The
  // gate must ALLOW (no block decision on stdout) and explain itself loudly,
  // with the actual quota message rather than a raw JSON dump.
  assert.equal(stdout.trim(), "", "no block decision may be emitted on quota exhaustion");
  assert.match(stderr, /quota exhausted/i);
  assert.doesNotMatch(stderr, /"rawOutput"/);
});

test("stop-review-gate hook does not run a second review in the same stop cycle (stop_hook_active)", async () => {
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const workspace = makeTempDir("antigravity-stopgate-ws-");
  initGitRepo(workspace);
  const argvLog = path.join(makeTempDir("antigravity-argv-"), "argv.log");
  const env = buildEnv(binDir, { argvLog });
  enableStopGate(workspace, env);

  const { code, stdout, stderr } = await runHook(
    {
      cwd: workspace,
      session_id: "stopgate-loop-test",
      stop_hook_active: true,
      last_assistant_message: "Fixed the issues from the previous review."
    },
    env
  );

  assert.equal(code, 0, `hook should exit 0, got stdout=${stdout} stderr=${stderr}`);
  assert.equal(stdout.trim(), "", "the loop guard must allow the stop, not emit a decision");
  assert.match(stderr, /stop_hook_active/);
  // The guard must fire BEFORE any agy work is spawned: no `-p` invocation at all.
  assert.equal(fs.existsSync(argvLog), false, "no agy turn may be spawned when stop_hook_active is set");
});
