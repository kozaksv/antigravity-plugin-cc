import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  getConfig,
  listJobs,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/antigravity/scripts/lib/state.mjs";
import { acquireFileLockSync, reclaimStaleEntry } from "../plugins/antigravity/scripts/lib/file-lock.mjs";

// Hermetic default: without this, tests that resolve state through the ambient
// environment would write real directories under the developer's
// ~/.local/state (the new non-tmp default). Resolver-specific tests override
// or clear this per-test and restore it afterwards.
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("antigravity-state-tests-data-");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const STATE_MODULE_URL = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
const FILE_LOCK_MODULE_URL = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "file-lock.mjs")).href;

// A pid that is (for all practical purposes) never a live process on this host.
const DEAD_PID = 2147483646;

function nowIso() {
  return new Date().toISOString();
}

/** Run `source` (a CommonJS-style script string) in a real worker thread and resolve with its posted message. */
function runWorker(source, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData });
    worker.once("message", (message) => {
      if (message && typeof message === "object" && message.error) {
        reject(new Error(message.error));
        return;
      }
      resolve(message);
    });
    worker.once("error", reject);
  });
}

/** Delete `filePath` from a separate thread after `delayMs`, without depending on the main thread's event loop. */
function scheduleAsyncFileRemoval(filePath, delayMs) {
  return new Worker(
    `
    const fs = require("node:fs");
    const { workerData } = require("node:worker_threads");
    setTimeout(() => {
      try {
        fs.unlinkSync(workerData.filePath);
      } catch {
        // already gone; fine
      }
    }, workerData.delayMs);
    `,
    { eval: true, workerData: { filePath, delayMs } }
  );
}

const STATE_STRESS_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const mod = await import(workerData.moduleUrl);
    mod.upsertJob(workerData.workspace, {
      id: workerData.id,
      status: "queued",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    parentPort.postMessage("done");
  })().catch((error) => {
    parentPort.postMessage({ error: String((error && error.stack) || error) });
  });
`;

const JOB_STRESS_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const mod = await import(workerData.moduleUrl);
    mod.writeJobFile(workerData.workspace, workerData.id, workerData.payload);
    parentPort.postMessage("done");
  })().catch((error) => {
    parentPort.postMessage({ error: String((error && error.stack) || error) });
  });
`;

const RECLAIM_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const mod = await import(workerData.moduleUrl);
    const result = mod.reclaimStaleEntry(workerData.entryPath, { isStale: () => true });
    parentPort.postMessage(result);
  })().catch((error) => {
    parentPort.postMessage({ error: String((error && error.stack) || error) });
  });
`;

test("resolveStateDir prefers XDG_STATE_HOME, then ~/.local/state — never the prunable tmpdir", () => {
  const workspace = makeTempDir();
  const previous = {
    pluginData: process.env.CLAUDE_PLUGIN_DATA,
    xdgStateHome: process.env.XDG_STATE_HOME,
    home: process.env.HOME
  };
  const xdgDir = makeTempDir("antigravity-xdg-state-");
  const homeDir = makeTempDir("antigravity-home-");

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;

    process.env.XDG_STATE_HOME = xdgDir;
    let stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(xdgDir, "antigravity-companion")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);

    delete process.env.XDG_STATE_HOME;
    process.env.HOME = homeDir;
    stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(homeDir, ".local", "state", "antigravity-companion")), true);
    // Pre-1.0.2 regression guard: state in the world-shared, periodically
    // pruned tmpdir root lost job history and the stopReviewGate toggle.
    // (Compare against the legacy root specifically — the fake HOME above is
    // itself a temp dir, so a bare startsWith(os.tmpdir()) would misfire.)
    assert.equal(stateDir.startsWith(path.join(os.tmpdir(), "antigravity-companion")), false);
  } finally {
    for (const [key, value] of [
      ["CLAUDE_PLUGIN_DATA", previous.pluginData],
      ["XDG_STATE_HOME", previous.xdgStateHome],
      ["HOME", previous.home]
    ]) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("ensureStateDir pins the workspace state dir and jobs dir to 0700", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  for (const dir of [resolveStateDir(workspace), resolveJobsDir(workspace)]) {
    assert.equal(
      fs.statSync(dir).mode & 0o777,
      0o700,
      `${dir} must be owner-only: it holds prompts, results, and the gate config`
    );
  }
});

function seedLegacyState(workspace, contents) {
  const legacyDir = path.join(os.tmpdir(), "antigravity-companion", path.basename(resolveStateDir(workspace)));
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "state.json"), contents, "utf8");
  return legacyDir;
}

test("legacy tmpdir CONFIG (stopReviewGate) is migrated once; legacy job records are not carried", () => {
  const workspace = makeTempDir();
  const legacyDir = seedLegacyState(
    workspace,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [{ id: "job-legacy", status: "running" }]
    })}\n`
  );

  try {
    // First state read of this workspace triggers the one-time migration.
    assert.equal(getConfig(workspace).stopReviewGate, true, "the gate toggle must survive the upgrade");
    // Job records stay behind: a pre-upgrade worker keeps writing them under
    // /tmp with the old state module, so a copied record would freeze as
    // "running" forever with no writer.
    assert.deepEqual(listJobs(workspace), []);
    assert.equal(fs.existsSync(resolveStateFile(workspace)), true);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test("a corrupt legacy state file is not trusted for the gate: defaults win, nothing throws", () => {
  const workspace = makeTempDir();
  const legacyDir = seedLegacyState(workspace, "{ definitely not json");

  try {
    assert.equal(getConfig(workspace).stopReviewGate, false);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

// --- loadState fail-closed -------------------------------------------------

test("loadState returns defaultState only for ENOENT", () => {
  const workspace = makeTempDir();
  assert.deepEqual(loadState(workspace), {
    version: 1,
    config: { stopReviewGate: false },
    jobs: []
  });
});

test("loadState throws on corrupt JSON instead of silently falling back to defaultState", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{not valid json", "utf8");

  assert.throws(() => loadState(workspace));
});

test("loadState propagates non-ENOENT filesystem errors (EACCES) instead of masking them", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root bypasses permission checks");
    return;
  }
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [] }), "utf8");
  fs.chmodSync(stateFile, 0o000);

  try {
    assert.throws(() => loadState(workspace));
  } finally {
    fs.chmodSync(stateFile, 0o600);
  }
});

