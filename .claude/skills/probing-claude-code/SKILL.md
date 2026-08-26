---
name: probing-claude-code
description: Use when work on this repo needs a fact about how Claude Code itself behaves — where it stores credentials, which env vars it honours, what an internal API returns, or whether a new CC release broke the addressing in src/cc-paths.ts. Covers reading the shipped binary and confirming findings against a running claude.
---

# Probing Claude Code

This project encodes Claude Code's private behaviour, so every claim about that
behaviour must come from the shipped binary or a live `claude`, never from memory.

## Find the binary

```bash
readlink -f "$(command -v claude)"     # → ~/.local/share/claude/versions/<version>
```

It is a Bun single-file executable: the JavaScript is embedded as plain strings.

## Read it

```bash
B=$(readlink -f "$(command -v claude)")
strings -a "$B" | grep -oE ".{200}CLAUDE_SECURESTORAGE_CONFIG_DIR.{200}" | head
```

Anchor on an identifier and widen the window until whole functions appear. Useful
anchors: `CLAUDE_CONFIG_DIR`, `-credentials`, `find-generic-password`, `/api/oauth/`,
`refresh_token`.

Two cautions:

- Very wide `grep -oE` windows hit ugrep's complexity limit. Narrow the window or
  anchor on a longer literal instead.
- **Absence is evidence.** `add-generic-password` appearing nowhere is what established
  that Claude Code never writes the keychain through the CLI — which is why the macOS
  backend writes the file.

## Confirm against a running claude

Reading the binary produces a hypothesis. This is the proof:

```bash
CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/probe claude auth status   # expect loggedIn:false
claude auth status                                              # unchanged
```

`claude auth status --json` prints `loggedIn`, `email`, `orgId` and `subscriptionType` —
enough to tell which credential slot Claude Code actually resolved. Establish precedence
between two sources by planting a deliberately invalid value in one and seeing whether
the valid one still wins.

Always use a throwaway directory, and clean up keychain items afterwards:

```bash
security delete-generic-password -s "Claude Code-credentials-<hash>" -a "$USER"
```

## Internal API shapes

Take a token from the default slot and call the endpoint directly rather than guessing
field names — `email` versus `email_address` has already cost one round of debugging:

```bash
TOK=$(security find-generic-password -s "Claude Code-credentials" -a "$USER" -w \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOK" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01" | python3 -m json.tool
```

Never do this with the **refresh** endpoint while experimenting: the server rotates the
refresh token, and a rotation you fail to persist logs the account out.

## After a Claude Code update

```bash
cca doctor --deep     # asks claude which account it resolves per profile
bun test              # golden hashes in src/cc-paths.test.ts
```

If `doctor --deep` disagrees with the profile, re-derive the addressing function from the
new binary before changing anything. Record the version you observed in the comment you
update — the existing ones say "v2.1.246" for exactly this reason.
