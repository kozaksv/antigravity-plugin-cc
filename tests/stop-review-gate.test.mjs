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

test("stop-review-gate hook surfaces the quota-exhausted reason instead of a raw JSON dump", async () => {
  const binDir = makeTempDir("antigravity-bin-");
  installFakeAgy(binDir);
  const workspace = makeTempDir("antigravity-stopgate-ws-");
  initGitRepo(workspace);
  // The fake agy's "quota-exhausted" behaviour makes the gated `task --json`
  // turn spawned by the hook fail exactly like real agy does on RESOURCE_EXHAUSTED
  // (exit 0 from agy itself, but the runner surfaces a QUOTA_EXHAUSTED error).
  const env = buildEnv(binDir, { behavior: "quota-exhausted" });

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

  const { code, stdout } = await runHook(
    {
      cwd: workspace,
      session_id: "stopgate-quota-test",
      last_assistant_message: "Made some edits to fix the bug."
    },
    env
  );

  // The hook always exits 0 on a handled path; a block decision is conveyed on
  // stdout, not via the process exit code.
  assert.equal(code, 0, `hook should exit 0 and emit a block decision on stdout, got stdout=${stdout}`);
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, "block");
  // Before this fix, the hook's `detail` was the raw `task --json` stdout dump,
  // e.g. `{"status":1,"threadId":null,"rawOutput":"","touchedFiles":[],"reasoningSummary":[]}`
  // — useless for a human deciding whether to retry. It must now read the
  // actual quota message.
  assert.match(decision.reason, /quota exhausted/i);
  assert.doesNotMatch(decision.reason, /"rawOutput"/);
});
