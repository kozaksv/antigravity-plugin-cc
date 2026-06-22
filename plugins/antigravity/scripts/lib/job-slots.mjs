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
 * workspace state dir. A worker acquires a slot (creating an exclusive
 * `<pid>.slot` file) before it spawns `agy`, and releases it after. Capacity 1
 * (the default) fully serializes same-workspace background jobs, which is what
 * removes the `last_conversations.json` race; a higher cap simply bounds
 * resource use. Holders whose pid is dead are reclaimed so a crashed worker
 * never wedges the queue.
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
 * Reclaim slot files whose owner pid is dead and return the live holder count.
 */
function reapDeadSlots(slotDir, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  let live = 0;
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
    let ownerPid = Number.NaN;
    try {
      ownerPid = Number(JSON.parse(fs.readFileSync(slotPath, "utf8")).pid);
    } catch {
      ownerPid = Number.NaN;
    }
    if (pidIsAlive(ownerPid, killImpl)) {
      live += 1;
    } else {
      try {
        fs.unlinkSync(slotPath);
      } catch {
        // Another worker may have reclaimed it first; ignore.
      }
    }
  }
  return live;
}

/** Count currently-held (live) slots for the workspace. */
export function countActiveSlots(cwd, options = {}) {
  const slotDir = resolveSlotDir(cwd);
  if (!fs.existsSync(slotDir)) {
    return 0;
  }
  return reapDeadSlots(slotDir, options);
}

/**
 * Try to claim a slot without waiting. Returns a release handle, or null when
 * the workspace is already at capacity.
 */
export function tryAcquireSlot(cwd, options = {}) {
  const maxConcurrent = Number.isFinite(options.maxConcurrent)
    ? Math.max(1, options.maxConcurrent)
    : DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS;
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid;
  const slotDir = ensureSlotDir(cwd);

  // Reap dead holders first so a crashed worker never permanently blocks a slot.
  const live = reapDeadSlots(slotDir, options);
  if (live >= maxConcurrent) {
    return null;
  }

  const slotPath = path.join(slotDir, `${pid}${SLOT_SUFFIX}`);
  try {
    // Exclusive create: two workers racing for the last slot cannot both win the
    // same file name (different pids -> different names), and re-claiming our own
    // pid's slot is idempotent enough for our single-acquire-per-worker usage.
    const handle = fs.openSync(slotPath, "wx");
    fs.writeFileSync(handle, JSON.stringify({ pid, claimedAt: new Date().toISOString() }));
    fs.closeSync(handle);
  } catch (error) {
    if (error?.code === "EEXIST") {
      // Our pid already holds a slot; treat as acquired (idempotent).
    } else {
      throw error;
    }
  }

  let released = false;
  return {
    pid,
    slotPath,
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        fs.unlinkSync(slotPath);
      } catch {
        // Already gone (reaped or released); nothing to do.
      }
    }
  };
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
