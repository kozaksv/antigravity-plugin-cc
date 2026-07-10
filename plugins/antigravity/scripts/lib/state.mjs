import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { withFileLock } from "./file-lock.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_ROOT_BASENAME = "antigravity-companion";
/**
 * Pre-1.0.2 state root. `os.tmpdir()` is periodically pruned (macOS clears
 * entries unused for ~3 days, every reboot clears it elsewhere) and is
 * world-shared on multi-user hosts. Retained only as (a) the migration SOURCE
 * for the one-time config carry-over below and (b) the absolute last-resort
 * root when no home directory is resolvable at all.
 */
const LEGACY_STATE_ROOT_DIR = path.join(os.tmpdir(), STATE_ROOT_BASENAME);
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
/** State holds prompts, results, and the review-gate config: owner-only. */
const STATE_DIR_MODE = 0o700;

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

/**
 * State root resolution (first match wins):
 *  1. `$CLAUDE_PLUGIN_DATA/state` — explicit override.
 *  2. `$XDG_STATE_HOME/antigravity-companion` — XDG state dir, when absolute.
 *  3. `~/.local/state/antigravity-companion` — the XDG default.
 *  4. `<tmpdir>/antigravity-companion` — last resort (no resolvable home).
 * Before 1.0.2 the root was ALWAYS (4); losing /tmp meant silently losing job
 * history AND the `stopReviewGate` toggle after a reboot or tmp sweep.
 */
function resolveStateRootDir(env = process.env) {
  const pluginDataDir = env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    return path.join(pluginDataDir, "state");
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  if (xdgStateHome && path.isAbsolute(xdgStateHome)) {
    return path.join(xdgStateHome, STATE_ROOT_BASENAME);
  }
  const home = env.HOME || os.homedir();
  if (home) {
    return path.join(home, ".local", "state", STATE_ROOT_BASENAME);
  }
  return LEGACY_STATE_ROOT_DIR;
}

/** Per-workspace state directory name: `<basename-slug>-<canonical-path-hash>`. */
function stateDirName(cwd) {
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
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd) {
  return path.join(resolveStateRootDir(), stateDirName(cwd));
}

/** Where this workspace's state file lived before 1.0.2 (tmpdir root). */
function resolveLegacyStateFile(cwd) {
  return path.join(LEGACY_STATE_ROOT_DIR, stateDirName(cwd), STATE_FILE_NAME);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true, mode: STATE_DIR_MODE });
  // `mkdirSync`'s mode is umask-filtered and is not reliably applied to every
  // intermediate component of a recursive create — the workspace-slug dir that
  // holds `state.json` (prompts, results, gate config) could end up 0755 on a
  // multi-user host. Pin both plugin-owned levels to 0700 explicitly; best
  // effort so a foreign/pre-existing dir we cannot chmod never breaks state IO.
  for (const dir of [stateDir, jobsDir]) {
    try {
      fs.chmodSync(dir, STATE_DIR_MODE);
    } catch {
      // not ours to chmod; leave as-is
    }
  }
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
 *
 * This unlocked variant is what every section that ALREADY holds `state.lock`
 * must use (the lock is not reentrant); the public `loadState` additionally
 * runs the one-time legacy-config migration, which takes that lock itself.
 */
