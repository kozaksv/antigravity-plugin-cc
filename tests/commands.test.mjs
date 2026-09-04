import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy } from "./fake-agy-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "antigravity");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "antigravity-companion.mjs");

function withFakeAgy() {
  const binDir = makeTempDir("antigravity-command-bin-");
  installFakeAgy(binDir);
  const argvLog = path.join(makeTempDir("antigravity-command-argv-"), "argv.log");
  const pluginDataDir = makeTempDir("antigravity-command-data-");
  const env = buildEnv(binDir, { argvLog });
  // buildEnv не пробрасує довільні ключі — теку даних задаємо явно.
  env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const cwd = makeTempDir("antigravity-command-cwd-");
  return { env, cwd, argvLog, pluginDataDir };
}

function readArgvInvocations(argvLog) {
  if (!fs.existsSync(argvLog)) {
    return [];
  }
  return fs
    .readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findJsonDocuments(root) {
  const documents = [];
  if (!fs.existsSync(root)) {
    return documents;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      documents.push(...findJsonDocuments(target));
    } else if (entry.isFile()) {
      try {
        documents.push(JSON.parse(fs.readFileSync(target, "utf8")));
      } catch {
        // Job output and pid files share the state tree; only JSON matters here.
      }
    }
  }
  return documents;
}

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// D3: the external Bash timeout used by foreground blocks must strictly
// exceed the full internal wrapper budget (a review/task is a SINGLE agy
// turn — there is no automatic repair turn), so the wrapper self-timeouts
// before Claude Code's Bash tool kills it. Bash's own timeout is capped at
// 600000ms, so the internal turn budget must be reduced below that ceiling.
const BASH_TIMEOUT_CEILING_MS = 600000;

function extractSection(source, startLabel, endLabel) {
  const startIndex = source.indexOf(startLabel);
  assert.notEqual(startIndex, -1, `expected to find "${startLabel}"`);
  const afterStart = startIndex + startLabel.length;
  const endIndex = endLabel ? source.indexOf(endLabel, afterStart) : -1;
  return endIndex === -1 ? source.slice(afterStart) : source.slice(afterStart, endIndex);
}

function assertForegroundTimeoutIsSafe(section, label) {
  assert.match(
    section,
    /timeout:\s*600000/,
    `${label}: foreground block must pin the Bash tool timeout to the 600000ms ceiling`
  );
  const envMatch = section.match(/ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS[=:\s]+(\d+)/);
  assert.ok(
    envMatch,
    `${label}: foreground block must export ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS with a numeric value`
  );
  const perTurnMs = Number(envMatch[1]);
  assert.ok(perTurnMs > 0, `${label}: per-turn timeout must be positive`);
  // Worst case is the single agy turn (no automatic repair turn exists).
  assert.ok(
    perTurnMs < BASH_TIMEOUT_CEILING_MS,
    `${label}: internal turn budget (${perTurnMs}ms) must stay strictly under the ${BASH_TIMEOUT_CEILING_MS}ms Bash ceiling`
  );
  assert.doesNotMatch(
    section,
    /timeout:\s*900000/,
    `${label}: must not use the 900000ms wrapper default in a foreground block`
  );
  assert.match(
    section,
    /external.*Bash.*(?:exceed|greater than|larger than|>).*internal|internal.*budget.*(?:before|first|self-timeout)/is,
    `${label}: must document that the external Bash timeout exceeds the internal wrapper budget`
  );
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Antigravity's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/antigravity-companion\.mjs" review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Antigravity review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  // The runner only invokes `codex`/`codex app-server` if the rename is incomplete.
  assert.doesNotMatch(source, /codex/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/antigravity-companion\.mjs" adversarial-review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Antigravity adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.doesNotMatch(source, /codex/i);
});

test("review command foreground block keeps the Bash timeout cascade non-inverted (D3)", () => {
  const source = read("commands/review.md");
  const section = extractSection(source, "Foreground flow:", "Background flow:");
  assertForegroundTimeoutIsSafe(section, "review.md foreground flow");
});

