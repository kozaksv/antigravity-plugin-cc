#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getAntigravityAuthStatus,
    getAntigravityAvailability,
    getSessionRuntimeStatus,
    interruptTurn,
    parseStructuredOutput,
    readOutputSchema,
    resolveModelWithEffort,
    runReview,
    runTurn
  } from "./lib/antigravity.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { validateAgainstSchema } from "./lib/schema-validate.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
  restoreWorkspaceSnapshot,
  snapshotWorkspace
} from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTrees } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { acquireSlot } from "./lib/job-slots.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// `agy` encodes reasoning effort in the model LABEL suffix ("Gemini 3.5 Flash
// (High)"), not in a separate flag, so only the three suffix levels exist.
// Earlier versions also accepted none|minimal|xhigh and then silently dropped
// the whole flag — a no-op dressed up as a feature.
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/antigravity-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/antigravity-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/antigravity-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/antigravity-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/antigravity-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/antigravity-companion.mjs result [job-id] [--json]",
      "  node scripts/antigravity-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high ` +
        "(agy encodes effort in the model label suffix, e.g. \"Gemini 3.5 Flash (High)\")."
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const antigravityStatus = getAntigravityAvailability(cwd);
  const authStatus = await getAntigravityAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!antigravityStatus.available) {
    nextSteps.push("Install Antigravity with `curl -fsSL https://antigravity.google/cli/install.sh | bash`.");
  }
  if (antigravityStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `agy` interactively and sign in with your Google account.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/antigravity:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && antigravityStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    antigravity: antigravityStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const schema = readOutputSchema(REVIEW_SCHEMA);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: JSON.stringify(schema, null, 2)
  });
}

/**
 * Validate a parsed review turn's output against the review-output schema.
 * A turn that itself failed (non-zero status, or JSON that did not even
 * parse) is treated as invalid with a descriptive error, never as "valid".
 */
function validateReviewTurnOutput(turnResult, parsed) {
  if (turnResult.status !== 0) {
    return { valid: false, errors: [turnResult.error?.message ?? "The Antigravity turn failed."] };
  }
  if (!parsed.parsed) {
    return { valid: false, errors: [parsed.parseError ?? "Output was not valid JSON."] };
  }
  return validateAgainstSchema(parsed.parsed, readOutputSchema(REVIEW_SCHEMA));
}

/**
 * Run the adversarial-review turn with fail-closed structured-output
 * validation.
 *
 * Fail-closed contract: any output that does not fully validate against
 * `schemas/review-output.schema.json` is treated as a review ERROR, never as
 * a silent success/approve.
 *
 * Deliberately NO automatic repair turn: a repair would have to resume the
 * original conversation, but the conversation id comes from agy's shared
 * cwd -> conversation cache (`last_conversations.json`), which a concurrent
 * same-repo turn can repoint between the two calls. A repair landing in the
 * wrong conversation could return a schema-valid but ungrounded `approve`,
 * silently defeating the fail-closed contract (review escalation, 2026-07-10).
 * Rerunning the review command is the safe retry.
 */
