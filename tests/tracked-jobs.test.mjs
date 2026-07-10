import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { runTrackedJob } from "../plugins/antigravity/scripts/lib/tracked-jobs.mjs";
import { listJobs, readJobFile, resolveJobFile } from "../plugins/antigravity/scripts/lib/state.mjs";

const SNAPSHOT = { repoRoot: "/tmp/repo", head: "abc123", stashCommit: "def456", capturedAt: new Date(0).toISOString() };

function makeExecution(exitStatus) {
  return {
    exitStatus,
    threadId: "conv-1",
    turnId: null,
    payload: { ok: exitStatus === 0 },
    rendered: "output\n",
    summary: "summary"
  };
}

/**
 * Run `runTrackedJob` against an isolated CLAUDE_PLUGIN_DATA state dir and
 * return the stored job file + index row afterwards.
 */
async function runScenario(runner) {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("antigravity-plugin-data-");
  const workspaceRoot = makeTempDir("antigravity-ws-");
  const job = { id: `task-test-${Math.random().toString(36).slice(2, 8)}`, workspaceRoot, title: "Test task", jobClass: "task", write: true };

  try {
    let thrown = null;
    try {
      await runTrackedJob(job, runner);
    } catch (error) {
      thrown = error;
    }
    const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
    const indexRow = listJobs(workspaceRoot).find((entry) => entry.id === job.id);
    return { stored, indexRow, thrown };
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

test("runTrackedJob preserves the workspace snapshot when the turn FAILS (rollback metadata must survive)", async () => {
  const { stored, indexRow } = await runScenario(async ({ recordSnapshot }) => {
    recordSnapshot(SNAPSHOT);
    return makeExecution(1);
  });

  assert.equal(stored.status, "failed");
  // Regression (review-escalation P1): a runner-timeout-killed write turn can
  // leave half-applied edits; nulling the snapshot here destroyed the only
  // rollback metadata.
  assert.deepEqual(stored.workspaceSnapshot, SNAPSHOT);
  assert.deepEqual(indexRow.workspaceSnapshot, SNAPSHOT, "index row must stay consistent with the job file");
});

test("runTrackedJob consumes the workspace snapshot on a CLEAN completion (file and index row)", async () => {
  const { stored, indexRow } = await runScenario(async ({ recordSnapshot }) => {
    recordSnapshot(SNAPSHOT);
    return makeExecution(0);
  });

  assert.equal(stored.status, "completed");
  assert.equal(stored.workspaceSnapshot, null);
  // recordSnapshot upserts the snapshot into the index; completion must clear
  // it there too, or a patch-merge retains it forever.
  assert.equal(indexRow.workspaceSnapshot, null);
});

test("runTrackedJob preserves the workspace snapshot when the runner THROWS", async () => {
  const { stored, indexRow, thrown } = await runScenario(async ({ recordSnapshot }) => {
    recordSnapshot(SNAPSHOT);
    throw new Error("boom mid-turn");
  });

  assert.match(thrown.message, /boom mid-turn/);
  assert.equal(stored.status, "failed");
  assert.deepEqual(stored.workspaceSnapshot, SNAPSHOT);
  assert.deepEqual(indexRow.workspaceSnapshot, SNAPSHOT);
});
