import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  // SECURITY: with `shell:true`, Windows joins the argv into a single command
  // line and re-parses it through cmd.exe, so ANY argument containing shell
  // metacharacters (e.g. a crafted git base-ref like `main & calc.exe`) would
  // execute arbitrary commands. Standard binaries (git.exe, node.exe,
  // taskkill.exe) run fine WITHOUT a shell, so we never enable one for them.
  // The Windows shell is strictly opt-in per call (`options.windowsShell`) and
  // only used for `.cmd`/`.bat` shims (npm, agy) that Node cannot spawn
  // otherwise — and only ever with fixed, non-user arguments (see
  // `binaryAvailable`'s version probes). It must never be turned on for any
  // command that carries caller/user-controlled input.
  const useShell = process.platform === "win32" && options.windowsShell === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: useShell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  // Availability probes run a FIXED version flag with no caller/user input, so
  // it is safe to let them use the Windows shell — that is what lets `.cmd`
  // shims (npm, agy) resolve on Windows, where a bare spawn would ENOENT.
  const result = runCommand(command, versionArgs, {
    windowsShell: true,
    ...options
  });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/** Default grace period between SIGTERM and the SIGKILL escalation. */
export const DEFAULT_TERMINATION_GRACE_MS = 5000;

/**
 * Block the current thread for `ms` without an event-loop turn.
 *
 * Cancellation paths (`/antigravity:cancel`, the session-end hook) terminate a
 * process and then immediately exit, so an async/unref'd timer would never fire
 * and the SIGKILL escalation would be lost. A synchronous wait guarantees the
 * grace period elapses before the process exits. We use `Atomics.wait` on a
 * throwaway buffer (no busy spin) and fall back to a coarse spin only if it is
 * unavailable.
 */
function sleepSyncMs(ms) {
  if (!(ms > 0)) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Coarse fallback wait; only reached when Atomics.wait is unavailable.
    }
  }
}

/**
 * Is `pid` (or its process group, when `negate` is set) still alive?
 *
 * `kill(pid, 0)` delivers no signal but performs the existence/permission check:
 * it throws `ESRCH` when the target is gone and `EPERM` when it exists but we
 * cannot signal it (still "alive" for our purposes).
 */
function processIsAlive(killImpl, pid, negate) {
  try {
    killImpl(negate ? -pid : pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    // EPERM (or anything else): the target still exists.
    return true;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    // `taskkill /T /F` already terminates the whole tree forcefully, so there is
    // no SIGTERM/SIGKILL escalation to stage on Windows.
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  // POSIX: documented contract is SIGTERM -> grace -> SIGKILL (README:193,
  // docs/agy-cli.md). `agy` may spawn tool subprocesses, so we signal the whole
  // process group when the child was detached into its own group; if the group
  // is gone we fall back to the bare pid.
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_TERMINATION_GRACE_MS;
  const sleepImpl = options.sleepImpl ?? sleepSyncMs;
  const escalate = options.escalate !== false;
  // Callers that own their own async escalation (the in-process runner timeout)
  // pass `escalate:false` and may send SIGKILL directly on the second pass.
  const firstSignal = options.signalOverride ?? "SIGTERM";

  const sigterm = deliverSignal(killImpl, pid, firstSignal);
  if (!sigterm.delivered) {
    // Nothing alive to signal (ESRCH on both group and pid).
    return { attempted: true, delivered: false, method: sigterm.method, escalated: false };
  }

  if (!escalate) {
    return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
  }

  // Give the process the grace window to exit on its own after SIGTERM, then, if
  // it is still alive, force-kill it (and its group). Cancellation callers exit
  // right after this returns, so the wait MUST be synchronous (see sleepSyncMs).
  // Poll liveness in small slices so we return promptly when SIGTERM works (the
  // common case) instead of always blocking the full grace period.
  const negate = sigterm.method === "process-group";
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 50;
  let waited = 0;
  while (waited < graceMs) {
    if (!processIsAlive(killImpl, pid, negate)) {
      return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
    }
    const slice = Math.min(pollMs, graceMs - waited);
    sleepImpl(slice);
    waited += slice;
  }

  if (!processIsAlive(killImpl, pid, negate)) {
    return { attempted: true, delivered: true, method: sigterm.method, escalated: false };
  }

  const sigkill = deliverSignal(killImpl, pid, "SIGKILL");
  return {
    attempted: true,
    delivered: sigkill.delivered || sigterm.delivered,
    method: sigkill.method ?? sigterm.method,
    escalated: true
  };
}

/**
 * Send `signal` to a POSIX process group first, falling back to the bare pid.
 * Returns whether the signal reached anything and which target form was used.
 */
function deliverSignal(killImpl, pid, signal) {
  try {
    killImpl(-pid, signal);
    return { delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      // Group already gone; the lone process may still be alive under its own id.
      try {
        killImpl(pid, signal);
        return { delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
    // EPERM or similar: the group exists but we could not signal it as a group.
    try {
      killImpl(pid, signal);
      return { delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
