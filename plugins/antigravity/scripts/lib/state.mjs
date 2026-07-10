import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { withFileLock } from "./file-lock.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "antigravity-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function resolveStateLockFile(cwd) {
  return `${resolveStateFile(cwd)}.lock`;
}

function resolveJobLockFile(cwd, jobId) {
  return `${resolveJobFile(cwd, jobId)}.lock`;
}

/**
 * Serialize `contents` to `<filePath>.<pid>.<random>.tmp` in the SAME
 * directory as `filePath`, then `renameSync` it over the target. `rename` on
 * the same filesystem is atomic, so readers never observe a partially
 * written file (the historical failure mode of a direct `writeFileSync` into
 * the target path).
 */
function atomicWriteFileSync(filePath, contents) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tmpPath, contents, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

/**
 * Fail-closed: `defaultState()` is returned ONLY when the state file simply
 * does not exist yet (ENOENT). Any other read/parse failure (corrupt JSON,
 * EACCES, EIO, EMFILE, ...) is thrown, not swallowed — silently falling back
 * to a fresh default state on a corrupt/unreadable file would let a
 * subsequent write clobber data that might still be recoverable, and would
 * hide the underlying problem from the caller.
 */
export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }

  const parsed = JSON.parse(raw);
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

/**
 * Is `targetPath` strictly inside `parentDir` (not the dir itself, not an
 * escaping `..` traversal)? Resolved lexically via `path.relative`, so a
 * `logFile`/`id` smuggled in via a pre-seeded `state.json` (its directory is
 * world-writable by default on multi-user systems) cannot point the pruner at
 * a path outside the plugin's own jobs directory.
 */
function isPathWithinDir(parentDir, targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return false;
  }
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Delete `filePath` during job pruning ONLY when it resolves inside
 * `allowedDir`. `filePath` (a job's `logFile`, or a per-job file whose name is
 * derived from an attacker-influenced `id`) originates from `state.json`, which
 * is not trusted: refuse to unlink anything outside the jobs directory so a
 * poisoned state file cannot turn pruning into arbitrary file deletion.
 */
function removeFileWithinIfExists(allowedDir, filePath) {
  if (!isPathWithinDir(allowedDir, filePath)) {
    return; // outside the plugin's own jobs dir: never delete it
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Write `state` to disk. MUST be called with the `state.lock` already held
 * by the caller (`saveState` / `updateState`) — this function never acquires
 * a lock itself, so it can be reused as the body of a read-modify-write
 * section without the O_EXCL lock (which is not reentrant) ever nesting
 * inside itself.
 */
function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const jobsDir = resolveJobsDir(cwd);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    // Both targets are gated to the jobs dir: `job.id` composes the per-job
    // file name (a traversal id like `../../x` would otherwise escape) and
    // `job.logFile` is an unverified absolute path straight from state.json.
    removeFileWithinIfExists(jobsDir, resolveJobFile(cwd, job.id));
    removeFileWithinIfExists(jobsDir, job.logFile);
  }

  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

/** Public single-shot write: takes `state.lock` exactly once around the write. */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  return withFileLock(resolveStateLockFile(cwd), () => saveStateUnlocked(cwd, state));
}

/**
 * Read-modify-write `state.json` entirely under ONE `state.lock` acquisition:
 * `loadState` (fail-closed — throws on non-ENOENT errors, aborting the write
 * before `mutate`/`saveStateUnlocked` ever run) -> `mutate` ->
 * `saveStateUnlocked` (no lock of its own). The lock is taken once here and
 * never re-entered, since the O_EXCL primitive is not reentrant.
 */
export function updateState(cwd, mutate) {
  ensureStateDir(cwd);
  return withFileLock(resolveStateLockFile(cwd), () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/**
 * `jobs/<id>.json` is the single canonical source of a job's status (see
 * `writeJobFile`'s CAS below). `state.json`'s per-job `status` field is
 * derived, never authoritative: whenever a patch touches `status`, this
 * overrides it with whatever is currently canonical on disk so `state.json`
 * can never "outrun" or diverge from `jobs/<id>.json` — including the case
 * where the patch's own `status` value came from a stale in-memory snapshot
 * that a concurrent writer has since superseded (e.g. a worker's `completed`
 * patch racing a `cancel`'s already-committed `cancelled` canonical file).
 */
function deriveJobStatusFromCanonical(cwd, jobPatch) {
  if (!Object.prototype.hasOwnProperty.call(jobPatch, "status")) {
    return jobPatch;
  }
  const canonical = readCanonicalJobOrNull(cwd, jobPatch.id);
  if (!canonical || typeof canonical.status !== "string" || canonical.status === jobPatch.status) {
    return jobPatch;
  }
  return { ...jobPatch, status: canonical.status };
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const patch = deriveJobStatusFromCanonical(cwd, jobPatch);
    const existingIndex = state.jobs.findIndex((job) => job.id === patch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...patch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...patch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

const TERMINAL_JOB_STATUSES = new Set(["cancelled", "completed", "failed"]);

function readCanonicalJobOrNull(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  let raw;
  try {
    raw = fs.readFileSync(jobFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(raw);
}

/**
 * `jobs/<jobId>.json` is the single canonical source of truth for job
 * status (see module notes). Every write goes through the per-job lock and
 * re-reads the canonical status under that SAME lock before deciding: once a
 * job has reached a terminal status (`cancelled` | `completed` | `failed`),
 * no further write may change its status — not to a different terminal
 * status (`completed` must never overwrite `cancelled`) and not back to a
 * non-terminal one. This is what makes a racing writer that computed its
 * patch from a stale ("running") snapshot safe: by the time it acquires the
 * lock it re-reads the CURRENT canonical status, not the snapshot it read
 * earlier.
 *
 * A rejected write is a silent no-op (the file on disk is left exactly as
 * it was) rather than a thrown error, matching every existing call site's
 * fire-and-forget usage of `writeJobFile`.
 */
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  withFileLock(resolveJobLockFile(cwd, jobId), () => {
    const current = readCanonicalJobOrNull(cwd, jobId);
    if (current && TERMINAL_JOB_STATUSES.has(current.status) && payload.status !== current.status) {
      return; // CAS reject: terminal status is final.
    }
    atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  });
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