test("updateState aborts the write when loadState fails on corrupt state.json, leaving the file untouched", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const corrupt = "{not valid json";
  fs.writeFileSync(stateFile, corrupt, "utf8");

  assert.throws(() => updateState(workspace, (state) => {
    state.config.stopReviewGate = true;
  }));

  assert.equal(fs.readFileSync(stateFile, "utf8"), corrupt, "corrupt file must be left exactly as-is");

  const leftovers = fs.readdirSync(path.dirname(stateFile)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no lock/tmp file should be left behind after an aborted write");
});

test("updateState performs its read-modify-write under a single lock acquisition without deadlocking", () => {
  const workspace = makeTempDir();

  const first = updateState(workspace, (state) => {
    state.jobs.push({ id: "job-x", status: "queued", updatedAt: nowIso(), createdAt: nowIso() });
  });
  assert.equal(first.jobs.length, 1);

  // A second call must also succeed promptly: the lock from the first call
  // must have been released, not left held (which would manifest as this
  // call timing out against the lock's own O_EXCL acquisition).
  const second = updateState(workspace, (state) => {
    state.config.stopReviewGate = true;
  });
  assert.equal(second.config.stopReviewGate, true);
  assert.equal(second.jobs.length, 1);
});

// --- writeJobFile CAS: jobs/<id>.json is canonical, terminal is final -----

test("writeJobFile allows a normal non-terminal -> terminal transition", () => {
  const workspace = makeTempDir();
  const jobId = "job-ok-1";
  writeJobFile(workspace, jobId, { id: jobId, status: "running" });
  writeJobFile(workspace, jobId, { id: jobId, status: "completed" });
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "completed");
});

test("writeJobFile allows a repeated write of the SAME terminal status (idempotent)", () => {
  const workspace = makeTempDir();
  const jobId = "job-ok-2";
  writeJobFile(workspace, jobId, { id: jobId, status: "completed", note: "first" });
  writeJobFile(workspace, jobId, { id: jobId, status: "completed", note: "second" });
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).note, "second");
});

test("writeJobFile CAS rejects any status write that would change an already-terminal job's status", () => {
  const workspace = makeTempDir();
  const jobId = "job-terminal-1";
  writeJobFile(workspace, jobId, { id: jobId, status: "failed", errorMessage: "boom" });

  // Neither a different terminal status ...
  writeJobFile(workspace, jobId, { id: jobId, status: "completed" });
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "failed");

  // ... nor a non-terminal status can revive/overwrite it.
  writeJobFile(workspace, jobId, { id: jobId, status: "running" });
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "failed");
});

