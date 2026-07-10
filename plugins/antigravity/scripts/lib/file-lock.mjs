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
 *     the new holder's lock. A wedged reaper (its owner crashed mid-reap) is
 *     itself force-cleared only via a token-verified rename CAS (never a bare
 *     stat-then-unlink, which would let two racers both clear+recreate the
 *     reaper and both enter the serialized section).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const LOCK_POLL_MS = 50;
/**
 * Default wait for a contended lock. Sized for the worst REALISTIC pile-up,
 * with headroom: state.json writers hold the lock across a full
 * read-prune-write cycle, which on a slow filesystem (network-synced checkout,
 * saturated disk) can take low hundreds of ms — a burst of a dozen writers
 * (background worker progress, cancel, session teardown, tests) can therefore
 * legitimately queue for several seconds. 5s proved too tight exactly there
 * (stress runs on a Dropbox-synced checkout timed out spuriously); 10s keeps
 * interactive paths bounded while eliminating that false-contention failure.
 * Must stay comfortably ABOVE DEFAULT_EMPTY_GRACE_MS so a crashed creator's
 * empty lock is always reclaimable within one waiter's patience.
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
/**
 * Empty/unparseable lock younger than this: assume mid-create, wait, never
 * reclaim. PAST this grace an empty lock can only be a creator that died (or
 * failed) between `open(wx)` and its payload write — there is no pid to probe,
 * so it is reclaimed IMMEDIATELY. This threshold must stay well below
 * DEFAULT_ACQUIRE_TIMEOUT_MS: an earlier design kept empty locks in a
 * "not fresh but not yet stale" dead zone LONGER than the acquire timeout,
 * so every waiter timed out before the crashed creator's lock ever became
 * reclaimable — a self-sustaining wedge (review escalation P1).
 */
const DEFAULT_EMPTY_GRACE_MS = 2000;
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

/**
 * Is the reaper lock currently occupying `reapLockPath` wedged (its owner
 * crashed mid-reap) and therefore safe to force-clear? A reaper whose recorded
 * owner pid is still alive is NEVER wedged, regardless of age — its owner is
 * genuinely reaping right now and must not be stolen. Only a dead-owner or an
 * empty/unparseable reaper past the stale-age threshold is reclaimable.
 */
function reapLockIsWedged(raw, stat, killImpl) {
  const parsed = parsePayload(raw);
  if (parsed && Number.isFinite(Number(parsed.pid))) {
    return !pidIsAlive(Number(parsed.pid), killImpl);
  }
  // Empty/unparseable (a live peer mid-create, or a legacy pid-only reaper):
  // no pid to probe, so fall back to a pure age threshold. A freshly created
  // reaper is recent and thus presumed a live peer's — never force-cleared.
  return Date.now() - stat.mtimeMs >= REAP_LOCK_STALE_MS;
}

/**
 * Force-clear a wedged reaper lock via a TOKEN-VERIFIED rename CAS.
 *
 * The bug this replaces: `stat -> unconditional unlink` lets two racers both
 * observe the same stale reaper, both unlink+recreate it, and both fall through
 * into the supposedly serialized reclaim section — breaking mutual exclusion.
 *
 * `renameSync` of the shared reaper path is atomic: exactly ONE racer can move
 * a given reaper aside; every other racer observes ENOENT and simply retries
 * the plain O_EXCL create (which, again, only one racer can win). After winning
 * the rename we re-read the moved file and verify its token matches the wedged
 * reaper we inspected — if a racing reclaimer recreated a FRESH reaper in the
 * gap between our inspection and our rename, the token mismatches and we restore
 * it rather than stranding its live owner.
 *
 * Returns true if the caller should retry its create (reaper cleared or already
 * gone), false if the reaper is not clearable (a live/fresh reaper is held).
 */