function loadStateUnlocked(cwd) {
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

export function loadState(cwd) {
  migrateLegacyConfigIfNeeded(cwd);
  return loadStateUnlocked(cwd);
}

/** State dirs whose legacy-migration check already ran in this process. */
const migrationCheckedStateDirs = new Set();

/**
 * One-time, config-only migration from the pre-1.0.2 tmpdir state root.
 *
 * Deliberately narrow (review escalation, 2026-07-10):
 *  - CONFIG ONLY (`stopReviewGate` etc.) — the security-relevant bit that must
 *    not silently reset to "gate off" on upgrade. Job records are NOT carried:
 *    a still-running pre-upgrade worker keeps writing its job under /tmp with
 *    the OLD state module, so a copied record would freeze as "running"
 *    forever in the new root with no writer ever updating it.
 *  - Runs entirely OUTSIDE any held `state.lock` (public entry points call it
 *    BEFORE locking; locked sections use `loadStateUnlocked`), and takes the
 *    lock itself only for the actual write, re-checking that no peer created
 *    the new state file in the meantime.
 *  - A corrupt legacy file cannot be trusted for a security toggle: warn
 *    loudly on stderr (naming the gate) instead of guessing, then proceed
 *    with defaults.
 */
function migrateLegacyConfigIfNeeded(cwd) {
  const stateDir = resolveStateDir(cwd);
  if (migrationCheckedStateDirs.has(stateDir)) {
    return;
  }

  const stateFile = resolveStateFile(cwd);
  const legacyFile = resolveLegacyStateFile(cwd);
  if (stateFile === legacyFile || fs.existsSync(stateFile)) {
    migrationCheckedStateDirs.add(stateDir);
    return; // already on the legacy root (nothing to migrate to), or migrated
  }

  let raw;
  try {
    raw = fs.readFileSync(legacyFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      migrationCheckedStateDirs.add(stateDir); // definitively no legacy state
      return; // fresh workspace
    }
    // The legacy file EXISTS but is unreadable right now (EACCES, EIO, EMFILE,
    // ...). Treating that as "no legacy state" would let a later job write
    // create fresh default state in the new root, permanently stranding an
    // enabled stopReviewGate (fail-open on a security toggle). Do NOT mark this
    // dir checked — so the next state access retries the migration — and warn
    // instead of silently continuing (review escalation P2).
    process.stderr.write(
      `[antigravity] Could not read legacy state at ${legacyFile} ` +
        `(${error?.code ?? (error instanceof Error ? error.message : String(error))}); not migrating this run. ` +
        "If the stop-review gate was enabled, it may be inactive until this is resolved.\n"
    );
    return;
  }
  // From here the read succeeded: whatever the outcome, this dir is resolved.
  migrationCheckedStateDirs.add(stateDir);

  let legacyConfig;
  try {
    const parsed = JSON.parse(raw);
    legacyConfig = parsed && typeof parsed === "object" ? parsed.config : null;
  } catch {
    process.stderr.write(
      `[antigravity] Legacy state at ${legacyFile} is corrupt; starting fresh. ` +
        "If the stop-review gate was enabled there, re-enable it with `/antigravity:setup --enable-review-gate`.\n"
    );
    return;
  }
  if (!legacyConfig || typeof legacyConfig !== "object") {
    return;
  }

  ensureStateDir(cwd);
  withFileLock(resolveStateLockFile(cwd), () => {
    if (fs.existsSync(stateFile)) {
      return; // a peer migrated (or wrote fresh state) while we read the legacy file
    }
    saveStateUnlocked(cwd, {
      ...defaultState(),
      config: {
        ...defaultState().config,
        ...legacyConfig
      }
    });
  });
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
 * A job id COMPOSES a per-job file path (`jobs/<id>.json`, `jobs/<id>.log`), so
 * it must be a single safe path segment. Any path separator, `.`, or `..` would
 * let a poisoned `state.json` (its directory is world-writable by default on
 * multi-user systems) compose a path that leaves the jobs dir — e.g. an id like
 * `link/target` combined with a pre-planted symlink `jobs/link -> /victim` would
 * turn pruning into arbitrary file deletion via that symlinked component. Refuse
 * anything that is not a conservative `[A-Za-z0-9._-]` basename.
 */
const SAFE_JOB_ID = /^[A-Za-z0-9._-]+$/;
function isSafeJobId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 200 &&
    id !== "." &&
    id !== ".." &&
    SAFE_JOB_ID.test(id)
  );
}

/**
 * Delete `filePath` during job pruning ONLY when it resolves inside
 * `allowedDir`. `filePath` (a job's `logFile`, or a per-job file whose name is
 * derived from an attacker-influenced `id`) originates from `state.json`, which
 * is not trusted: refuse to unlink anything outside the jobs directory so a
 * poisoned state file cannot turn pruning into arbitrary file deletion.
 *
 * Lexical containment (`path.relative`) alone is NOT sufficient: a symlinked
 * component planted inside the jobs dir (`jobs/link -> /victim`) passes the
 * lexical check yet redirects the `unlinkSync` outside the dir. So additionally
 * resolve the REAL parent directory and require the target to be a DIRECT child
 * of the REAL jobs dir, and to be a regular file (never a symlink/dir) — this
 * closes the symlink-traversal deletion vector while still deleting every
 * legitimate `jobs/<id>.json` / `jobs/<id>.log` (both are always direct file
 * children of the jobs dir).
 */
