/**
 * Reusable O_EXCL file-lock primitive, generalized from the atomic-create
 * pattern in `job-slots.mjs`.
 *
 * A lock is a single file created with `open(path, "wx")` (O_EXCL): exactly
 * one process/thread can win that create, so mutual exclusion holds without a
 * check-then-act window. The winner writes a `{ pid, token, createdAt }`
 * payload after create (`writeSync` -> `closeSync`).
 *
 * Two correctness hazards this module exists to close:
 *
 *  1. `open(wx)` then `writeSync` is NOT atomic as a pair: a peer can observe
 *     the lock file between create and payload-write, when it is still
 *     empty/unparseable. Treating "file exists" as "valid lock" would let a
 *     reader either (a) misjudge ownership, or (b) wrongly reclaim a lock
 *     that is merely mid-create. So: ownership is decided by the `token`
 *     field, never by mere existence; and a reader that sees an empty /
 *     unparseable lock younger than `emptyGraceMs` treats it as "being
 *     created by a live peer" and waits/retries — it does NOT attempt
 *     reclaim.
 *
 *  2. A naive stale-lock reclaim (`read -> decide stale -> unlink`) is a
 *     TOCTOU race: two readers can both decide the same lock is stale and
 *     both proceed to "reclaim" it, briefly letting two holders believe they
 *     hold the same lock. `reclaimStaleEntry` closes this by serializing
 *     reclaim attempts through a short-lived reaper lock (`<path>.reap`,
 *     same O_EXCL primitive) so exactly one process reclaims at a time, and
 *     by using a rename-then-reread-then-verify-token protocol so a reclaim
 *     that raced with a legitimate new holder aborts instead of destroying
 *     the new holder's lock.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const LOCK_POLL_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
/** Empty/unparseable lock younger than this: assume mid-create, wait, never reclaim. */
const DEFAULT_EMPTY_GRACE_MS = 2000;
/** Lock (with a known pid) or an empty lock older than this is reclaim-eligible. */
const DEFAULT_STALE_MS = 10_000;
/** A wedged reaper lock (its owner crashed) older than this is force-cleared. */
const REAP_LOCK_STALE_MS = 15_000;

function makeToken(pid) {
  return `${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Blocking sleep with no async/event-loop dependency, so `withFileLock` stays fully synchronous. */
function sleepSync(ms) {
  if (!(ms > 0)) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without SharedArrayBuffer/Atomics.wait: busy-wait as a fallback.
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // no-op spin
    }
  }
}

export function pidIsAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but not signalable by us -> still alive. ESRCH: gone.
    return error?.code !== "ESRCH";
  }
}

function readRawAndStat(entryPath) {
  const raw = fs.readFileSync(entryPath, "utf8");
  const stat = fs.statSync(entryPath);
  return { raw, stat };
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function acquireReapLock(reapLockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return fs.openSync(reapLockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0) {
        // A wedged reaper lock (its owner crashed mid-reap) would otherwise
        // block reclaim forever. Force-clear it once it is clearly stale.
        try {
          const stat = fs.statSync(reapLockPath);
          if (Date.now() - stat.mtimeMs >= REAP_LOCK_STALE_MS) {
            fs.unlinkSync(reapLockPath);
            continue;
          }
        } catch {
          continue; // vanished or unreadable; just retry the create
        }
      }
      return null; // busy: another reclaimer is active right now
    }
  }
  return null;
}

/**
 * Attempt a TOCTOU-safe stale-entry reclaim for a single O_EXCL-created file
 * at `entryPath` (a lock file or a job-slots slot file). Serializes via a
 * short-lived reaper lock so exactly one reclaimer proceeds; uses a
 * rename -> reread -> verify-content protocol so a reclaim that raced with a
 * legitimate new holder aborts instead of deleting their lock.
 *
 * `isStale(raw, stat)` decides staleness from the entry's raw payload text
 * and its `fs.Stats`; callers supply their own predicate (dead-pid check,
 * empty-past-grace check, or both).
 *
 * Returns `{ reclaimed: boolean, busy?, gone?, aborted? }`. Never throws for
 * expected races (busy reaper lock, entry vanished, token mismatch); other
 * errors (e.g. EACCES) propagate.
 */
export function reclaimStaleEntry(entryPath, { isStale }) {
  const reapLockPath = `${entryPath}.reap`;
  const reapFd = acquireReapLock(reapLockPath);
  if (reapFd == null) {
    return { reclaimed: false, busy: true };
  }

  try {
    fs.writeSync(reapFd, String(process.pid));
  } finally {
    fs.closeSync(reapFd);
  }

  try {
    let current;
    try {
      current = readRawAndStat(entryPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { reclaimed: false, gone: true };
      }
      throw error;
    }

    if (!isStale(current.raw, current.stat)) {
      return { reclaimed: false };
    }

    const deadPath = `${entryPath}.dead.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.renameSync(entryPath, deadPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { reclaimed: false, gone: true };
      }
      throw error;
    }

    let postRaw = null;
    try {
      postRaw = fs.readFileSync(deadPath, "utf8");
    } catch {
      postRaw = null;
    }

    if (postRaw !== current.raw) {
      // Content changed between our pre-check read and the rename: something
      // else touched this entry concurrently. Abort rather than guess; leave
      // the renamed copy in place instead of unlinking anything we are not
      // sure about.
      return { reclaimed: false, aborted: true, deadPath };
    }

    try {
      fs.unlinkSync(deadPath);
    } catch {
      // Already cleaned up by a peer; fine.
    }
    return { reclaimed: true };
  } finally {
    try {
      fs.unlinkSync(reapLockPath);
    } catch {
      // Already gone; fine.
    }
  }
}

