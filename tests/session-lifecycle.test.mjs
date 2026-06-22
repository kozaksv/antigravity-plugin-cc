import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { initGitRepo, makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

const { saveState, loadState } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs"));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const liveHelpers = [];

function spawnLongLived() {
  // A detached node process that sleeps far longer than the test; its own
  // process group, so a process-tree kill exercises the group path. We keep the
  // ChildProcess handle (do NOT unref) so this test process — the helper's
  // parent — reaps it promptly when it dies. Without prompt reaping the killed
  // child lingers as a zombie that `kill(-pgid, 0)` still reports as "alive",
  // which would force the grace-period escalation to wait its full window.
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  liveHelpers.push(child);
  return child.pid;
}

async function waitForDeath(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

test("SessionEnd cleanup kills BOTH the wrapper pid and the detached agy pid", async () => {
  const workspace = makeTempDir("antigravity-session-ws-");
  initGitRepo(workspace);
  const dataDir = makeTempDir("antigravity-session-data-");
  const sessionId = "session-cleanup-test";

  const wrapperPid = spawnLongLived();
  const agyPid = spawnLongLived();
  assert.ok(isAlive(wrapperPid) && isAlive(agyPid), "both helper processes should start alive");

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    // Seed a running job that tracks distinct wrapper + agy pids.
    saveState(workspace, {
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "task-cleanup-1",
          status: "running",
          jobClass: "task",
          sessionId,
          pid: wrapperPid,
          agyPid,
          updatedAt: new Date().toISOString()
        }
      ]
    });
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
  }

  const input = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: workspace });
  // Run the hook asynchronously (not spawnSync) so THIS test's event loop stays
  // free to reap the helper processes the moment the hook kills them — otherwise
  // they linger as zombies and the hook's liveness probe would wait the whole
  // grace window.
  const exitCode = await new Promise((resolve, reject) => {
    const hook = spawn(process.execPath, [HOOK, "SessionEnd"], { env, stdio: ["pipe", "inherit", "inherit"] });
    hook.on("error", reject);
    hook.on("close", (code) => resolve(code));
    hook.stdin.end(input);
  });
  assert.equal(exitCode, 0);

  // The real regression: the hook used to kill only job.pid, leaving the
  // detached agy pid orphaned. Both must die now.
  assert.equal(await waitForDeath(wrapperPid), true, "wrapper pid should be terminated");
  assert.equal(await waitForDeath(agyPid), true, "detached agy pid should be terminated");

  // Defensive cleanup if the assertions somehow leave a process alive.
  for (const pid of [wrapperPid, agyPid]) {
    try {
      if (isAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // ignore
    }
  }

  // The session's jobs are pruned from state after cleanup.
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const state = loadState(workspace);
    assert.equal(state.jobs.some((job) => job.sessionId === sessionId), false);
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
  }
});
