import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  resolveReviewTarget,
  restoreWorkspaceSnapshot,
  snapshotWorkspace
} from "../plugins/antigravity/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function extractSection(content, title) {
  const match = content.match(new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?:\\n## |$)`));
  return match ? match[1].trim() : "";
}

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext lists untracked names+sizes (not bodies) in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  const untrackedContent = 'export const value = "UNTRACKED_RISK_MARKER";\n';
  fs.writeFileSync(path.join(cwd, "new-risk.js"), untrackedContent);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  // Name + size are inlined...
  assert.match(context.content, new RegExp(`new-risk\\.js \\(${Buffer.byteLength(untrackedContent, "utf8")} bytes\\)`));
  // ...but the file body is never inlined in self-collect mode.
  assert.doesNotMatch(context.content, /UNTRACKED_RISK_MARKER/);
});

test("collectReviewContext caps self-collect untracked listing at 200 and reports the remainder", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const untrackedCount = 205;
  for (let i = 0; i < untrackedCount; i += 1) {
    fs.writeFileSync(path.join(cwd, `untracked-${String(i).padStart(4, "0")}.txt`), `body ${i}`);
  }

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);
  const untrackedSection = extractSection(context.content, "Untracked Files");

  assert.equal(context.inputMode, "self-collect");
  assert.match(untrackedSection, /untracked-0000\.txt \(\d+ bytes\)/);
  assert.match(untrackedSection, /untracked-0199\.txt \(\d+ bytes\)/);
  assert.doesNotMatch(untrackedSection, /untracked-0200\.txt/);
  assert.match(untrackedSection, new RegExp(`…and ${untrackedCount - 200} more`));
});

test("collectReviewContext self-collect untracked section does not break with zero untracked files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /## Untracked Files\n\n\(none\)/);
});

test("collectReviewContext keeps untracked file bodies inline in inline-diff mode (regression control)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { includeDiff: true });

  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("snapshotWorkspace + restoreWorkspaceSnapshot roll back a turn's tracked edits", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'committed';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  // Pre-run user change that MUST be preserved across a rollback.
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'user-edit';\n");

  const snapshot = snapshotWorkspace(cwd);
  assert.ok(snapshot, "snapshot should capture the workspace");
  assert.ok(snapshot.head, "snapshot should record HEAD");

  // Simulate the write turn's half-applied patch on top of the user edit.
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'half-applied-by-agy';\n");

  const result = restoreWorkspaceSnapshot(snapshot);
  assert.equal(result.restored, true);

  // The turn's edit is gone; the user's pre-run edit is restored.
  const restored = fs.readFileSync(path.join(cwd, "app.js"), "utf8");
  assert.match(restored, /user-edit/);
  assert.doesNotMatch(restored, /half-applied-by-agy/);
});

test("restoreWorkspaceSnapshot captures a recovery point so a reset never loses tracked edits unrecoverably", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'committed';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const snapshot = snapshotWorkspace(cwd);

  // Simulate the scenario the fourth Codex pass flagged: a late cancel of an
  // already-failed job whose index stayed `running`, with the USER's own edit
  // present in the working tree at rollback time.
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'users-later-work';\n");

  const result = restoreWorkspaceSnapshot(snapshot);
  assert.equal(result.restored, true);
  // The reset happened (tree is back to committed) ...
  assert.match(fs.readFileSync(path.join(cwd, "app.js"), "utf8"), /committed/);
  // ... but the user's edit is NOT lost: it is recoverable from the returned
  // stash commit, so the rollback is non-destructive.
  assert.ok(result.recoveryStash, "a recovery stash SHA must be returned");
  const show = run("git", ["show", `${result.recoveryStash}:app.js`], { cwd });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /users-later-work/);
});

test("restoreWorkspaceSnapshot leaves the tree in place when HEAD moved (new commits)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const snapshot = snapshotWorkspace(cwd);

  // The turn committed new work; a blind reset would discard it, so restore must
  // refuse and leave the tree for manual review.
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'turn-commit';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "turn made a commit"], { cwd });

  const result = restoreWorkspaceSnapshot(snapshot);
  assert.equal(result.restored, false);
  assert.match(result.reason, /HEAD moved/);
  assert.match(fs.readFileSync(path.join(cwd, "app.js"), "utf8"), /turn-commit/);
});

test("restoreWorkspaceSnapshot is a no-op for a null/invalid snapshot", () => {
  assert.deepEqual(restoreWorkspaceSnapshot(null), { restored: false, reason: "no snapshot" });
  assert.deepEqual(restoreWorkspaceSnapshot({}), { restored: false, reason: "no snapshot" });
});

test("snapshotWorkspace returns null outside a git repository", () => {
  const cwd = makeTempDir();
  assert.equal(snapshotWorkspace(cwd), null);
});