function isLockStale(raw, stat, { killImpl, emptyGraceMs, staleAfterMs }) {
  const parsed = parsePayload(raw);
  const ageMs = Date.now() - stat.mtimeMs;
  if (parsed && Number.isFinite(Number(parsed.pid))) {
    // A known, dead pid is a strong/deterministic signal: reclaim immediately.
    return !pidIsAlive(Number(parsed.pid), killImpl);
  }
  // Empty/unparseable: we cannot check pid liveness, so fall back to a pure
  // age threshold. Below the grace window it is presumed mid-create.
  if (ageMs < emptyGraceMs) {
    return false;
  }
  return ageMs >= staleAfterMs;
}

function tryCreateLock(lockPath, pid, token) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid, token, createdAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function makeLockHandle(lockPath, token) {
  let released = false;
  return {
    lockPath,
    token,
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = parsePayload(raw);
        if (parsed?.token === token) {
          fs.unlinkSync(lockPath);
        }
        // else: a reclaimer already reaped and replaced this lock; do not
        // touch whatever the new holder wrote.
      } catch {
        // Already gone; nothing to release.
      }
    }
  };
}

/**
 * Acquire the O_EXCL lock at `lockPath`, blocking (via periodic retry, not
 * async) until it is free or `timeoutMs` elapses. Non-reentrant: calling this
 * again for the same lock while already held by the SAME caller will time out
 * and throw, by design (O_EXCL locks are not reentrant).
 */
export function acquireFileLockSync(lockPath, options = {}) {
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : LOCK_POLL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_ACQUIRE_TIMEOUT_MS;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const emptyGraceMs = Number.isFinite(options.emptyGraceMs) ? options.emptyGraceMs : DEFAULT_EMPTY_GRACE_MS;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : DEFAULT_STALE_MS;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const token = makeToken(pid);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryCreateLock(lockPath, pid, token)) {
      return makeLockHandle(lockPath, token);
    }

    let info = null;
    try {
      info = readRawAndStat(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      // Vanished between our create attempt and this read; loop immediately.
      continue;
    }

    if (isLockStale(info.raw, info.stat, { killImpl, emptyGraceMs, staleAfterMs })) {
      reclaimStaleEntry(lockPath, {
        isStale: (raw, stat) => isLockStale(raw, stat, { killImpl, emptyGraceMs, staleAfterMs })
      });
      // Whatever the outcome (reclaimed / busy / aborted / already gone),
      // loop back around and retry the plain create.
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file lock at ${lockPath} after ${timeoutMs}ms.`);
    }
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Run `fn` while holding the O_EXCL lock at `lockPath`, releasing it
 * afterward even if `fn` throws. `fn` is synchronous: this whole helper is
 * synchronous by design so callers (state.mjs read-modify-write sections)
 * never need to reason about interleaved async work while holding the lock.
 */
export function withFileLock(lockPath, fn, options = {}) {
  const handle = acquireFileLockSync(lockPath, options);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