test("cancel/complete concurrent interleaving: a worker's stale 'completed' write loses to an already-committed 'cancelled'", () => {
  const workspace = makeTempDir();
  const jobId = "job-race-1";

  writeJobFile(workspace, jobId, { id: jobId, status: "running", updatedAt: nowIso() });
  upsertJob(workspace, { id: jobId, status: "running", updatedAt: nowIso() });

  // The worker reads a "running" snapshot and holds onto it (simulating work
  // done between its read and its eventual completion write).
  const workerSnapshot = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(workerSnapshot.status, "running");

  // Meanwhile, cancel wins the race and commits a terminal status FIRST.
  writeJobFile(workspace, jobId, { ...workerSnapshot, status: "cancelled", cancelledAt: nowIso() });
  upsertJob(workspace, { id: jobId, status: "cancelled", cancelledAt: nowIso() });

  // The worker now tries to commit "completed" using its STALE snapshot. Its
  // per-job lock forces a re-read of the canonical status first, so the CAS
  // rejects this write.
  writeJobFile(workspace, jobId, { ...workerSnapshot, status: "completed", completedAt: nowIso() });
  upsertJob(workspace, { id: jobId, status: "completed", completedAt: nowIso() });

  const canonical = readJobFile(resolveJobFile(workspace, jobId));
  assert.equal(canonical.status, "cancelled", "canonical jobs/<id>.json must not regress from a terminal status");

  const derived = listJobs(workspace).find((job) => job.id === jobId);
  assert.equal(derived.status, "cancelled", "state.json's derived status must mirror the canonical file, not the rejected write");
  assert.equal(canonical.status, derived.status, "canonical and derived status must never diverge");
});

test("upsertJob derives a job's status from the canonical jobs/<id>.json file, never diverging from it", () => {
  const workspace = makeTempDir();
  const jobId = "job-derive-1";
  writeJobFile(workspace, jobId, { id: jobId, status: "completed" });

  // Even though the caller-supplied patch claims "running", the canonical
  // file already says "completed" (terminal) — the derived state.json entry
  // must reflect the canonical value, not the patch's own status field.
  upsertJob(workspace, { id: jobId, status: "running", phase: "reviewing" });

  const derived = listJobs(workspace).find((job) => job.id === jobId);
  assert.equal(derived.status, "completed");
});

// --- concurrency stress (real OS threads via worker_threads) --------------

test("15-20 concurrent state.json writers never truncate or lose entries", async () => {
  const workspace = makeTempDir();
  const writerCount = 18;
  const ids = Array.from({ length: writerCount }, (_, index) => `stress-job-${index}`);

  await Promise.all(
    ids.map((id) => runWorker(STATE_STRESS_WORKER_SOURCE, { moduleUrl: STATE_MODULE_URL, workspace, id }))
  );

  const raw = fs.readFileSync(resolveStateFile(workspace), "utf8");
  const parsed = JSON.parse(raw); // throws if the file is truncated/corrupt

  const gotIds = new Set(parsed.jobs.map((job) => job.id));
  for (const id of ids) {
    assert.ok(gotIds.has(id), `missing job ${id} — a concurrent write was lost`);
  }
  assert.equal(parsed.jobs.length, writerCount);
});

test("15-20 concurrent jobs/<id>.json writers never truncate the file and never regress a terminal status", async () => {
  const workspace = makeTempDir();
  const jobId = "stress-job-terminal";
  ensureStateDir(workspace);

  const writerCount = 18;
  const payloads = Array.from({ length: writerCount }, (_, index) =>
    index === writerCount - 1
      ? { id: jobId, status: "completed", seq: index }
      : { id: jobId, status: "running", seq: index, phase: `progress-${index}` }
  );
  // Shuffle so the terminal write is not necessarily scheduled/committed last.
  for (let i = payloads.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [payloads[i], payloads[j]] = [payloads[j], payloads[i]];
  }

  await Promise.all(
    payloads.map((payload) =>
      runWorker(JOB_STRESS_WORKER_SOURCE, { moduleUrl: STATE_MODULE_URL, workspace, id: jobId, payload })
    )
  );

  const raw = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");
  const parsed = JSON.parse(raw); // throws if the file is truncated/corrupt
  assert.equal(parsed.status, "completed", "the one terminal write must win and must never be reverted afterward");
});

// --- file-lock.mjs: stale-lock reclaim protocol ----------------------------

