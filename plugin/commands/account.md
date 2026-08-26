---
description: Show Claude account profiles with live session limits, or switch which one the next launch uses
argument-hint: "[use <name> | warm [name] | status]"
allowed-tools: Bash(cca:*)
---

## Current account

!`cca status 2>&1 || echo "cca is not installed — see https://github.com/flxxxxddd/claude-account-manager"`

## All profiles

!`cca list 2>&1 || true`

## What the user asked

`$ARGUMENTS`

## How to respond

Interpret the argument and act:

- **empty** — summarise the tables above. Lead with which account is active and how
  much of its 5-hour session window is left, then note any account whose window has
  more headroom. Keep it to a few lines.
- **`use <name>`** — run `cca use <name>`, then tell the user the switch applies to the
  **next** Claude Code launch. Credentials are read once at startup, so the running
  session keeps the account it started with. Do not claim the current session switched.
- **`warm [name]`** — run `cca warm <name>` (or `cca warm --all` when they say "all") and
  report the reset time it prints.
- **`status`** — the detail from `cca status` above, explained plainly.

If `cca` is not installed, say so and stop rather than guessing at the user's accounts.
