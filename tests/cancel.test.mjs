import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "antigravity-companion.mjs");

const { snapshotWorkspace } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "git.mjs"));
const { saveState, writeJobFile } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs"));

// A pid that is never a live process (nor process group) on this host.
const DEAD_PID = 2147483646;

/**
 * Regression for the review-escalation P1: `/antigravity:cancel` must NOT roll
 * back the workspace when the job actually FINISHED on its own before the
 * cancel landed. The earlier code rolled back using the snapshot captured at
 * the top-of-handler read (when the job was still running), so a job that
 * committed `completed` in the meantime had its legitimate output erased while
 * cancel reported "nothing to cancel". The fix re-reads the canonical status
 * AFTER confirming the process is stopped and skips the rollback for a job that
 * already reached a terminal status.
 */
test("cancel does not roll back a job that already completed (its output is preserved)", () => {
  const repo = makeTempDir("antigravity-cancel-repo-");
  const dataDir = makeTempDir("antigravity-cancel-data-");
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;

  try {
    initGitRepo(repo);
    const file = path.join(repo, "output.txt");
    fs.writeFileSync(file, "v1\n");
    run("git", ["add", "output.txt"], { cwd: repo });
    run("git", ["commit", "-m", "v1"], { cwd: repo });

    // Snapshot captures the clean v1 state (what a rollback would restore to).
    const snapshot = snapshotWorkspace(repo);

    // The turn's legitimate, COMPLETED output: edit the file to v2.
    fs.writeFileSync(file, "v2\n");

    const jobId = "task-cancel-completed";
    // Canonical job file: the worker committed `completed`, but it still carries
    // the pre-run snapshot (as it would in the exact race window). Dead pids so
    // the cancel confirms the process is stopped without a real kill.
    writeJobFile(repo, jobId, {
      id: jobId,
      status: "completed",
      jobClass: "task",
      write: true,
      pid: DEAD_PID,
      agyPid: DEAD_PID,
      workspaceSnapshot: snapshot
    });
    // Index still shows the job active, so `resolveCancelableJob` selects it —
    // exactly the mismatch the race produces. saveState writes the index
    // verbatim (no canonical-derivation), unlike upsertJob.
    saveState(repo, {
      config: { stopReviewGate: false },
      jobs: [
        {
          id: jobId,
          status: "running",
          jobClass: "task",
          write: true,
          pid: DEAD_PID,
          agyPid: DEAD_PID,
          workspaceSnapshot: snapshot,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    });

    const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
      cwd: repo,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    // The completed output MUST survive — a rollback here would erase it.
    assert.equal(fs.readFileSync(file, "utf8"), "v2\n", "cancel must not roll back completed work");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.cancelled, false);
    assert.match(payload.status, /completed/);
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
  }
});

/**
 * A job that reached terminal `failed` but whose index lingered `running` may be
 * cancelled LONG after the failure, once the user has edited the tree. Cancel
 * must therefore be NON-destructive for a failed job: it must NOT `git reset
 * --hard` (which could wipe the user's later work — no recovery capture fully
 * covers untracked/conflicted state), only report the failure and leave the
 * workspace as-is (review escalation, passes 3-5). The mid-flight cancel of a
 * still-running job, where the delta provably belongs to the turn, is what does
 * roll back — see the completed-vs-running paths.
 */
test("cancel does NOT hard-reset a stale failed job; the workspace is left untouched", () => {
  const repo = makeTempDir("antigravity-cancel-failed-repo-");
  const dataDir = makeTempDir("antigravity-cancel-failed-data-");
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;

  try {
    initGitRepo(repo);
    const file = path.join(repo, "output.txt");
    fs.writeFileSync(file, "v1\n");
    run("git", ["add", "output.txt"], { cwd: repo });
    run("git", ["commit", "-m", "v1"], { cwd: repo });

    const snapshot = snapshotWorkspace(repo);
    // Whatever is in the tree now (a failed turn's partial edit and/or the
    // user's own later work) must survive a cancel of the already-failed job.
    fs.writeFileSync(file, "users-later-work\n");

    const jobId = "task-cancel-failed";
    writeJobFile(repo, jobId, {
      id: jobId,
      status: "failed",
      jobClass: "task",
      write: true,
      pid: DEAD_PID,
      agyPid: DEAD_PID,
      workspaceSnapshot: snapshot
    });
    // Index still shows it active, so cancel selects it (the stale-index race).
    saveState(repo, {
      config: { stopReviewGate: false },
      jobs: [
        {
          id: jobId,
          status: "running",
          jobClass: "task",
          write: true,
          pid: DEAD_PID,
          agyPid: DEAD_PID,
          workspaceSnapshot: snapshot,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    });

    const result = run("node", [SCRIPT, "cancel", jobId, "--json"], {
      cwd: repo,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    // Non-destructive: the working tree is untouched (no git reset --hard).
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "users-later-work\n",
      "cancel of a stale failed job must not reset the workspace"
    );
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.cancelled, false);
    assert.match(payload.status, /failed/);
    // The report points the user at a manual rollback rather than doing it.
    assert.match(payload.note, /manual|git reset|left untouched/i);
  } finally {
    if (previousData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }
  }
});
