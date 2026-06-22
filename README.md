# Antigravity plugin for Claude Code

Use Antigravity (`agy`) from inside Claude Code for code reviews or to delegate tasks to Antigravity.

This plugin is for Claude Code users who want an easy way to start using Google's Antigravity CLI from the workflow they already have.

## What You Get

- `/antigravity:review` for a normal read-only Antigravity review
- `/antigravity:adversarial-review` for a steerable challenge review
- `/antigravity:rescue`, `/antigravity:status`, `/antigravity:result`, and `/antigravity:cancel` to delegate work and manage background jobs

## Requirements

- **A signed-in Antigravity CLI (`agy`).** Authentication is through your Google account (Code Assist OAuth). There is no API-key environment variable to set.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add kozaksv/antigravity-plugin-cc
```

Install the plugin:

```bash
/plugin install antigravity@antigravity
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/antigravity:setup
```

`/antigravity:setup` will tell you whether Antigravity is ready. If `agy` is missing, it can offer to install it for you.

If you prefer to install `agy` yourself:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

If `agy` is installed but not signed in yet, run it interactively once and sign in with your Google account:

```bash
agy
```

`agy` detects SSH sessions and prints a sign-in URL when it cannot open a browser. There are no API-key environment variables — authentication is Google OAuth and the account state is stored under `~/.gemini/`.

After install, you should see:

- the slash commands listed below
- the `antigravity:antigravity-rescue` subagent in `/agents`

One simple first run is:

```bash
/antigravity:review --background
/antigravity:status
/antigravity:result
```

## Usage

### `/antigravity:review`

Runs a normal Antigravity review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/antigravity:adversarial-review`](#antigravityadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/antigravity:review
/antigravity:review --base main
/antigravity:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/antigravity:status`](#antigravitystatus) to check on the progress and [`/antigravity:cancel`](#antigravitycancel) to cancel the ongoing task.

### `/antigravity:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/antigravity:review`, including `--base <ref>` for branch review. It also supports `--wait` and `--background`. Unlike `/antigravity:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/antigravity:adversarial-review
/antigravity:adversarial-review --base main challenge whether this was the right caching and retry design
/antigravity:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/antigravity:rescue`

Hands a task to Antigravity through the `antigravity:antigravity-rescue` subagent.

Use it when you want Antigravity to:

- investigate a bug
- try a fix
- continue a previous Antigravity task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo. Resume is **native** to `agy` — the plugin reuses the existing Antigravity conversation rather than replaying history.

Examples:

```bash
/antigravity:rescue investigate why the tests started failing
/antigravity:rescue fix the failing test with the smallest safe patch
/antigravity:rescue --resume apply the top fix from the last run
/antigravity:rescue --model "Gemini 3.5 Flash (High)" investigate the flaky integration test
/antigravity:rescue --model spark fix the issue quickly
/antigravity:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Antigravity:

```text
Ask Antigravity to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, Antigravity uses its own default (`Gemini 3.5 Flash (Medium)`).
- if you say `spark`, the plugin maps that to the Antigravity lite model `Gemini 3.5 Flash (Low)`
- follow-up rescue requests can continue the latest Antigravity conversation in the repo

### `/antigravity:status`

Shows running and recent Antigravity jobs for the current repository.

Examples:

```bash
/antigravity:status
/antigravity:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/antigravity:result`

Shows the final stored Antigravity output for a finished job.
When available, it also includes the Antigravity conversation ID so you can reopen that run directly with `agy --conversation <id> -p` (or `agy -c` for the most recent conversation in that directory).

Examples:

```bash
/antigravity:result
/antigravity:result task-abc123
```

### `/antigravity:cancel`

Cancels an active background Antigravity job. Cancellation performs a process-tree kill (`SIGTERM`, then `SIGKILL` after a short grace period) so the underlying `agy` process is really stopped.

Examples:

```bash
/antigravity:cancel
/antigravity:cancel task-abc123
```

### `/antigravity:setup`

Checks whether Antigravity is installed and authenticated.
If `agy` is missing, it can offer to install it for you.

You can also use `/antigravity:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/antigravity:setup --enable-review-gate
/antigravity:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Antigravity review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Antigravity loop and may drain usage quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/antigravity:review
```

### Hand A Problem To Antigravity

```bash
/antigravity:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/antigravity:adversarial-review --background
/antigravity:rescue --background investigate the flaky test
```

Then check in with:

```bash
/antigravity:status
/antigravity:result
```

## Antigravity Integration

The plugin uses the global `agy` binary installed in your environment. Each turn is a one-shot, non-interactive run (`agy -p "<prompt>"`); there is no persistent server or app-server process. The plugin spawns `agy` directly (argv array, no shell), captures its stdout, and owns its own timeout and process-tree cancellation.

Output is parsed from `agy`'s plain-text stdout using explicit result markers (`===ANTIGRAVITY_RESULT_BEGIN===` / `===ANTIGRAVITY_RESULT_END===`). If those markers are missing, the plugin falls back to reading the structured conversation transcript at `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.

### Models

`agy` exposes a fixed set of model labels (see `agy models`):

- `Gemini 3.5 Flash (Low|Medium|High)`
- `Gemini 3.1 Pro (Low|High)`
- `Claude Sonnet 4.6 (Thinking)`
- `Claude Opus 4.6 (Thinking)`
- `GPT-OSS 120B (Medium)`

Pass a label verbatim with `--model`, or use one of the plugin's short aliases: `flash`, `flash-high`, `flash-low`, `pro`, `pro-low`, `sonnet`, `opus`, and `spark` (→ `Gemini 3.5 Flash (Low)`). When you omit `--model`, Antigravity uses its default (`Gemini 3.5 Flash (Medium)`).

### Configuration and state

`agy` shares the Gemini CLI home directory. Its configuration and per-conversation state live under:

- `~/.gemini/` — account state (`google_accounts.json`), shared `settings.json`, trusted folders.
- `~/.gemini/antigravity-cli/` — Antigravity-specific data: `settings.json`, the cwd→conversation map (`cache/last_conversations.json`), per-conversation SQLite databases (`conversations/<id>.db`), and JSONL transcripts (`brain/<id>/...`).

There is no `~/.codex/config.toml` equivalent and no `~/.antigravity/` directory — everything is under `~/.gemini/`.

### Resuming a conversation in Antigravity

Delegated tasks and any [stop gate](#enabling-review-gate) run can be resumed directly with the `agy` CLI:

- `agy -c -p "<follow-up>"` continues the most recent conversation in the current directory.
- `agy --conversation <id> -p "<follow-up>"` resumes a specific conversation by the ID shown in `/antigravity:result` or `/antigravity:status`.

This way you can review the Antigravity work or continue it directly in the CLI.

## Caveats

- **Prompt is passed via argv.** `agy -p` does not read from stdin. Very long prompts are subject to your OS `ARG_MAX` limit, so the plugin hard-caps the prompt at 128 KiB before spawning `agy`. Large reviews stay under the cap by automatically switching from an inline diff to a lightweight summary that asks Antigravity to inspect the diff itself; a prompt that would still exceed the cap is rejected with a clear error instead of an opaque spawn failure.
- **No JSON output mode.** `agy` has no `--output-format json` flag. The plugin relies on marker-based plain-text parsing with the transcript JSONL as a fallback, not on a structured CLI flag.
- **`--print-timeout` is advisory.** It does not reliably kill a stuck `agy` process, so the plugin enforces its own external timeout and process-tree kill.

## FAQ

### Do I need a separate account for this plugin?

If you are already signed into Antigravity (`agy`) on this machine, that account works here too. This plugin uses your local `agy` authentication.

If you have not used `agy` yet, run it once interactively and sign in with your Google account. Run `/antigravity:setup` to check whether Antigravity is ready.

### Does the plugin use a separate Antigravity runtime?

No. This plugin delegates through your local `agy` CLI on the same machine.

That means:

- it uses the same `agy` install you would use directly
- it uses the same local authentication state under `~/.gemini/`
- it uses the same repository checkout and machine-local environment

### Will it use the same Antigravity config I already have?

Yes. The plugin runs your local `agy` binary, so it picks up the same configuration and signed-in account under `~/.gemini/`.
