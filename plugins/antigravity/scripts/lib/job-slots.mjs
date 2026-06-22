/**
 * Per-workspace concurrency slots for background `agy` jobs.
 *
 * `agy` has no shared runtime to serialize through, so each background job is a
 * detached worker that spawns its own `agy -p` process. Two background jobs that
 * share a workspace cwd both read/write `~/.gemini/antigravity-cli/cache/
 * last_conversations.json[cwd]`, so running them in parallel races on that
 * mapping and can persist the WRONG conversation id for a job (see
 * docs/agy-cli.md "Concurrency"). It also lets unbounded background jobs spawn
 * unbounded full Go processes (~70MB+ each).
 *
 * This module is a counting semaphore backed by a slot directory under the
 * workspace state dir. Capacity 1 (the default) fully serializes same-workspace
 * background jobs, which removes the `last_conversations.json` race; a higher
 * cap simply bounds resource use.
 *
 * Mutual exclusion is provided by ATOMIC exclusive file creation, not by listing
 * the directory and reasoning about who "won". The slots are a FIXED set of
 * names `slot-0.slot` ... `slot-(N-1).slot`; a worker acquires by walking the
 * indices and `open(..., "wx")` (O_EXCL) on each until one create succeeds. Only
 * one process can ever win a given name, so two workers racing for the last slot
 * cannot both succeed — there is no check-then-act window. This is the standard
 * race-free file-lock primitive; an earlier "register then sort the directory"
 * design was rejected because the read-after-register is not atomic (a worker
 * that lists the dir before a peer's slot is visible can wrongly conclude it
 * won). The owner pid is stored INSIDE the slot purely so a crashed worker's
 * slot can be reclaimed; it is never used to decide who holds the lock.
 *
 * Known residual limitations (acceptable here; the slot dir is process-local):
 *  - PID reuse: if a holder crashes and the OS recycles its pid to an unrelated
 *    live process, reaping sees the pid as alive and the slot stays held until a
 *    stale-grace reclaim or manual release. Jobs are short-lived and same-host,
 *    so this is unlikely; a UUID owner token would be the full fix.
 *  - Network filesystems: O_EXCL create and rename are not reliably atomic
 *    across NFS clients. The workspace state dir is local, so this does not
 *    apply; do not relocate it onto network storage without revisiting this.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveStateDir } from "./state.mjs";

/**
 * Default concurrent background jobs per workspace. 1 serializes same-cwd jobs
 * so they cannot race on the cwd -> conversation cache. Override per call/env
 * for workspaces that isolate cwds another way.
 */
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS = 1;
const SLOT_DIR_NAME = "slots";
const SLOT_SUFFIX = ".slot";
/**
 * Grace before an UNPARSEABLE slot file is treated as an orphan and reclaimed.
 * A slot is created empty by `open(wx)` and its pid payload is written a beat
 * later; within this window an empty slot is assumed in-flight (a peer is
 * mid-create) and is NOT reaped, which closes the half-written-slot race. Past
 * the window an empty slot means the creator died between open and write, so it
 * is reclaimed.
 */
const DEFAULT_INFLIGHT_GRACE_MS = 30_000;

export function resolveSlotDir(cwd) {
  return path.join(resolveStateDir(cwd), SLOT_DIR_NAME);
}

function ensureSlotDir(cwd) {
  const dir = resolveSlotDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pidIsAlive(pid, killImpl) {
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

/**
 * Reclaim slot files whose owner pid is dead (or whose empty payload is past the
 * in-flight grace) and return the count of slots still held. Never reaps a slot
 * that is merely mid-create.
 */
function reapDeadSlots(slotDir, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const graceMs = Number.isFinite(options.inflightGraceMs)
    ? options.inflightGraceMs
    : DEFAULT_INFLIGHT_GRACE_MS;
  let held = 0;
  let entries;
  try {
    entries = fs.readdirSync(slotDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(SLOT_SUFFIX)) {
      continue;
    }
    const slotPath = path.join(slotDir, entry);
    let raw;
    try {
      raw = fs.readFileSync(slotPath, "utf8");
    } catch {
      // Vanished under us (reaped/released by a peer); nothing to count.
      continue;
    }

    let ownerPid = Number.NaN;
    if (raw.trim()) {
      try {
        ownerPid = Number(JSON.parse(raw).pid);
      } catch {
        ownerPid = Number.NaN;
      }
    }

    if (Number.isFinite(ownerPid)) {
      if (pidIsAlive(ownerPid, killImpl)) {
        held += 1;
      } else {
        unlinkQuietly(slotPath);
      }
      continue;
    }

    // Empty / unparseable: a slot mid-create looks like this for a beat. Keep it
    // while fresh (assume a peer is writing its pid); reclaim once it is stale.
    if (isFresh(slotPath, graceMs)) {
      held += 1;
    } else {
      unlinkQuietly(slotPath);
    }
  }
  return held;
}

function isFresh(slotPath, graceMs) {
  try {
    return Date.now() - fs.statSync(slotPath).mtimeMs < graceMs;
  } catch {
    return false;
  }
}

function unlinkQuietly(slotPath) {
  try {
    fs.unlinkSync(slotPath);
  } catch {
    // Another worker may have reclaimed/released it first; ignore.
  }
}

/** Count currently-held slots for the workspace (reaping dead holders first). */
export function countActiveSlots(cwd, options = {}) {
  const slotDir = resolveSlotDir(cwd);
  if (!fs.existsSync(slotDir)) {
    return 0;
  }
  return reapDeadSlots(slotDir, options);
}

function makeReleaseHandle(pid, slotPath) {
  let released = false;
  return {
    pid,
    slotPath,
    release() {
      if (released) {
        return;
      }
      released = true;
      unlinkQuietly(slotPath);
    }
  };
}

/**
 * Try to claim a slot without waiting. Returns a release handle, or null when
 * every slot up to `maxConcurrent` is already held. Acquisition is atomic: the
 * first worker to `open(slot-i, "wx")` wins slot i; racing peers get EEXIST and
 * fall through to the next index (or null when the cap is reached).
 */
export function tryAcquireSlot(cwd, options = {}) {
  const maxConcurrent = Number.isFinite(options.maxConcurrent)
    ? Math.max(1, options.maxConcurrent)
    : DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS;
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid;
  const slotDir = ensureSlotDir(cwd);

  // Reap dead holders first so a crashed worker never permanently blocks a slot.
  reapDeadSlots(slotDir, options);

  for (let index = 0; index < maxConcurrent; index += 1) {
    const slotPath = path.join(slotDir, `slot-${index}${SLOT_SUFFIX}`);
    let handle;
    try {
      // Atomic exclusive create: exactly one worker can win this name. No
      // check-then-act window, so mutual exclusion holds even under a same-
      // millisecond race for the final slot.
      handle = fs.openSync(slotPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        continue; // held by someone else (or in-flight); try the next index
      }
      throw error;
    }
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid, claimedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(handle);
    }
    return makeReleaseHandle(pid, slotPath);
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait (async) until a slot is free, then claim it. Polls at `pollMs`; gives up
 * after `timeoutMs` and throws so a wedged queue surfaces instead of hanging
 * forever.
 */
export async function acquireSlot(cwd, options = {}) {
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(50, options.pollMs) : 500;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const handle = tryAcquireSlot(cwd, options);
    if (handle) {
      return handle;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for a free Antigravity job slot in ${cwd} after ${timeoutMs}ms.`
      );
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
