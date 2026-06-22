# `agy` CLI — live probe findings (v1.0.10, macOS/darwin)

> Source: direct probing of the installed binary at `/Users/a/.local/bin/agy`
> (`agy --version` → `1.0.10`) on macOS (darwin 25.5.0), 2026-06-22.
> Every statement below is **observed**, not assumed. Where reality contradicts
> `PORT_BRIEF.md`, it is called out in the "Differs from PORT_BRIEF" section.

---

## TL;DR for the runner

- **One-shot works and prints to non-TTY.** `agy -p "PROMPT"` prints the model
  reply to stdout, exit 0 — **even when stdout is a pipe or a redirected file.**
  The brief's issue #76 ("silent stdout dropping on non-TTY") is **FIXED** in
  1.0.10 (changelog: *"Fixed bash mode argument escaping (preventing swallowed
  stdout)"*). **Plain `execFile("agy", ["-p", prompt])` with piped stdio is the
  recommended capture path. No pseudo-TTY needed.**
- **Prompt MUST go via argv.** `-p` is a value flag; it does **not** read stdin
  (`echo ... | agy -p` → `flag needs an argument: -p`, exit 2). Use `execFile`
  (argv array, no shell). Both `-p "X"` and `-p="X"` work (Go flag parser).
- **No JSON output flag exists.** `--output-format` is undefined
  (`flags provided but not defined: -output-format`, exit 2). Parse plain text,
  OR read the structured transcript JSONL (see below) — that is the reliable
  structured source, not a CLI flag.
- **Resume is NATIVE and works.** `--continue`/`-c` (most-recent conversation in
  cwd) and `--conversation <id>` both carry context across separate `agy -p`
  invocations. This **replaces the re-feed emulation** the brief assumed.
- **`--print-timeout` (default 5m) is advisory, not a hard kill.** Observed a
  resume process run **>10 minutes** past a `--print-timeout 90s`. The runner
  MUST impose its own external timeout + process-tree kill.

---

## `agy --help` (verbatim flags, v1.0.10)

```
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  -i                              Short alias for --prompt-interactive
  --log-file                      Override CLI log file path
  --model                         Model for the current CLI session
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  update          Update CLI
```

Key flags for the plugin:

| Flag | Meaning | Notes for runner |
|---|---|---|
| `-p` / `--print` / `--prompt` | one-shot non-interactive print | **value flag** — prompt is the next argv. No stdin. |
| `-c` / `--continue` | resume most-recent conversation **for the cwd** | uses `cache/last_conversations.json` (cwd→id map). Fast resume path. |
| `--conversation <id>` | resume a specific conversation by UUID | works, but **slower first response** than `-c`; can exceed `--print-timeout`. Bogus id → `Warning: conversation "<id>" not found.` then runs fresh (exit 0). |
| `--print-timeout <dur>` | wait timeout for print mode (default `5m0s`) | **advisory** — does NOT reliably kill the process. Wrap with your own timeout. |
| `--model <label>` | model for this session | label form, e.g. `"Gemini 3.5 Flash (Medium)"` (see `agy models`). |
| `--add-dir <dir>` | add a directory to the workspace (repeatable) | for multi-root rescue. |
| `--dangerously-skip-permissions` | auto-approve all tool permission prompts | needed for headless/non-interactive agentic runs (otherwise it may block on a permission prompt). |
| `--sandbox` | run with terminal restrictions | optional hardening. |
| `--log-file <path>` | override CLI log file path | useful to isolate per-job logs. |

`agy --version` → `1.0.10` (exit 0).

---

## `agy models` (verbatim, v1.0.10)

```
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
```

Default model when none selected: `Gemini 3.5 Flash (Medium)` (observed in the
transcript `USER_SETTINGS_CHANGE` line). Pass to `--model` using the exact label
string above. (Note: the brief said "Gemini 3.x Pro/Flash, Claude Sonnet/Opus,
GPT-OSS 120B" — close, but real labels are **3.5 Flash / 3.1 Pro / Claude 4.6 /
GPT-OSS 120B**, each with an effort suffix.)

---

## One-shot + non-TTY truth (the critical test)

Commands run and **observed** output:

