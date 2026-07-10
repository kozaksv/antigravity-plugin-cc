#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { restoreWorkspaceSnapshot } from "./lib/git.mjs";
import { resolveStateFile, updateState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "ANTIGRAVITY_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // Identify this session's jobs, tear down their processes, and write the
  // filtered job list as ONE atomic read-modify-write under a single state
  // lock. The prior split — `loadState` OUTSIDE the lock, then `saveState`
  // (which re-reads a FRESH `previousJobs` under its own lock) — let a
  // concurrent writer add a job AFTER our load but BEFORE the locked write:
  // `saveStateUnlocked` would then see that new job in its fresh `previousJobs`
  // but NOT in our stale in-memory snapshot, judge it "dropped", and unlink an
  // ACTIVE job's canonical JSON/log (and silently discard the job record).
  // Filtering INSIDE `updateState` means the delta is computed from the SAME
  // fresh state we mutate, so only this session's jobs are ever removed.
  updateState(workspaceRoot, (state) => {
    const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    if (removedJobs.length === 0) {
      return; // nothing owned by this session; leave the state untouched
    }

    for (const job of removedJobs) {
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        continue;
      }
      // Kill the real detached `agy` process tree (`agyPid`) AND the Node
      // wrapper (`pid`). `/antigravity:cancel` targets both; session cleanup
      // must too, or killing only the wrapper leaves the detached `agy` child
      // (and its tool subprocesses) orphaned past session end. `agyPid` is
      // absent for queued records that never spawned, so de-dupe and skip
      // non-finite values.
      const killTargets = [...new Set([job.agyPid, job.pid].filter((value) => Number.isFinite(value)))];
      for (const pid of killTargets) {
        try {
          terminateProcessTree(pid);
        } catch {
          // Ignore teardown failures during session shutdown.
        }
      }

      // A killed write task can leave a half-applied patch; roll the workspace
      // back to the snapshot captured before the turn (preserving the user's
      // pre-run changes). Best effort — never block session shutdown on cleanup.
      if (job.workspaceSnapshot) {
        try {
          restoreWorkspaceSnapshot(job.workspaceSnapshot);
        } catch {
          // Ignore rollback failures during session shutdown.
        }
      }
    }

    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