function removeFileWithinIfExists(allowedDir, filePath) {
  if (!isPathWithinDir(allowedDir, filePath)) {
    return; // outside the plugin's own jobs dir (lexically): never delete it
  }
  let realAllowedDir;
  let realParent;
  try {
    realAllowedDir = fs.realpathSync(allowedDir);
    realParent = fs.realpathSync(path.dirname(filePath));
  } catch {
    return; // unresolvable (missing dir / broken symlink): nothing safe to delete
  }
  if (realParent !== realAllowedDir) {
    return; // parent escaped the jobs dir through a symlinked component
  }
  let entryStat;
  try {
    entryStat = fs.lstatSync(filePath);
  } catch {
    return; // already gone
  }
  if (!entryStat.isFile()) {
    return; // symlink/dir/other: refuse — unlinking could be redirected elsewhere
  }
  fs.unlinkSync(filePath);
}

/**
 * Write `state` to disk. MUST be called with the `state.lock` already held
 * by the caller (`saveState` / `updateState`) — this function never acquires
 * a lock itself, so it can be reused as the body of a read-modify-write
 * section without the O_EXCL lock (which is not reentrant) ever nesting
 * inside itself.
 */
function saveStateUnlocked(cwd, state) {
  const previousJobs = loadStateUnlocked(cwd).jobs;
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
    // `job.id` composes the per-job file name: only compose+delete it when the
    // id is a safe basename, so a traversal/symlink id (`../../x`, `link/target`)
    // is never turned into a path in the first place. `job.logFile` is an
    // unverified absolute path straight from state.json. Both deletions are then
    // re-validated by `removeFileWithinIfExists` against the REAL jobs dir.
    if (isSafeJobId(job.id)) {
      removeFileWithinIfExists(jobsDir, resolveJobFile(cwd, job.id));
    }
    removeFileWithinIfExists(jobsDir, job.logFile);
  }

  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

/** Public single-shot write: takes `state.lock` exactly once around the write. */
export function saveState(cwd, state) {
  migrateLegacyConfigIfNeeded(cwd);
  ensureStateDir(cwd);
  return withFileLock(resolveStateLockFile(cwd), () => saveStateUnlocked(cwd, state));
}

/**
 * Read-modify-write `state.json` entirely under ONE `state.lock` acquisition:
 * `loadStateUnlocked` (fail-closed — throws on non-ENOENT errors, aborting
 * the write before `mutate`/`saveStateUnlocked` ever run) -> `mutate` ->
 * `saveStateUnlocked` (no lock of its own). The lock is taken once here and
 * never re-entered, since the O_EXCL primitive is not reentrant; that is also
 * why the legacy migration runs BEFORE the lock, never inside it.
 */
export function updateState(cwd, mutate) {
  migrateLegacyConfigIfNeeded(cwd);
  ensureStateDir(cwd);
  return withFileLock(resolveStateLockFile(cwd), () => {
    const state = loadStateUnlocked(cwd);
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
 * A rejected write is a no-op on disk (the file is left exactly as it was)
 * rather than a thrown error, matching every existing call site's
 * fire-and-forget usage. The RETURN value now reports the outcome
 * (`{ jobFile, applied, canonicalStatus }`) so a caller that must not lie
 * about the result — e.g. `/antigravity:cancel`, which would otherwise report
 * a clean cancellation even when a worker had already committed `completed`
 * and the CAS rejected the `cancelled` write — can react to a rejection.
 */
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  let applied = true;
  let canonicalStatus = payload.status ?? null;
  withFileLock(resolveJobLockFile(cwd, jobId), () => {
    const current = readCanonicalJobOrNull(cwd, jobId);
    if (current && TERMINAL_JOB_STATUSES.has(current.status) && payload.status !== current.status) {
      applied = false;
      canonicalStatus = current.status; // the terminal status that won
      return; // CAS reject: terminal status is final.
    }
    atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  });
  return { jobFile, applied, canonicalStatus };
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