test("acquireFileLockSync reclaims a stale lock held by a dead pid via the reaper+rename protocol", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: "dead-token", createdAt: new Date(0).toISOString() }));

  const handle = acquireFileLockSync(lockPath, { timeoutMs: 2000, pollMs: 50 });
  assert.ok(handle);
  handle.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("acquireFileLockSync does not reclaim a fresh lock held by a live pid", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live-token", createdAt: nowIso() }));

  assert.throws(
    () => acquireFileLockSync(lockPath, { timeoutMs: 250, pollMs: 50 }),
    /Timed out waiting for file lock/
  );

  fs.unlinkSync(lockPath);
});

test("acquireFileLockSync does not reclaim an empty/undecided lock younger than grace; acquires once the peer clears it", async () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  fs.writeFileSync(lockPath, ""); // looks like a peer mid-create
  const remover = scheduleAsyncFileRemoval(lockPath, 150);

  try {
    const handle = acquireFileLockSync(lockPath, {
      timeoutMs: 3000,
      pollMs: 50,
      emptyGraceMs: 2000
    });
    assert.ok(handle, "must eventually acquire after the peer's empty lock clears, not by reclaiming it early");
    handle.release();
  } finally {
    await remover.terminate();
  }
});

test("acquireFileLockSync reclaims an empty lock past the grace window WITHIN the default acquire timeout (no wedge)", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  // A creator that crashed between open(wx) and its payload write: empty file,
  // already older than the grace window (backdate mtime by 5s).
  fs.writeFileSync(lockPath, "");
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(lockPath, past, past);

  // Regression (review escalation P1): with the old "empty is stale only after
  // 10s" dead zone, every waiter with the default 5s timeout starved here.
  const started = Date.now();
  const handle = acquireFileLockSync(lockPath, { pollMs: 25, emptyGraceMs: 2000 });
  const waitedMs = Date.now() - started;
  assert.ok(handle, "expected the crashed creator's empty lock to be reclaimed");
  assert.ok(waitedMs < 4000, `reclaim must beat the default acquire timeout, took ${waitedMs}ms`);
  handle.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("reclaimStaleEntry: concurrent reclaimers racing the same stale entry — exactly one reclaims", async () => {
  const dir = makeTempDir();
  const entryPath = path.join(dir, "x.lock");
  fs.writeFileSync(entryPath, JSON.stringify({ pid: DEAD_PID, token: "t" }));

  const results = await Promise.all(
    Array.from({ length: 6 }, () => runWorker(RECLAIM_WORKER_SOURCE, { moduleUrl: FILE_LOCK_MODULE_URL, entryPath }))
  );

  const reclaimedCount = results.filter((result) => result.reclaimed).length;
  assert.equal(reclaimedCount, 1, "exactly one reclaimer must win the race");
  assert.equal(fs.existsSync(entryPath), false);
});

test("reclaimStaleEntry aborts when the entry's content changes between the staleness pre-check and the rename", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: "t1" }));

  const result = reclaimStaleEntry(lockPath, {
    isStale: () => {
      // Simulate a concurrent external mutation observed between the
      // pre-check read and the rename-based claim.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: "t2" }));
      return true;
    }
  });

  assert.equal(result.reclaimed, false);
  assert.equal(result.aborted, true);
});

// --- writeJobFile CAS return contract (cancel must not lie about the result) ---

test("writeJobFile returns applied:true and the written status on an accepted write", () => {
  const workspace = makeTempDir();
  const jobId = "job-cas-applied";
  const result = writeJobFile(workspace, jobId, { id: jobId, status: "running" });
  assert.equal(result.applied, true);
  assert.equal(result.canonicalStatus, "running");
  assert.ok(result.jobFile.endsWith(`${jobId}.json`));
});

test("writeJobFile returns applied:false and the winning terminal status when the CAS rejects", () => {
  const workspace = makeTempDir();
  const jobId = "job-cas-rejected";
  // A worker committed `completed` first ...
  writeJobFile(workspace, jobId, { id: jobId, status: "completed" });
  // ... then a racing cancel tries to write `cancelled`: the CAS rejects it,
  // and the return must surface that so /antigravity:cancel reports the truth
  // instead of a clean cancellation (review escalation P2).
  const result = writeJobFile(workspace, jobId, { id: jobId, status: "cancelled" });
  assert.equal(result.applied, false);
  assert.equal(result.canonicalStatus, "completed");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "completed");
});

// --- legacy migration: only ENOENT means "no legacy state" ---