async function runAdversarialReviewTurn(context, focusText, request) {
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runTurn(context.repoRoot, {
    prompt,
    model: request.model,
    // Read-only review turn: run under agy's own `--sandbox` terminal
    // restrictions (see buildAgyArgs; ANTIGRAVITY_COMPANION_NO_SANDBOX=1 opts out).
    sandbox: true,
    // Adversarial review instructs `agy` to run read-only git inspection
    // commands (self-collect), which would block on permission prompts headless.
    skipPermissions: true,
    onProgress: request.onProgress,
    onSpawn: request.onAgyPid
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  return { result, parsed, validation: validateReviewTurnOutput(result, parsed) };
}

function buildNativeReviewPrompt(context) {
  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureAntigravityAvailable(cwd) {
  const availability = getAntigravityAvailability(cwd);
  if (!availability.available) {
    throw new Error("Antigravity CLI (`agy`) is not installed. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then rerun `/antigravity:setup`.");
  }
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/antigravity:review\` does not support custom focus text. Retry with \`/antigravity:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  if (target.mode !== "working-tree" && target.mode !== "branch") {
    throw new Error("This `/antigravity:review` target is not supported. Retry with `/antigravity:adversarial-review` for custom targeting.");
  }

  return target;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  // `options.timeoutMs` legitimately can be 0 (an immediate, no-wait snapshot
  // via `--timeout-ms 0`). `Number(...) || DEFAULT` treats 0 as falsy and
  // silently replaces it with the 240s default, making an explicit 0 timeout
  // impossible. Only fall back to the default when timeoutMs is unset or does
  // not parse to a finite number at all.
  const parsedTimeoutMs = Number(options.timeoutMs);
  const timeoutMs =
    options.timeoutMs != null && Number.isFinite(parsedTimeoutMs)
      ? Math.max(0, parsedTimeoutMs)
      : DEFAULT_STATUS_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /antigravity:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureAntigravityAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    validateNativeReviewRequest(target, focusText);
    const context = collectReviewContext(request.cwd, target);
    const prompt = buildNativeReviewPrompt(context);
    const result = await runReview(context.repoRoot, {
      prompt,
      model: request.model,
      onProgress: request.onProgress,
      onSpawn: request.onAgyPid
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      antigravity: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary,
        error: result.error ?? null
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr,
        error: result.error
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, firstMeaningfulLine(result.error?.message, `${reviewName} completed.`)),
      jobTitle: `Antigravity ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const outcome = await runAdversarialReviewTurn(context, focusText, request);
  const { result, parsed, validation } = outcome;
  const validationFailed = !validation.valid;

  // Fail-closed: an output that does not fully validate against the review
  // schema is NEVER surfaced as `parsed`/a success — it is folded into a
  // parse-error-shaped result so both the JSON payload and the rendered text
  // read as an explicit review error, not a silent (and possibly unfounded)
  // approve.
  const effectiveParsed = validationFailed
    ? {
        ...parsed,
        parsed: null,
        parseError: parsed.parseError ?? `Schema validation failed: ${validation.errors.join("; ")}`
      }
    : parsed;

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    antigravity: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: validationFailed ? null : parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: effectiveParsed.parseError,
    validationErrors: validationFailed ? validation.errors : [],
    reasoningSummary: result.reasoningSummary
  };

  // A turn that succeeded (agy exit 0) but whose JSON failed schema
  // validation must still fail the command: `result.status` alone is not
  // fail-closed (agy can exit 0 with schema-invalid or unfounded-approve
  // content), so validity gates the exit status too.
  const exitStatus = result.status !== 0 ? result.status : validationFailed ? 1 : 0;

  return {
    exitStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(effectiveParsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: validationFailed
      ? effectiveParsed.parseError
      : parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Antigravity ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAntigravityAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Antigravity task conversation was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Write tasks mutate the workspace through `agy`'s own (black-box) edits. Take
  // a recoverable git snapshot BEFORE the turn so a cancel/kill mid-turn can roll
  // back the turn's half-applied patches without losing the user's pre-run work.
  // Read-only tasks change nothing, so they need no snapshot.
  if (request.write) {
    const snapshot = snapshotWorkspace(workspaceRoot);
    if (snapshot && typeof request.onSnapshot === "function") {
      request.onSnapshot(snapshot);
    }
  }

  const result = await runTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    write: request.write,
    // `task --write` edits the workspace by design, so it never gets
    // `--sandbox`; a `task` without `--write` is read-only and runs sandboxed.
    sandbox: !request.write,
    // Rescue tasks invoke tools/git headlessly; skip the permission prompt so a
    // read-only task does not stall waiting for an answer that can never come.
    skipPermissions: true,
    onProgress: request.onProgress,
    onSpawn: request.onAgyPid
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    // Mirrors executeReviewRun's payload: without this, a caller that only has
    // `task --json` (e.g. stop-review-gate-hook.mjs) sees an empty rawOutput on
    // failure with no way to learn why — even though runOneShot already
    // computed a clear, actionable error (e.g. QUOTA_EXHAUSTED).
    error: result.error ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Antigravity Review" : `Antigravity ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Antigravity Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Antigravity Resume" : "Antigravity Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /antigravity:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    // Already effort-resolved to a final agy label (see handleTask).
    model,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, (ctx) => runner(progress, ctx), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "antigravity-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress, ctx) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
        onAgyPid: ctx?.recordAgyPid
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Effort folds into the model label right here (agy has no effort flag), so
  // everything downstream — foreground run, stored background request, worker
  // replay — carries one final `model` and no separate effort to lose.
  const model = resolveModelWithEffort(options.model, normalizeReasoningEffort(options.effort));
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureAntigravityAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress, ctx) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress,
        onAgyPid: ctx?.recordAgyPid,
        onSnapshot: ctx?.recordSnapshot
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  // Serialize same-workspace background jobs through a concurrency slot. With the
  // default cap of 1 this guarantees only one background `agy -p` per workspace
  // touches `last_conversations.json[cwd]` at a time, so parallel jobs can no
  // longer race on (and persist the wrong) conversation id. It also bounds how
  // many full `agy` processes a workspace can spawn at once. The wait happens
  // while the job is still "queued"; runTrackedJob flips it to "running" only
  // once we hold the slot and are about to spawn `agy`.
  const slot = await acquireSlot(workspaceRoot, { pid: process.pid });
  try {
    await runTrackedJob(
      {
        ...storedJob,
        workspaceRoot,
        logFile
      },
      (ctx) =>
        executeTaskRun({
          ...request,
          onProgress: progress,
          onAgyPid: ctx?.recordAgyPid,
          onSnapshot: ctx?.recordSnapshot
        }),
      { logFile }
    );
  } finally {
    slot.release();
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Antigravity turn interrupt for ${turnId} on ${threadId}.`
        : `Antigravity turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // Kill the real detached `agy` process tree first (recorded as `agyPid`), then
  // the Node wrapper (`pid`). Killing only the wrapper leaves the detached `agy`
  // child — and its tool subprocesses — running. `agyPid` may be absent for very
  // old/queued records, so fall back to `pid`.
  const agyPid = existing.agyPid ?? job.agyPid ?? null;
  const wrapperPid = existing.pid ?? job.pid ?? null;
  const killTargets = [...new Set([agyPid, wrapperPid].filter((value) => Number.isFinite(value)))];
  const { allStopped } = terminateProcessTrees(killTargets, {
    onError: (pid, error) =>
      appendLogLine(job.logFile, `Failed to terminate process ${pid}: ${error instanceof Error ? error.message : String(error)}`)
  });

  // `terminateProcessTree` throwing means the signal could NOT be delivered
  // (EPERM/exotic taskkill failure) — the target may still be a LIVE `agy`
  // editing the workspace. Rolling back now would corrupt a live writer's
  // tree, and writing a terminal `cancelled` would both hide a still-running
  // job from active views and (for a write task) drop the rollback snapshot.
  // So on an unconfirmed stop: change NOTHING destructive, keep the record and
  // its snapshot, and report the cancel as incomplete (review escalation P1).
  if (!allStopped) {
    const message =
      `Cancel could not confirm every process for ${job.id} stopped; the job is left running ` +
      `and the workspace untouched. Retry \`/antigravity:cancel ${job.id}\`, or inspect \`/antigravity:status ${job.id}\`.`;
    appendLogLine(job.logFile, message);
    process.exitCode = 1;
    outputCommandResult(
      {
        jobId: job.id,
        status: existing.status ?? job.status ?? "running",
        cancelled: false,
        cleanupError: message
      },
      `${message}\n`,
      options.json
    );
    return;
  }

  appendLogLine(job.logFile, "Cancel requested.");

  // Every kill target is confirmed stopped, so the CANONICAL job status is now
  // settled — a dead worker cannot write again. Re-read it BEFORE touching the
  // workspace. A job that SUCCEEDED on its own in the window between selection
  // and this kill has legitimate output: rolling back the pre-run snapshot
  // would ERASE it while falsely reporting "nothing to cancel" (review
  // escalation P1). So `completed` (and an already-`cancelled` job, whose
  // snapshot was consumed by the earlier cancel) take the untouched path.
  //
  // `failed` is deliberately NOT here: a failed WRITE turn retains its pre-run
  // snapshot precisely so a cancel can roll back the partial edits it left
  // behind (see runTrackedJob). Treating it as "nothing to cancel" would strand
  // that garbage in the workspace — so a failed job falls through to the
  // rollback below (review escalation P1, third pass).
  const canonical = readStoredJob(workspaceRoot, job.id) ?? existing;
  const preserveWorkspaceStatuses = new Set(["completed", "cancelled"]);
  if (preserveWorkspaceStatuses.has(canonical.status)) {
    const message = `Job ${job.id} already ${canonical.status} before it could be cancelled; nothing to cancel (workspace left untouched).`;
    appendLogLine(job.logFile, message);
    // Reconcile the index with the canonical status; leave the job file and the
    // workspace exactly as the finished worker left them.
    upsertJob(workspaceRoot, { id: job.id, status: canonical.status, pid: null, agyPid: null, workspaceSnapshot: null });
    outputCommandResult(
      { jobId: job.id, status: canonical.status, cancelled: false, note: message },
      `${message}\n`,
      options.json
    );
    return;
  }

  appendLogLine(job.logFile, "Cancelled by user.");

  // Write tasks run `agy`'s black-box edits directly in the workspace, so a
  // mid-turn kill (or a failed turn) can leave a half-applied patch. The job is
  // confirmed stopped and did NOT complete successfully — either still active
  // (mid-flight cancel) or `failed` — so its edits are an incomplete turn: roll
  // the working tree back to the pre-task snapshot (which preserves the user's
  // pre-run changes and only drops the turn's edits). Prefer the freshest
  // snapshot: a `failed` turn's is on the just-read canonical record. Best
  // effort: never let cleanup failure block the cancel itself.
  const snapshot = canonical.workspaceSnapshot ?? existing.workspaceSnapshot ?? job.workspaceSnapshot ?? null;
  let rollback = null;
  if (snapshot) {
    try {
      rollback = restoreWorkspaceSnapshot(snapshot);
      appendLogLine(
        job.logFile,
        rollback.restored
          ? `Rolled back workspace to the pre-task snapshot${rollback.partial ? ` (partial: ${rollback.reason})` : "."}`
          : `Workspace left as-is: ${rollback.reason}`
      );
    } catch (error) {
      rollback = { restored: false, reason: error instanceof Error ? error.message : String(error) };
      appendLogLine(job.logFile, `Workspace rollback failed: ${rollback.reason}`);
    }
  }

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agyPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // Defensive guard: canonical was non-terminal a moment ago and the worker is
  // dead, so this CAS normally applies. If it somehow did not, never claim a
  // clean cancel — surface the status that actually won on disk. (Reaching here
  // still means the job was non-terminal at the pre-rollback check, so the
  // rollback above dropped an incomplete turn's edits, not completed output.)
  const write = writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    // Snapshot consumed (or never present); drop it so it cannot be re-applied.
    workspaceSnapshot: null,
    cancelledAt: completedAt
  });

  if (!write.applied) {
    const finalStatus = write.canonicalStatus ?? "finished";
    const message = `Job ${job.id} reached ${finalStatus} before the cancel could be recorded; reporting the canonical status.`;
    appendLogLine(job.logFile, message);
    upsertJob(workspaceRoot, { id: job.id, status: finalStatus, pid: null, agyPid: null, workspaceSnapshot: null });
    outputCommandResult(
      { jobId: job.id, status: finalStatus, cancelled: false, note: message, workspaceRollback: rollback },
      `${message}\n`,
      options.json
    );
    return;
  }

  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agyPid: null,
    workspaceSnapshot: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    workspaceRollback: rollback
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