test("adversarial review command foreground block keeps the Bash timeout cascade non-inverted (D3)", () => {
  const source = read("commands/adversarial-review.md");
  const section = extractSection(source, "Foreground flow:", "Background flow:");
  assertForegroundTimeoutIsSafe(section, "adversarial-review.md foreground flow");
});

test("antigravity-rescue agent foreground forwarding keeps the Bash timeout cascade non-inverted (D3)", () => {
  const agent = read("agents/antigravity-rescue.md");
  const section = extractSection(agent, "Forwarding rules:", "Response style:");
  assertForegroundTimeoutIsSafe(section, "antigravity-rescue.md forwarding rules");
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue routes to the antigravity-rescue subagent via the Agent tool, never via Skill", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/antigravity-rescue.md");
  const runtimeSkill = read("skills/antigravity-cli-runtime/SKILL.md");

  assert.match(rescue, /allowed-tools:.*\bAgent\b/);
  // Regression for codex #234/#235: routing must use the Agent tool, not Skill,
  // to avoid the command re-entering itself.
  assert.match(rescue, /subagent_type: "antigravity:antigravity-rescue"/);
  assert.match(rescue, /do not call `Skill\(antigravity:antigravity-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.doesNotMatch(rescue, /codex/i);

  assert.match(agent, /name:\s*antigravity-rescue/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /antigravity-companion\.mjs" task/);
  assert.doesNotMatch(agent, /codex/i);

  assert.match(runtimeSkill, /antigravity-companion\.mjs" task/);
  assert.doesNotMatch(runtimeSkill, /codex/i);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /antigravity-companion\.mjs" result "\$ARGUMENTS"/);
  assert.doesNotMatch(result, /codex/i);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /antigravity-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.doesNotMatch(cancel, /codex/i);
});

test("status command shells out to the antigravity companion", () => {
  const status = read("commands/status.md");
  assert.match(status, /antigravity-companion\.mjs" status "\$ARGUMENTS"/);
  assert.doesNotMatch(status, /codex/i);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command installs and authenticates Antigravity, not Codex", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /antigravity-companion\.mjs" setup --json \$ARGUMENTS/);
  // Setup must install `agy`, not Codex, and must not mention OpenAI/Codex auth.
  assert.match(setup, /antigravity\.google\/cli\/install\.sh/);
  assert.doesNotMatch(setup, /@openai\/codex/);
  assert.doesNotMatch(setup, /codex login/i);
});

test("task parser accepts --print-timeout and forwards it to agy", () => {
  const { env, cwd, argvLog } = withFakeAgy();
  const result = run(
    "node",
    [SCRIPT, "task", "--json", "--print-timeout", "1500s", "say hi"],
    { cwd, env }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /unknown option/i);

  const argv = readArgvInvocations(argvLog).find((invocation) => invocation.includes("-p"));
  assert.ok(argv, "expected one agy task invocation");
  const timeoutIndex = argv.indexOf("--print-timeout");
  assert.notEqual(timeoutIndex, -1, `expected --print-timeout in ${JSON.stringify(argv)}`);
  assert.equal(argv[timeoutIndex + 1], "1500s");
});

test("task --background persists printTimeout in its job request", async () => {
  const { env, cwd, pluginDataDir } = withFakeAgy();
  const result = run(
    "node",
    [SCRIPT, "task", "--json", "--background", "--print-timeout", "1500s", "say hi later"],
    { cwd, env }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /unknown option/i);

  const deadline = Date.now() + 5000;
  let savedRequest = null;
  while (Date.now() < deadline && savedRequest === null) {
    savedRequest = findJsonDocuments(pluginDataDir).find(
      (document) => document && document.printTimeout === "1500s"
    );
    if (savedRequest === null || savedRequest === undefined) {
      savedRequest = null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  assert.ok(savedRequest, `expected a saved job request under ${pluginDataDir}`);
  assert.equal(savedRequest.printTimeout, "1500s");
});
