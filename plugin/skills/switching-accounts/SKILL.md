---
name: switching-accounts
description: Use when the user asks to switch Claude accounts, check how much of their rate limit or session window is left, warm up a session, or work out which of their accounts to use next. Covers the `cca` account manager, the 5-hour session window, and why a switch only takes effect on the next launch.
---

# Switching Claude accounts

The `cca` CLI keeps several Claude.ai logins side by side and points Claude Code at
one of them. Prefer running `cca` over inspecting credential storage by hand.

## Read the situation first

```bash
cca list      # every profile with live 5-hour and weekly utilisation
cca status    # detail for the active profile
```

`cca list --json` is the machine-readable form; each profile carries `fiveHour` and
`sevenDay` objects with `utilization` (percent) and `resets_at` (ISO timestamp).

## Switching

```bash
cca use <name>            # the next launch uses this account
cca run <name> -- <args>  # launch Claude Code as this account right now
cca run --best            # launch as whichever account has the most quota left
```

**A switch never affects the running session.** Claude Code reads credentials once at
startup, so `cca use` changes the *next* launch. Say this plainly rather than implying
the current conversation moved accounts.

## The 5-hour window

A subscription's session window opens at the first request and runs for five hours;
`resets_at` is when it lapses. Warming sends one minimal request so the window opens
at a chosen time — it shifts *when* the window runs, it does not add quota.

```bash
cca warm <name>       # open the window now
cca warm --all
cca warmup smart      # warm each account as soon as its window resets
cca warmup schedule --at 08:00,13:00
```

## Choosing an account

Recommend by 5-hour `utilization` first — lower is better — and fall back to the
weekly figure when two accounts are close. If an account shows `not logged in`, the
fix is `cca login <name>`, not a switch.

## When something looks wrong

`cca doctor --deep` verifies the whole chain, including asking Claude Code itself which
account it resolves under each profile. Run it before theorising about causes.