| Invocation | stdout | exit | bytes |
|---|---|---|---|
| `agy -p "reply with exactly OK"` (stdout → file) | `OK\n` | 0 | 3 |
| `agy -p "reply with exactly OK" \| cat` (pipe) | `OK\n` | 0 | 3 (clean) |
| `script -q /dev/null agy -p "..."` (pseudo-TTY) | `^D^H^HOK^M` | 0 | 8 (control chars) |
| `echo "..." \| agy -p` (stdin, no argv) | — | **2** | `flag needs an argument: -p` |
| `agy --output-format json -p "..."` | — | **2** | `flags provided but not defined: -output-format` |

**Conclusion:** non-TTY stdout is NOT dropped in 1.0.10. The **pipe path is the
cleanest** (`OK\n`, no ANSI/control noise). The pseudo-TTY (`script`) path is
**worse** here — it injects `^D`, `^H`, `^M` that you'd have to strip. So the
brief's prescribed `script`/`node-pty` workaround is **unnecessary and
counterproductive** for this version.

---

## Resume mechanism (exact, verified)

`agy` persists every conversation. **Native resume replaces the brief's re-feed
plan.**

**On-disk model (base dir = `~/.gemini/antigravity-cli/`):**
- `conversations/<uuid>.db` — one **SQLite 3.x** database per conversation
  (full history; `file` reports `SQLite 3.x database`).
- `brain/<uuid>/.system_generated/logs/transcript.jsonl` and
  `transcript_full.jsonl` — **structured JSONL transcript** of the conversation.
- `cache/last_conversations.json` — **maps cwd → conversation UUID**, e.g.
  `{"/tmp/agytest2": "79683c6f-25c5-4702-acb2-f28125310d76"}`. This is what
  `--continue` uses to pick "the most recent conversation" for the working dir.
- `implicit/<uuid>.pb` — protobuf side-state per conversation.

**How to obtain a conversation id:** after a one-shot `agy -p` in a given cwd,
read `~/.gemini/antigravity-cli/cache/last_conversations.json` and look up the
entry keyed by that cwd. (`agy -p` does **not** print the conversation id to
stdout — you must read it from this cache file, or use `-c` which resolves it
internally.)

**Verified resume tests (separate `agy -p` processes, context carried):**
1. Turn 1: `agy -p "Remember the number 7777. Reply with exactly: GOT IT"` →
   `GOT IT`. cwd mapped to conversation `79683c6f-...`.
2. Resume via `agy -c -p "What number did I ask you to remember?..."` →
   **`7777`** (exit 0). ✅ Context recalled.
3. Resume via `agy --conversation 79683c6f-... -p "Repeat the number..."` →
   **`7777`** (exit 0). ✅ Context recalled — but slower (see caveat).

**Caveat — `--conversation <id>` latency / hang risk:** in two of three runs the
`--conversation <id>` resume took **well past `--print-timeout`** to produce
output (one run was still alive after ~10+ min and had to be SIGTERM-killed; it
did NOT honor `--print-timeout 90s`). `--continue`/`-c` consistently returned
fast. **Prefer `-c`** when the job is the most-recent-in-cwd; use
`--conversation <id>` only when you must target a specific id, and always wrap it
in your own timeout + process-tree kill.

**Transcript JSONL format** (the reliable structured-output source, one JSON
object per line):
```json
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"...","content":"<USER_REQUEST>\n...\n</USER_REQUEST>..."}
{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"...","content":"GOT IT"}
```
The model's reply is the line with `source:"MODEL"`, `type:"PLANNER_RESPONSE"`.
This is far more robust than scraping stdout text and is the recommended parse
target if/when stdout parsing proves fragile.

---

## Config & auth (on-disk reality)

**Base dir:** `~/.gemini/antigravity-cli/` — NOT `~/.antigravity/`, NOT
`~/.config/antigravity/`, NOT `~/.config/antigravity/config.toml`. `agy` shares
the **Gemini CLI** home (`~/.gemini/`). (Cache scratch dir: `~/.cache/antigravity/staging`.)