test("an unreadable (non-ENOENT) legacy state file does not strand the gate: it is retried, not skipped", () => {
  const workspace = makeTempDir();
  const legacyDir = seedLegacyState(
    workspace,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] })}\n`
  );
  const legacyFile = path.join(legacyDir, "state.json");

  // Make the legacy file unreadable (EACCES). Skip on platforms/users where
  // chmod 000 does not actually deny read (e.g. running as root in CI).
  fs.chmodSync(legacyFile, 0o000);
  let deniedRead = false;
  try {
    fs.readFileSync(legacyFile, "utf8");
  } catch (error) {
    deniedRead = error?.code === "EACCES" || error?.code === "EPERM";
  }

  try {
    if (!deniedRead) {
      return; // environment cannot simulate the read failure; nothing to assert
    }

    // While unreadable, migration must NOT silently mark the workspace fresh
    // (which would let a later write disable the gate). getConfig sees defaults
    // for now, but the legacy file is left pending, not consumed.
    assert.equal(getConfig(workspace).stopReviewGate, false);
    assert.equal(fs.existsSync(resolveStateFile(workspace)), false, "no fresh state may be written over a pending migration");

    // Once the file becomes readable again, the retried migration recovers the gate.
    fs.chmodSync(legacyFile, 0o600);
    assert.equal(getConfig(workspace).stopReviewGate, true);
  } finally {
    fs.chmodSync(legacyFile, 0o600);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

// --- file-lock link-trick: the canonical lock is never observed empty ---

test("acquireFileLockSync publishes a fully-written lock (never an empty canonical file)", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  const handle = acquireFileLockSync(lockPath, { pid: 4242 });
  // The instant the canonical lock exists it already carries its payload — the
  // link-trick leaves no empty/partial window (review escalation P1).
  const raw = fs.readFileSync(lockPath, "utf8");
  assert.ok(raw.trim().length > 0, "canonical lock must never be empty");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.token, handle.token);
  // No stray `.mk` temp file is left behind in the lock directory.
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".mk")), false);
  handle.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("acquireFileLockSync still mutually excludes a live holder after the link-trick change", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  const held = acquireFileLockSync(lockPath, { pid: process.pid });
  // A second acquisition against a live holder must block and time out.
  assert.throws(
    () => acquireFileLockSync(lockPath, { timeoutMs: 250, pollMs: 50 }),
    /Timed out waiting for file lock/
  );
  held.release();
});

// --- migration: a write during an unreadable-legacy outage must NOT strand the gate ---

test("a state WRITE while the legacy file is unreadable is refused, not allowed to mask the gate", () => {
  const workspace = makeTempDir();
  const legacyDir = seedLegacyState(
    workspace,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] })}\n`
  );
  const legacyFile = path.join(legacyDir, "state.json");

  fs.chmodSync(legacyFile, 0o000);
  let deniedRead = false;
  try {
    fs.readFileSync(legacyFile, "utf8");
  } catch (error) {
    deniedRead = error?.code === "EACCES" || error?.code === "EPERM";
  }

  try {
    if (!deniedRead) {
      return; // environment cannot simulate the read failure (e.g. root); skip
    }

    // A write (setConfig/upsertJob) while migration cannot read the legacy file
    // must THROW rather than create a fresh new-root state.json — that fresh
    // file would permanently mask the enabled gate on every later check
    // (review escalation P2).
    assert.throws(() => setConfig(workspace, "someKey", true), /unreadable|Refusing to initialize state/i);
    assert.equal(fs.existsSync(resolveStateFile(workspace)), false, "no fresh state may be written over a pending migration");

    // Once the legacy file is readable again, the write succeeds and the gate migrates.
    fs.chmodSync(legacyFile, 0o600);
    setConfig(workspace, "someKey", true);
    assert.equal(getConfig(workspace).stopReviewGate, true, "the enabled gate must survive the recovered migration");
  } finally {
    fs.chmodSync(legacyFile, 0o600);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

// --- file-lock: the private .mk temp is never leaked ---

test("acquireFileLockSync leaves no .mk temp files when a contended acquire fails to link", () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "x.lock");
  const held = acquireFileLockSync(lockPath, { pid: process.pid });

  // A second acquire against the live holder repeatedly hits the link-EEXIST
  // path and must clean up its temp file on every attempt.
  assert.throws(
    () => acquireFileLockSync(lockPath, { timeoutMs: 300, pollMs: 40 }),
    /Timed out waiting for file lock/
  );

  const leaked = fs.readdirSync(dir).filter((name) => name.includes(".mk"));
  assert.deepEqual(leaked, [], `no .mk temp files may leak, found: ${leaked.join(", ")}`);
  held.release();
});
