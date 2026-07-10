# Changelog

## 1.0.2

Hardening release: closes every finding of the 2026-07-10 full plugin review.

Security & honesty:

- Non-write runs (`review`, `adversarial-review`, `task` without `--write`) now
  pass agy's own `--sandbox` (terminal restrictions) as defense-in-depth;
  opt out with `ANTIGRAVITY_COMPANION_NO_SANDBOX=1`. README gains a Security
  posture section that states the real envelope (`--dangerously-skip-permissions`
  on every headless run, unsandboxed write tasks, prompt-injection risk).
- `runCommand` never uses a shell for git/agy/node (Windows argv-through-cmd
  injection closed); the Windows shell survives only as an opt-in for
  fixed-argument version probes. Supported platforms: macOS/Linux.
- NOTICE retains the upstream `Copyright 2026 OpenAI` line (Apache-2.0 §4(d)).

Adversarial review:

- The review-output JSON Schema is embedded into the prompt (`{{OUTPUT_SCHEMA}}`)
  and the reply is validated fail-closed — schema-invalid output is an explicit
  review error, never a silent approve. No automatic repair turn: resuming via
  agy's shared cwd->conversation cache could repair a foreign conversation.

State & concurrency:

- Plugin state moved out of the prunable, world-shared tmpdir:
  `$CLAUDE_PLUGIN_DATA/state` -> `$XDG_STATE_HOME` -> `~/.local/state/antigravity-companion`,
  directories pinned to 0700. One-time migration carries the legacy CONFIG only
  (the `stopReviewGate` toggle); pre-upgrade job records intentionally stay
  behind (a live 1.0.1 worker keeps writing them under /tmp).
- All `state.json` writes are serialized through an O_EXCL `state.lock` with
  atomic write-and-rename; `jobs/<id>.json` is the canonical status source with
  terminal-status CAS. Empty (crashed-mid-create) locks are reclaimed right
  after a short grace instead of wedging every waiter; a failed lock-payload
  write cleans up after itself.
- Session-end teardown captures jobs, kills processes and rolls back snapshots
  OUTSIDE the state lock, then removes records in one atomic write; SessionEnd
  hook timeout raised 5s -> 60s. `/antigravity:cancel` survives kill errors
  (EPERM no longer skips rollback and the cancelled-status write).
- A FAILED write turn (e.g. runner timeout mid-edit) preserves its pre-run
  workspace snapshot on the job record for rollback instead of destroying it.

Stop-review gate:

- `stop_hook_active` short-circuits to allow (one review per stop cycle — no
  block/review loop), and non-retryable `QUOTA_EXHAUSTED` allows the stop with
  a loud stderr note instead of blocking until the quota window resets.
- Timeout cascade: agy turn 780s < spawnSync 840s < Stop hook 900s; foreground
  commands run the single agy turn at 540s under the 600s Bash ceiling
  (`ANTIGRAVITY_COMPANION_TURN_TIMEOUT_MS`).

CLI correctness:

- `--effort` actually works now: values narrowed to `low|medium|high` and folded
  into the agy model-label suffix (`Gemini 3.5 Flash (High)`); labels without an
  effort variant error instead of silently dropping the flag.
- Self-collect review context lists untracked files by name+size instead of
  inlining their bodies (kept large working trees under the 128 KiB prompt cap).
- The auth probe in `/antigravity:setup` runs from a throwaway temp directory,
  so it no longer overwrites the workspace's most-recent-conversation mapping
  (fast `-c` resume stays intact).
- `status <id> --wait --timeout-ms 0` returns an instant snapshot; backslashes
  in slash-command arguments survive (`C:\path` no longer collapses); the
  quota-exhaustion detector from 1.0.1's follow-up (RESOURCE_EXHAUSTED via
  `--log-file` tail, external-kill guard for detached agy) ships in a release.
- Dead code removed (unused thread-name plumbing, duplicate model-alias map,
  duplicate SESSION_ID_ENV, unused fs helpers); `plugin.json` gains
  homepage/repository/license/keywords; command typos fixed.

## 1.0.1

- Fix a race in background-job concurrency slots: acquire slots via atomic
  `O_EXCL` create on fixed slot names instead of a directory-listing/sort
  protocol, so two same-workspace jobs can never both win the last slot.

## 1.0.0

- Initial version of the Antigravity (agy) plugin for Claude Code