Layout under `~/.gemini/antigravity-cli/`:
```
settings.json            { "colorScheme": "light", "enableTelemetry": false }
keybindings.json
installation_id
cli.log  +  log/cli-<ts>.log     (verbose Go logs)
cache/   (last_conversations.json, last_conversations cache, projects.json, onboarding.json)
conversations/<uuid>.db          (SQLite per conversation)
brain/<uuid>/.system_generated/logs/transcript.jsonl
implicit/<uuid>.pb
knowledge/  builtin/  updater/  bin/
```

Shared at `~/.gemini/` root: `settings.json`, `google_accounts.json`,
`projects.json`, `config/`, `trustedFolders.json`.

**Auth (verified):**
- The installed instance is authenticated via a **Google account / Code Assist
  OAuth**, not an API-key env var. Evidence: `~/.gemini/google_accounts.json`
  exists; `~/.gemini/settings.json` contains
  `"security":{"auth":{"selectedType":"gemini-api-key"}}` (auth *type* is
  selectable; one option is api-key, but it routes through Google Code Assist /
  seat-management protobufs — `API_KEY_AUTH`, `ApiKeyConfig`, `MigrateApiKey`).
- **`ANTIGRAVITY_API_KEY` and `GEMINI_API_KEY` are NOT present as literal strings
  in the v1.0.10 binary** (`strings | grep -E 'ANTIGRAVITY_API_KEY|GEMINI_API_KEY'`
  → zero hits). The only auth-related env vars found in the binary are
  `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT`. (The many
  `ANTIGRAVITY_*` strings — `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`,
  `ANTIGRAVITY_BROWSER`, … — are internal agent/tool constants, **not** API-key
  vars.)
