#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getAntigravityAvailability } from "./lib/antigravity.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// Timeout cascade for the stop-review gate. Each budget must be strictly
// smaller than the one that would kill it, so the inner layer self-times-out
// (and reaps its child) BEFORE the outer layer kills it — otherwise the outer
// kill leaves the inner child orphaned in the background:
//   inner agy-turn (780s)  <  spawnSync (840s)  <  hook Stop timeout (900s, hooks.json)
// The inner agy-turn budget is handed to the child companion via the
// ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS env var (read by resolveTurnTimeoutMs in
// lib/antigravity.mjs); without it the wrapper keeps its 900s default and
// spawnSync would kill it at 840s first, orphaning the detached `agy`.
const STOP_REVIEW_TURN_TIMEOUT_MS = 13 * 60 * 1000; // 780000
const STOP_REVIEW_SPAWN_TIMEOUT_MS = 14 * 60 * 1000; // 840000
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getAntigravityAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Antigravity is not set up for the review gate.${detail} Run /antigravity:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Antigravity review task returned no final output. Run /antigravity:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Antigravity stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Antigravity review task returned an unexpected answer. Run /antigravity:review --wait manually or bypass the gate."
  };
}

/**
 * `task --json`'s stdout is normally the structured payload (see
 * antigravity-companion.mjs's `executeTaskRun`), which carries a structured
 * `error` ({ code, message }) whenever the turn failed. Prefer that over the
 * raw stdout/stderr dump so a stop-gate outcome is actionable instead of an
 * opaque JSON blob; fall back to the raw dump when stdout is not (or no
 * longer) parseable JSON, or carries no usable error message.
 */
function extractTaskFailure(result) {
  const rawStdout = String(result.stdout ?? "").trim();
  if (rawStdout) {
    try {
      const payload = JSON.parse(rawStdout);
      const message = String(payload?.error?.message ?? "").trim();
      if (message) {
        return { code: payload?.error?.code ?? null, message };
      }
    } catch {
      // stdout was not JSON (or was cut off) — fall through to the raw dump.
    }
  }
  const fallback = String(result.stderr || result.stdout || "").trim();
  return fallback ? { code: null, message: fallback } : null;
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "antigravity-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {}),
    // Shrink the child's internal agy-turn budget below our spawnSync timeout so
    // the wrapper self-times-out and reaps `agy` before spawnSync would kill it
    // (a spawnSync kill of the wrapper orphans the detached `agy`).
    ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS: String(STOP_REVIEW_TURN_TIMEOUT_MS)
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_SPAWN_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Antigravity review task timed out after 14 minutes. Run /antigravity:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const failure = extractTaskFailure(result);
    // Non-retryable quota exhaustion must ALLOW the stop, loudly. Blocking here
    // is an inescapable loop: the block reason cannot be "fixed", every new
    // stop attempt re-runs the gate, fails on the same exhausted quota, and
    // blocks again until the quota window resets (review-escalation P1).
    if (failure?.code === "QUOTA_EXHAUSTED") {
      return {
        ok: true,
        note: `Stop-review gate skipped: ${failure.message} A block could not recover while the quota is exhausted, so the session is allowed to end without the review.`
      };
    }
    return {
      ok: false,
      reason: failure
        ? `The stop-time Antigravity review task failed: ${failure.message}`
        : "The stop-time Antigravity review task failed. Run /antigravity:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Antigravity review task returned invalid JSON. Run /antigravity:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Antigravity task ${runningJob.id} is still running. Check /antigravity:status and use /antigravity:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  // Loop guard: when stop_hook_active is set, this stop attempt is itself the
  // continuation of a PREVIOUS Stop-hook block in the same stop cycle. Running
  // another full review here can loop the gate indefinitely (each block ->
  // continuation -> new review -> block ...), burning an agy turn per lap.
  // One review per stop cycle is the contract; allow this one through.
  if (input.stop_hook_active === true) {
    logNote(
      "Stop-review gate: a prior block already ran this stop cycle (stop_hook_active); allowing the stop without another review."
    );
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(review.note);
  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
