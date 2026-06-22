import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");

const {
  tryAcquireSlot,
  acquireSlot,
  countActiveSlots,
  resolveSlotDir,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS
} = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "job-slots.mjs"));

function freshWorkspace() {
  const root = makeTempDir("antigravity-slots-ws-");
  const dataDir = makeTempDir("antigravity-slots-data-");
  // state.mjs keys the slot dir off CLAUDE_PLUGIN_DATA, so isolate it per test.
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return root;
}

/**
 * A `kill(pid, 0)` stub that reports a fixed set of pids as alive. Tests use
 * synthetic holder pids (not real processes), so without this the liveness
 * reaper would treat them as dead and free their slots.
 */
function aliveKill(...alivePids) {
  const set = new Set(alivePids);
  return (target, signal) => {
    if (signal === 0) {
      if (set.has(target)) {
        return true;
      }
      const error = new Error("ESRCH");
      error.code = "ESRCH";
      throw error;
    }
    return true;
  };
}

test("default cap serializes same-workspace background jobs to one slot", () => {
  const cwd = freshWorkspace();
  assert.equal(DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS, 1);
  const killImpl = aliveKill(111, 222);

  const first = tryAcquireSlot(cwd, { pid: 111, killImpl });
  assert.ok(first, "first job should acquire the only slot");
  assert.equal(countActiveSlots(cwd, { killImpl }), 1);

  // A second job with a DIFFERENT (live) pid cannot get a slot at cap 1.
  const second = tryAcquireSlot(cwd, { pid: 222, killImpl });
  assert.equal(second, null, "second job must wait while the slot is held");

  first.release();
  assert.equal(countActiveSlots(cwd, { killImpl }), 0);

  // After release, the next job can claim the freed slot.
  const third = tryAcquireSlot(cwd, { pid: 222, killImpl });
  assert.ok(third);
  third.release();
});

test("a higher cap admits multiple concurrent holders", () => {
  const cwd = freshWorkspace();
  const killImpl = aliveKill(201, 202, 203);
  const a = tryAcquireSlot(cwd, { pid: 201, maxConcurrent: 2, killImpl });
  const b = tryAcquireSlot(cwd, { pid: 202, maxConcurrent: 2, killImpl });
  assert.ok(a && b, "two jobs fit under cap 2");
  const c = tryAcquireSlot(cwd, { pid: 203, maxConcurrent: 2, killImpl });
  assert.equal(c, null, "the third job is over cap 2");
  a.release();
  b.release();
});

test("a dead holder's slot is reclaimed so a crashed worker never wedges the queue", () => {
  const cwd = freshWorkspace();
  const slotDir = resolveSlotDir(cwd);
  fs.mkdirSync(slotDir, { recursive: true });
  // Simulate a crashed worker that left a slot file for a pid that is gone.
  // pid 2^31-1 is effectively never a live process.
  const deadPid = 2147483646;
  fs.writeFileSync(path.join(slotDir, "slot-0.slot"), JSON.stringify({ pid: deadPid }));

  // The reaper treats the dead holder as free, so a new job can still acquire.
  const handle = tryAcquireSlot(cwd, { pid: process.pid });
  assert.ok(handle, "dead holder must be reclaimed");
  assert.equal(countActiveSlots(cwd), 1);
  handle.release();
});

test("acquireSlot waits for a freed slot and then claims it", async () => {
  const cwd = freshWorkspace();
  const held = tryAcquireSlot(cwd, { pid: process.pid });
  assert.ok(held);

  // Release the slot shortly after starting the async acquire.
  setTimeout(() => held.release(), 100);

  const acquired = await acquireSlot(cwd, { pid: 999, pollMs: 50, timeoutMs: 5000 });
  assert.ok(acquired, "acquireSlot should eventually get the freed slot");
  acquired.release();
});

test("acquireSlot times out instead of hanging forever on a wedged queue", async () => {
  const cwd = freshWorkspace();
  const held = tryAcquireSlot(cwd, { pid: process.pid });
  assert.ok(held);
  await assert.rejects(
    () => acquireSlot(cwd, { pid: 888, pollMs: 50, timeoutMs: 200 }),
    /Timed out waiting for a free Antigravity job slot/
  );
  held.release();
});

test("acquisition is atomic: a fixed slot name is won by exactly one worker", () => {
  const cwd = freshWorkspace();
  const killImpl = aliveKill(111, 222, 333);
  // Two workers race for the only slot (cap 1). Whoever wins `slot-0` via the
  // atomic O_EXCL create holds it; the other gets null. There is no listing /
  // sort step that could let both conclude they won. (Regression: web-review
  // finding #1 — check-then-act break in the prior register-then-sort design.)
  const a = tryAcquireSlot(cwd, { pid: 111, killImpl });
  const b = tryAcquireSlot(cwd, { pid: 222, killImpl });
  assert.ok(a, "first worker wins the slot");
  assert.equal(b, null, "second worker cannot also win the same fixed slot");
  const slots = fs.readdirSync(resolveSlotDir(cwd)).filter((f) => f.endsWith(".slot"));
  assert.deepEqual(slots, ["slot-0.slot"], "exactly one slot file exists");
  assert.equal(countActiveSlots(cwd, { killImpl }), 1);
  a.release();
});

test("a freshly created empty slot is treated as in-flight, not reaped", () => {
  const cwd = freshWorkspace();
  const slotDir = resolveSlotDir(cwd);
  fs.mkdirSync(slotDir, { recursive: true });
  // A peer that just did open(wx) but has not written its pid yet looks like an
  // empty slot. The reaper must NOT free it, or two workers could share a slot.
  // (Regression: half-written-slot race.)
  fs.writeFileSync(path.join(slotDir, "slot-0.slot"), "");
  const blocked = tryAcquireSlot(cwd, { pid: 111 });
  assert.equal(blocked, null, "a fresh empty (in-flight) slot must count as held");
  assert.equal(countActiveSlots(cwd), 1);
});

test("a stale empty orphan slot is reclaimed once past the in-flight grace", () => {
  const cwd = freshWorkspace();
  const slotDir = resolveSlotDir(cwd);
  fs.mkdirSync(slotDir, { recursive: true });
  // An empty slot whose creator died between open and write: past the grace it
  // is an orphan and must be reclaimed so it does not wedge the queue forever.
  fs.writeFileSync(path.join(slotDir, "slot-0.slot"), "");
  const handle = tryAcquireSlot(cwd, { pid: 111, inflightGraceMs: 0 });
  assert.ok(handle, "a stale empty orphan must be reclaimed");
  assert.equal(countActiveSlots(cwd, { killImpl: aliveKill(111) }), 1);
  handle.release();
});
