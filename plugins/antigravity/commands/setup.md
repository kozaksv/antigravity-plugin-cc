---
description: Check whether the local Antigravity CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl:*), Bash(bash:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" setup --json $ARGUMENTS
```

If the result says Antigravity is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Antigravity (agy) now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Antigravity (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" setup --json $ARGUMENTS
```

If Antigravity is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Antigravity is installed but not authenticated, tell the user to run `agy` interactively and sign in with their Google account. Authentication uses Google OAuth; do not mention API-key environment variables.