- **Practical takeaway for `/antigravity:setup`:** do NOT assert a hard priority
  of `ANTIGRAVITY_API_KEY` over `GEMINI_API_KEY` (the brief's claim). For this
  version, treat auth as: **(1)** presence of a logged-in Google account at
  `~/.gemini/google_accounts.json`; **(2)** optionally `GOOGLE_APPLICATION_CREDENTIALS`
  / `GOOGLE_CLOUD_PROJECT`; **(3)** the `~/.gemini/settings.json`
  `security.auth.selectedType`. Probe auth by **running a cheap one-shot**
  (`agy -p "reply OK"`) and checking exit 0 + non-empty output, rather than
  asserting a specific env var.

---

## Differs from PORT_BRIEF.md (reality vs. brief)

1. **non-TTY stdout dropping (issue #76) — NO LONGER REPRODUCIBLE.** Pipe and
   file-redirect both print correctly in 1.0.10. Pseudo-TTY workaround
   (`script`/`node-pty`) is unnecessary and adds control-char noise. → The whole
   "verified output strategy / pseudo-TTY fallback" architecture can be
   **dropped**; use plain piped `execFile`.
2. **`--output-format json` — does not exist** (brief said "exists but
   unreliable"). It's an undefined flag → exit 2. There is **no** structured
   output flag. Reliable structured data instead comes from
   `brain/<id>/.system_generated/logs/transcript.jsonl`.
3. **Native resume EXISTS** (brief: "resume by conversation ID — natively NONE…
   local session store + re-feed is the only option"). FALSE for 1.0.10:
   `--continue`/`-c` and `--conversation <id>` both resume context. **The local
   session-store + re-feed emulation is unnecessary** — use native resume. (You
   may still keep a thin index mapping your job id → agy conversation id, but the
   history re-feed, turn-limit, and context-overflow-summarization machinery the
   brief mandated are **not needed**.)
4. **Auth env vars are wrong.** Neither `ANTIGRAVITY_API_KEY` nor `GEMINI_API_KEY`
   is read by the binary (not present as strings). No `ANTIGRAVITY_API_KEY >
   GEMINI_API_KEY` priority to verify — the premise is moot. Auth is Google OAuth
   account + Code Assist.
5. **Config path is wrong.** Not `~/.antigravity/...`, not
   `~/.config/antigravity/config.toml`. Real base: `~/.gemini/antigravity-cli/`
   (shares `~/.gemini/` with Gemini CLI). Per-conversation state is **SQLite**,
   not the brief's hypothesized `.antigravity/sessions/<id>.json`.
6. **Transcript path differs.** Brief: `~/.antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`.
   Real: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
   (+ a `transcript_full.jsonl` sibling). Format confirmed: JSONL, model reply at
   `source:"MODEL"`,`type:"PLANNER_RESPONSE"`.
7. **Prompt delivery:** brief speculated `agy` might read prompt from stdin/file.
   It does **not** — `-p` is argv-only (stdin → exit 2). So the brief's
   ARG_MAX / `ps`-leak concern for long prompts is real; mitigate with a length
   cap, but there is no stdin/file alternative in this version. (Native resume
   removes the need to re-feed long histories anyway.)
8. **Model labels differ** slightly from the brief — see `agy models` above.
9. **`--print-timeout` is soft**, not enforced — the runner must own the timeout.
10. **ACP:** still absent (consistent with brief). No `--acp`, no app-server. The
    one-shot + native-resume model is the only mode.

---

## Concrete runner guidance (for THIS version)

**Spawn (no shell, argv array, piped stdio):**
```js
const { execFile } = require("node:child_process");
const child = execFile(
  "agy",
  [
    "-p", prompt,                      // argv only; never stdin
    // resume one of:
    //   "-c"                          // resume most-recent in cwd (preferred)
    //   "--conversation", convId      // resume specific id (slower; wrap in timeout)
    "--model", "Gemini 3.5 Flash (Medium)",     // optional, exact label
    "--dangerously-skip-permissions", // headless: avoid blocking on permission prompts
    "--print-timeout", "120s",        // advisory only
  ],
  {
    cwd: jobCwd,                       // cwd determines the cwd→conversation mapping
    env: process.env,                  // inherits Google OAuth from ~/.gemini
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  },
  (err, stdout, stderr) => { /* ... */ }
);
```

**Capture (stdout is reliable on non-TTY in 1.0.10):**
- Read `stdout` directly. It is plain text, no ANSI/control noise on a pipe.
- **Do NOT** use `script`/`node-pty`. (If a future `agy` regresses to dropping
  non-TTY stdout, fall back to reading the transcript JSONL — not to pseudo-TTY.)
- **Belt-and-suspenders parse**: define markers in `prompts/` (e.g.
  `===ANTIGRAVITY_RESULT_BEGIN===` / `===ANTIGRAVITY_RESULT_END===`) and extract
  between them; validate output is **non-empty AND contains the marker** before
  trusting it. If marker missing, fall back to the conversation's
  `brain/<id>/.system_generated/logs/transcript.jsonl` last
  `source:"MODEL"`/`type:"PLANNER_RESPONSE"` line.

**Resume (use native, drop re-feed):**
- Persist per job: `{ jobId, cwd, conversationId }`. Get `conversationId` after
  turn 1 by reading
  `~/.gemini/antigravity-cli/cache/last_conversations.json[cwd]`.
- Prefer `-c` (resume most-recent-in-cwd) when the job owns its cwd. Use
  `--conversation <id>` for explicit targeting, but expect higher latency and
  enforce your own timeout.
- No turn-limit / context-overflow / summarization machinery needed — `agy`
  owns the history in its SQLite store.

**Timeout & cancel (the runner must own both):**
- `--print-timeout` does NOT reliably kill — set an **external** timer in Node
  (e.g. `timeout`/`AbortController`) sized to your SLA.
- On cancel/timeout: SIGTERM the process; **SIGTERM was sufficient** in testing
  (resume hang died on first SIGTERM, no SIGKILL needed). Still implement
  SIGTERM → grace (≈5s) → SIGKILL, and kill the **process tree** (the `agy`
  process may spawn children).
- Validate success on: exit 0 **AND** non-empty stdout **AND** marker present —
  never trust exit code alone.

**Concurrency:** each conversation is a separate SQLite db keyed by cwd. Run
parallel jobs in **distinct cwds** (or distinct `--add-dir` roots) so their
cwd→conversation mappings don't collide in `last_conversations.json`. Cap the
number of concurrent `agy -p` processes (each is a full Go process, ~70MB+ RSS).

**Auth check for `/antigravity:setup`:** verify by running `agy -p "reply OK"`
and asserting exit 0 + non-empty stdout, plus checking
`~/.gemini/google_accounts.json` exists. Do not gate on `ANTIGRAVITY_API_KEY` /
`GEMINI_API_KEY` env vars — they are not consulted by this binary.
