import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "ANTIGRAVITY_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[antigravity] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    // The actual detached `agy` child pid, recorded once it spawns. Cancel must
    // kill this (the real agy process tree), not just the Node wrapper `pid`.
    agyPid: null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  // Persist the real `agy` child pid as soon as the runtime spawns it, so an
  // out-of-process `/antigravity:cancel` can read it from the job file and kill
  // the detached agy process tree.
  const recordAgyPid = (agyPid) => {
    if (!Number.isFinite(agyPid)) {
      return;
    }
    runningRecord.agyPid = agyPid;
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, { ...stored, agyPid });
    upsertJob(job.workspaceRoot, { id: job.id, agyPid });
  };

  // Persist the pre-run git snapshot for write tasks, so an out-of-process
  // `/antigravity:cancel` can roll back a half-applied patch left by a killed
  // write turn. Stored before `agy` spawns so it is always available on cancel.
  const recordSnapshot = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    runningRecord.workspaceSnapshot = snapshot;
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, { ...stored, workspaceSnapshot: snapshot });
    upsertJob(job.workspaceRoot, { id: job.id, workspaceSnapshot: snapshot });
  };

  try {
    const execution = await runner({ recordAgyPid, recordSnapshot });
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    // A clean completion has no half-applied patch to roll back, so the
    // snapshot is consumed. A FAILED turn (e.g. the runner timeout killed a
    // write turn mid-edit) can leave partial edits in the tree — nulling the
    // snapshot there would destroy the only rollback metadata the user has
    // (review-escalation P1), so it is preserved on the record instead.
    const keptSnapshot = completionStatus === "completed" ? null : runningRecord.workspaceSnapshot ?? null;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      agyPid: null,
      workspaceSnapshot: keptSnapshot,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      agyPid: null,
      // Keep the index row consistent with the job file: recordSnapshot upserts
      // the snapshot into the index, so completion must clear (or carry) it
      // explicitly — a patch-merge would otherwise retain it forever.
      workspaceSnapshot: keptSnapshot,
      completedAt
    });
    if (keptSnapshot) {
      appendLogLine(
        options.logFile ?? job.logFile ?? null,
        `Turn failed with a pre-run snapshot on record; the turn may have left partial edits (rollback head ${keptSnapshot.head ?? "unknown"}).`
      );
    }
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    // Same preservation rule as the failed-completion path above: the error may
    // have interrupted a write turn after `agy` already touched files, so the
    // rollback metadata must survive on the failed record.
    const keptSnapshot = existing.workspaceSnapshot ?? runningRecord.workspaceSnapshot ?? null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      agyPid: null,
      workspaceSnapshot: keptSnapshot,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      agyPid: null,
      workspaceSnapshot: keptSnapshot,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