function clearWedgedReapLock(reapLockPath, killImpl) {
  let inspected;
  try {
    inspected = readRawAndStat(reapLockPath);
  } catch {
    return true; // vanished/unreadable between EEXIST and here; retry the create
  }
  if (!reapLockIsWedged(inspected.raw, inspected.stat, killImpl)) {
    return false; // a live/fresh reaper: another reclaimer is genuinely active
  }

  const claimedPath = `${reapLockPath}.wedged.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(reapLockPath, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true; // another racer already moved it; retry the create
    }
    throw error;
  }

  let claimedRaw = null;
  try {
    claimedRaw = fs.readFileSync(claimedPath, "utf8");
  } catch {
    claimedRaw = null;
  }
  if (claimedRaw === inspected.raw) {
    // We moved the exact wedged reaper we verified; drop it and let the caller
    // race the fresh create.
    try {
      fs.unlinkSync(claimedPath);
    } catch {
      // Already cleaned up by a peer; fine.
    }
    return true;
  }

  // Token mismatch: we displaced a reaper that a racing reclaimer recreated
  // after our inspection. Put it back so its owner still holds it, and back off.
  try {
    fs.renameSync(claimedPath, reapLockPath);
  } catch {
    try {
      fs.unlinkSync(claimedPath);
    } catch {
      // best effort
    }
  }
  return false;
}

/**
 * Acquire the reaper lock at `reapLockPath` (O_EXCL) so exactly one reclaimer
 * proceeds. Writes a `{ pid, token }` payload so the token can be verified on
 * release (and by `clearWedgedReapLock`). Returns the token on success, or null
 * when another reclaimer holds a live/fresh reaper (caller must back off).
 */
function acquireReapLock(reapLockPath, killImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(reapLockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && clearWedgedReapLock(reapLockPath, killImpl)) {
        continue; // cleared (or vanished); retry the create
      }
      return null; // busy: another reclaimer is active right now
    }
    const token = makeToken(process.pid);
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    } catch (error) {
      // Same ENOSPC hazard as tryCreateLock: never leave an empty reaper behind.
      try {
        fs.unlinkSync(reapLockPath);
      } catch {
        // best effort
      }
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    return token;
  }
  return null;
}

/** Release a held reaper lock, but only if it still carries OUR token — never
 * unlink a reaper a force-clear/recreate handed to a different holder. */
function releaseReapLock(reapLockPath, token) {
  try {
    const parsed = parsePayload(fs.readFileSync(reapLockPath, "utf8"));
    if (parsed?.token === token) {
      fs.unlinkSync(reapLockPath);
    }
  } catch {
    // Already gone; fine.
  }
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
export function reclaimStaleEntry(entryPath, { isStale, killImpl = process.kill.bind(process) } = {}) {
  const reapLockPath = `${entryPath}.reap`;
  const reapToken = acquireReapLock(reapLockPath, killImpl);
  if (reapToken == null) {
    return { reclaimed: false, busy: true };
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
      // Content changed between our pre-check read and the rename: the entry was
      // NOT actually stale (typically a mid-create holder that finished writing
      // its payload in the gap between our read and our rename). We have already
      // moved that live holder's lock file aside — and leaving `entryPath`
      // ABSENT would let a fresh `tryCreateLock` (O_EXCL) win it WHILE the
      // original holder still lives (its fd points at the moved inode), i.e. two
      // concurrent holders and broken mutual exclusion. Restore the lock to its
      // canonical path so exactly one holder remains visible. Use `link`+`unlink`
      // (never `rename`, which clobbers): on `EEXIST` a racer already created a
      // fresh lock at `entryPath` in the gap, so drop our now-superseded copy
      // rather than smash the live one.
      try {
        fs.linkSync(deadPath, entryPath);
        fs.unlinkSync(deadPath);
      } catch (restoreError) {
        if (restoreError?.code === "EEXIST") {
          try {
            fs.unlinkSync(deadPath);
          } catch {
            // best effort
          }
        } else {
          throw restoreError;
        }
      }
      return { reclaimed: false, aborted: true };
    }

    try {
      fs.unlinkSync(deadPath);
    } catch {
      // Already cleaned up by a peer; fine.
    }
    return { reclaimed: true };
  } finally {
    releaseReapLock(reapLockPath, reapToken);
  }
}

function isLockStale(raw, stat, { killImpl, emptyGraceMs }) {
  const parsed = parsePayload(raw);
  if (parsed && Number.isFinite(Number(parsed.pid))) {
    // A known, dead pid is a strong/deterministic signal: reclaim immediately.
    return !pidIsAlive(Number(parsed.pid), killImpl);
  }
  // Empty/unparseable: no pid to probe. Within the grace window it is presumed
  // a live peer mid-create; past it the creator is dead (crashed/failed between
  // open and payload write) and the lock is reclaimed right away — any longer
  // threshold here must never exceed the acquire timeout, or waiters would all
  // time out before the lock ever becomes reclaimable.
  return Date.now() - stat.mtimeMs >= emptyGraceMs;
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
  } catch (error) {
    // Payload write failed (e.g. ENOSPC): without cleanup this leaves an empty
    // lock that blocks every peer for the whole empty-grace window even though
    // no one holds it. Best-effort unlink, then surface the original error.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
    throw error;
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

    if (isLockStale(info.raw, info.stat, { killImpl, emptyGraceMs })) {
      const outcome = reclaimStaleEntry(lockPath, {
        isStale: (raw, stat) => isLockStale(raw, stat, { killImpl, emptyGraceMs }),
        killImpl
      });
      // Only a successful reclaim (or an entry that vanished) actually frees the
      // path, so only those justify retrying the create IMMEDIATELY. A `busy`
      // reaper lock or an `aborted` content-mismatch means the lock is still
      // held — fall through to the deadline check and the `sleepSync` poll
      // backoff below. `continue`-ing unconditionally here (the previous
      // behavior) skipped BOTH the timeout check and the poll delay, so under
      // sustained contention (a busy reaper or a repeatedly-aborting reclaim)
      // this spun at 100% CPU and could bypass `timeoutMs` indefinitely.
      if (outcome.reclaimed || outcome.gone) {
        continue;
      }
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
