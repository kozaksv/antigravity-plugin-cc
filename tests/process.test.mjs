import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree, terminateProcessTrees } from "../plugins/antigravity/scripts/lib/process.mjs";

/**
 * Build a fake `process.kill` that reports a target as alive until a chosen
 * signal lands, recording every (target, signal) pair. `kill(pid, 0)` is the
 * liveness probe: it throws ESRCH once the process is considered dead.
 */
function makeKillStub({ aliveUntilSignal = null } = {}) {
  const calls = [];
  let dead = false;
  return {
    calls,
    kill(target, signal) {
      calls.push({ target, signal });
      if (signal === 0) {
        if (dead) {
          const error = new Error("ESRCH");
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }
      if (aliveUntilSignal && signal === aliveUntilSignal) {
        dead = true;
      }
      return true;
    }
  };
}

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree escalates SIGTERM -> grace -> SIGKILL when the process ignores SIGTERM", () => {
  const stub = makeKillStub({ aliveUntilSignal: "SIGKILL" });
  let totalWaited = 0;

  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl: stub.kill,
    graceMs: 5000,
    pollMs: 500,
    sleepImpl(ms) {
      totalWaited += ms;
    }
  });

  // It must wait the full grace period (in slices), then escalate to SIGKILL.
  assert.equal(totalWaited, 5000);
  assert.equal(outcome.escalated, true);
  assert.equal(outcome.delivered, true);

  const signals = stub.calls.map((call) => call.signal);
  assert.ok(signals.includes("SIGTERM"), "expected a SIGTERM");
  assert.ok(signals.includes("SIGKILL"), "expected a SIGKILL escalation");
  // SIGTERM must precede SIGKILL.
  assert.ok(signals.indexOf("SIGTERM") < signals.indexOf("SIGKILL"));
});

test("terminateProcessTree does not escalate when SIGTERM stops the process within grace", () => {
  const stub = makeKillStub({ aliveUntilSignal: "SIGTERM" });
  let waited = false;

  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl: stub.kill,
    sleepImpl() {
      waited = true;
    }
  });

  // The process died right after SIGTERM, so the liveness probe short-circuits
  // before the grace wait and no SIGKILL is sent.
  assert.equal(outcome.escalated, false);
  assert.equal(waited, false);
  const signals = stub.calls.map((call) => call.signal);
  assert.ok(signals.includes("SIGTERM"));
  assert.equal(signals.includes("SIGKILL"), false);
});

test("terminateProcessTree honors escalate:false for async-managed callers", () => {
  const stub = makeKillStub();
  let waited = false;

  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl: stub.kill,
    escalate: false,
    sleepImpl() {
      waited = true;
    }
  });

  // escalate:false sends a single signal and returns immediately (the in-process
  // runner schedules its own async SIGKILL), so there is no synchronous grace
  // wait and no SIGKILL here.
  assert.equal(outcome.escalated, false);
  assert.equal(waited, false);
  const signals = stub.calls.map((call) => call.signal);
  assert.deepEqual(
    signals.filter((signal) => signal !== 0),
    ["SIGTERM"]
  );
});

test("terminateProcessTree can send SIGKILL directly via signalOverride", () => {
  const stub = makeKillStub();
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl: stub.kill,
    escalate: false,
    signalOverride: "SIGKILL"
  });

  assert.equal(outcome.delivered, true);
  const signals = stub.calls.map((call) => call.signal).filter((signal) => signal !== 0);
  assert.deepEqual(signals, ["SIGKILL"]);
});

// --- terminateProcessTrees: allStopped reflects whether every target was signalable ---

test("terminateProcessTrees reports allStopped=true when every target terminates without throwing", () => {
  const seen = [];
  const { allStopped } = terminateProcessTrees([101, 102, 103], {
    terminate: (pid) => seen.push(pid)
  });
  assert.equal(allStopped, true);
  assert.deepEqual(seen, [101, 102, 103]);
});

test("terminateProcessTrees reports allStopped=false and calls onError when a target's kill throws", () => {
  // A throw means the signal could NOT be delivered (EPERM) — the target may
  // still be a live agy editing the tree, so cancel must NOT then roll back or
  // write a terminal status (review escalation P1).
  const errors = [];
  const { allStopped } = terminateProcessTrees([201, 202], {
    terminate: (pid) => {
      if (pid === 202) {
        const err = new Error("operation not permitted");
        err.code = "EPERM";
        throw err;
      }
    },
    onError: (pid, error) => errors.push([pid, error.code])
  });
  assert.equal(allStopped, false);
  assert.deepEqual(errors, [[202, "EPERM"]]);
});

test("terminateProcessTrees on an empty target list is a no-op with allStopped=true", () => {
  let called = false;
  const { allStopped } = terminateProcessTrees([], { terminate: () => (called = true) });
  assert.equal(allStopped, true);
  assert.equal(called, false);
});
