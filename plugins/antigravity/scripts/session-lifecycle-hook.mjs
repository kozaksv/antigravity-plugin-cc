#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { restoreWorkspaceSnapshot } from "./lib/git.mjs";
import { loadState, resolveStateFile, updateState } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

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

  // Three phases, and only the LAST one holds the state lock:
  //
  //  1. CAPTURE (lock-free read): identify this session's still-active jobs.
  //  2. TEARDOWN (lock-free): kill their process trees and roll back write-task
  //     snapshots. `terminateProcessTree` synchronously waits a grace period
  //     per pid and the rollback runs git commands — doing this under the state
  //     lock (the previous design) starved every concurrent same-workspace
  //     state writer, whose lock acquire times out at ~5s, aborting unrelated
  //     active jobs (review-escalation P1).
  //  3. REMOVE (one atomic read-modify-write under the lock): filter this
  //     session's jobs from the FRESH state. Mutating fresh state under the
  //     lock keeps the earlier lost-update fix: a job another session added
  //     meanwhile survives, because we only ever REMOVE our own session's rows.
  //
  // Kill-then-remove ordering matters: a still-alive worker whose record was
  // removed first would resurrect it via its next progress upsert (upsertJob
  // creates missing ids). After phase 2 the workers are dead and cannot
  // re-add themselves; a worker that survived the kill (e.g. EPERM) keeps its
  // record only by actually being alive — which is the truthful outcome.
  const capturedJobs = loadState(workspaceRoot).jobs.filter((job) => job.sessionId === sessionId);
  if (capturedJobs.length === 0) {
    return;
  }

  for (const job of capturedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    // Kill the real detached `agy` process tree (`agyPid`) AND the Node
    // wrapper (`pid`). `/antigravity:cancel` targets both; session cleanup
    // must too, or killing only the wrapper leaves the detached `agy` child
    // (and its tool subprocesses) orphaned past session end. `agyPid` is
    // absent for queued records that never spawned, so de-dupe and skip
    // non-finite values. Short grace: session shutdown has a hard hook
    // timeout, and the SIGKILL escalation is the point here, not politeness.
    const killTargets = [...new Set([job.agyPid, job.pid].filter((value) => Number.isFinite(value)))];
    for (const pid of killTargets) {
      try {
        terminateProcessTree(pid, { graceMs: 2000 });
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

  updateState(workspaceRoot, (state) => {
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
