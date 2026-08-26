# cca — Claude account manager

Switch between several Claude.ai accounts in Claude Code without logging out and back
in, see how much of each account's session window is left, and open a session window
when it suits your day.

```
$ cca list
  NAME         ACCOUNT                SESSION (5h)              WEEK           MODE
● personal     me@example.com         ███░░░░░░░  25% ↻00:50     32% ↻5d4h     shared
○ work         me@company.com         ████████░░  82% ↻03:15     61% ↻2d1h     shared

$ cca
┌ Launch Claude Code as ─────────────────────────────────────┐
│ ▸ ● personal   me@example.com   ███░░░░░░░  25% ↻00:50      │
│     work       me@company.com   ████████░░  82% ↻03:15      │
└────────────────────────────────────────────────────────────┘
```

## Why this works

Claude Code namespaces its credential storage by a hash of its effective config
directory. From the v2.1.246 binary:

```js
function v(n = "") {
  let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
      r = e !== undefined ? e.normalize("NFC") : configDir(),
      s = t ? "" : `-${sha256(r).digest("hex").substring(0, 8)}`;
  return `Claude Code${OAUTH_FILE_SUFFIX}${n}${s}`;
}
```

Point Claude Code at a different storage directory and it transparently reads a
different credential slot. That is the whole mechanism — no credential shuffling
between logins, no patched binaries, no polling a login page.

Two environment variables control it, and they give two different kinds of separation:

| Variable | What is separated | What stays shared |
| --- | --- | --- |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | credentials only | history, projects, `settings.json`, plugins, MCP servers |
| `CLAUDE_CONFIG_DIR` | everything | nothing |

`cca` defaults to the first (`--shared`), because for two personal accounts you almost
always want one shared history and one shared set of plugins. Pass `--isolated` per
profile when you want a hard wall instead.

## Install

```bash
npm install -g claude-account-manager
```

Or grab a standalone binary from the [releases page](../../releases) — it bundles its
own runtime and needs nothing else installed.

On macOS, replace an existing binary rather than overwriting it in place: writing over a
Mach-O file invalidates its signature and the kernel kills the next run with SIGKILL.

```bash
rm -f ~/.local/bin/cca && cp cca-macos-arm64 ~/.local/bin/cca && codesign -fs - ~/.local/bin/cca
```

Building from source needs [Bun](https://bun.sh):

```bash
bun install
bun run build            # → dist/cli.js, the Node bundle npm ships
bun run build:binaries   # → dist/bin/, standalone binaries for every platform
```

## Getting started

```bash
cca import              # adopt the account you are already logged into
cca login work          # add the second account (opens the normal Claude login)
cca                     # pick one and launch
```

`cca import` copies your existing session into a profile. It does not move or delete
anything, so a plain `claude` keeps working exactly as before.

### Make `claude` itself show the picker

```bash
cca shell-init fish >> ~/.config/fish/config.fish   # or zsh / bash / pwsh
```

Now `claude` shows the account picker, and `claude --resume` and every other flag pass
straight through. `cca run --last` skips the picker when you just want the last account.

## Session warm-up

A Claude subscription's session window opens at your **first request** and runs for five
hours. If you start work at 09:00 the window ends at 14:00, and a late-morning start
pushes the reset into the evening.

Warming sends one minimal Haiku request (22 input tokens, 1 output token) at a time you
choose, so the window opens — and therefore resets — when you want it to.

```bash
cca warm                            # open the active account's window now
cca warm --all
cca warmup smart                    # warm each account as soon as its window resets
cca warmup schedule --at 08:00,13:00
cca daemon install                  # register launchd / systemd / Task Scheduler
cca daemon status
```

This shifts *when* your window runs. It does not add quota, and it is an ordinary
API request billed against the account's normal allowance.

`cca daemon install` registers a scheduler entry that runs `cca daemon tick` on an
interval; the tick decides what is due. There is no long-lived process to supervise, and
a missed tick only means a late warm-up.

### Keeping idle accounts usable

The daemon rotates OAuth tokens twice a day when `refreshTokens` is on (the default);
`cca refresh --all` does it by hand. That keeps an untouched account's access token
valid, so its limits stay readable and it can be launched without a detour.

**It does not postpone the re-login.** The refresh deadline is fixed when you log in —
about 28 days — and rotating does not move it. Measured against a live account: two
rotations an hour apart reported countdowns landing on the same instant. So every
account needs a browser login roughly monthly no matter how diligent the daemon is.
`cca list` and the status line warn as that date approaches; `cca login <name>` resets
it.

## Statusline

```json
{
  "statusLine": { "type": "command", "command": "cca statusline" }
}
```

```
● work pro │ 5h ████████▌░ 85% ↻40m  7d ██████░░░░ 61% ↻4d15h │ ⇗1.4%/m caps 00:49 │ ↦ personal 4%
Opus 5 ·high ·think │ ctx ▊░░░░░░░░░ 8%/1M │ ⎇ main !5 ?2 │ $1.51 +412/-77 │ 5m
```

Three things there are not on any single-account status line:

- **Every account at once.** `↦ personal 4%` is the other login's remaining quota. The
  arrow replaces the bullet only when switching would actually help — the current
  account is under pressure and that one has real room left.
- **Burn rate.** `⇗1.4%/m caps 00:49` fits a rate to how fast the window is being spent
  and extends it to 100%. It turns red when the cap lands *before* the reset, which is
  the moment you want to know about in advance rather than discover.
- **Colour that tracks the number**, green through orange to red, on both the bar and
  the percentage.

Claude Code hands the status line the active account's limits, context window and cost
on stdin, so the everyday render makes no network call at all. Background accounts come
from a cache that a detached child refills.

### Layout

Segments are configured in `~/.ccacc/config.json`, one list per rendered line. Delete
what you do not want; unknown names are ignored:

```json
"statusline": {
  "lines": [
    ["account", "limits", "burn", "others", "login"],
    ["model", "ctx", "git", "cost", "tools", "uptime"]
  ],
  "barWidth": 10,
  "barStyle": "blocks",
  "color": "on"
}
```

| Segment | Shows |
| --- | --- |
| `account` | active profile, plan, dot coloured by session usage |
| `limits` | five-hour and seven-day bars with reset countdowns |
| `burn` | projected time to the cap, red when it beats the reset |
| `others` | the other accounts' usage, with the switch hint |
| `login` | countdown when an account's login is about to lapse, silent otherwise |
| `model` | model, reasoning effort, thinking, fast mode, output style |
| `ctx` | context window used, flagged when the window is 1M |
| `git` | branch, ahead/behind, conflicted, modified, untracked |
| `cost` | session cost and lines added or removed |
| `tools` | tool calls so far this session |
| `uptime` | session duration |
| `dir` | current directory name |
| `warmup` | warm-up mode when enabled |
| `version` | Claude Code version |

`barStyle: "ascii"` swaps block glyphs for `#---`. `color: "off"` drops ANSI, as does
`NO_COLOR`.

Iterate on a layout without restarting Claude Code:

```bash
cca statusline --preview
```

## Notifications

```bash
cca notify test    # prove they arrive on this machine
cca notify on
```

Off by default. Once on, `cca daemon tick` announces three things, using only
what the warm-up already fetched — no extra requests:

- a session window opened after a warm-up, and when it resets
- the account in use passed `limitThreshold` (90%) while another has real room,
  naming the one to switch to
- a login is inside its final week, and that rotating tokens will not save it

Each event is announced once. The tick runs every few minutes and keeps seeing
the same state, so a key per event is recorded in `~/.ccacc/state/daemon.json`;
without it a single warm-up would be announced until the window closed.

macOS uses `osascript`, Linux `notify-send`, Windows PowerShell. Nothing is
installed; a platform missing its tool simply gets no notification.

## Where the quota goes

```bash
cca stats             # last 7 days, every account
cca stats work --days 30 --json
```

```
work · last 7 days
  windows  9 seen · peak 38% avg · 67% worst
  by hour  ▄▃▃▁▁▁▁▁▁▁▁▃▆▄▆▆▆▆███▃▂▄
           0h        6h        12h       18h    23h
  recent
    Aug 26 16:24    ████████░░░░ 67%
    Aug 26 11:24    █████░░░░░░░ 42%
```

Built from readings the status line already took, so it costs no requests and
works offline. Two things a single percentage cannot tell you: how close a
normal window gets to the ceiling, and which hours the quota actually goes in —
useful for picking warm-up times that land a fresh window where you need it.

Windows are grouped by their reset timestamp rather than by a time range, so a
gap when Claude Code was closed does not split one window into two. Only rises
count toward an hour's burn: a reset shows up as utilisation dropping, and
counting that would cancel out real usage elsewhere in the day.

History lives in `~/.ccacc/history/<name>.jsonl` and is kept for 60 days.

## The `/account` command

Install the plugin to get `/account` inside Claude Code:

```
/plugin marketplace add flxxxxddd/claude-account-manager
/plugin install claude-account-manager
```

```
/account              # active account and limits, explained
/account use work     # switch the account the next launch will use
/account warm all
```

**A switch takes effect on the next launch.** Claude Code reads credentials once at
startup, so nothing can move a running session to a different account.

## Command reference

| Command | What it does |
| --- | --- |
| `cca` | pick an account and launch Claude Code |
| `cca run <name> -- <args>` | launch a specific account, forwarding arguments |
| `cca run --last` / `--best` | skip the picker; `--best` takes the most quota left |
| `cca list [--json]` | accounts with live limits |
| `cca status [name] [--json]` | detail for one account |
| `cca stats [name] [--days N] [--json]` | usage history and burn by hour |
| `cca use <name>` | set the active account |
| `cca import [name]` | adopt the session you are already logged into |
| `cca login <name>` | add an account |
| `cca remove <name> [--purge]` | forget an account |
| `cca rename <old> <new>` | rename a profile |
| `cca sync <name>` | refresh cached email and organisation |
| `cca warm [name\|--all]` | open the session window |
| `cca refresh [name\|--all]` | rotate OAuth tokens |
| `cca warmup <on\|off\|smart\|schedule>` | configure warm-up |
| `cca daemon <install\|uninstall\|status\|tick>` | scheduler |
| `cca notify <on\|off\|test>` | desktop alerts |
| `cca shell-init <shell>` | shell snippet for the picker |
| `cca statusline [--preview]` | status line output; `--preview` redraws the last frame |
| `cca doctor [--deep]` | verify the setup |

## Where things live

```
~/.ccacc/config.json              profiles and warm-up settings
~/.ccacc/profiles/<name>/         one credential storage directory per account
~/.ccacc/cache/usage/<name>.json  cached limits, one file per account
~/.ccacc/cache/burn.json          usage samples behind the burn-rate projection
~/.ccacc/cache/last-payload.json  last status-line frame, for `--preview`
~/.ccacc/history/<name>.jsonl     usage readings behind `cca stats`
~/.ccacc/state/daemon.json        what the scheduler has already done
```

`CCA_HOME` moves all of it. `CCA_CLAUDE_BIN` points at a different `claude` binary.

## Credential storage

`cca` writes credentials where Claude Code reads them, per platform:

| Platform | Storage |
| --- | --- |
| macOS | reads Keychain then `<dir>/.credentials.json`, writes the file (mode `600`) |
| Linux | `<dir>/.credentials.json` (mode `600`) |
| Windows | Credential Manager, falling back to the file when unavailable |

On macOS Claude Code reads the Keychain first and falls back to the file, but writes the
Keychain through a native binding — the binary has no `add-generic-password` call. The
`security` CLI truncates a piped secret at 128 bytes and otherwise needs it in `argv`,
and a real credential blob is around 11 KB, so `cca` writes the file and clears the
profile's Keychain entry to keep the file authoritative. Claude Code migrates it back
into the Keychain on its next token refresh, and `cca` reads Keychain-first so it always
sees whichever copy is current.

`cca` never writes to the default credential slot — the one a plain `claude` login owns.
Profiles always get their own directory.

## Verifying it works

```bash
cca doctor --deep
```

`--deep` runs `claude auth status` under each profile's environment and checks that
Claude Code reports the account the profile claims:

```
✓ claude CLI on PATH — 2.1.246 (Claude Code)
✓ credential backend — keychain
✓ default Claude Code session — present (Claude Code-credentials)
✓ profile personal: credentials — Claude Code-credentials-c8537f02
✓ profile personal: Claude Code agrees — claude sees me@example.com
```

## Caveats

- **Switching is per-launch.** Credentials are read at startup; a running session keeps
  the account it started with.
- **Claude Code is a moving target.** `cca` depends on how v2.1.246 addresses credential
  storage. If a future release changes that, `cca doctor --deep` is what tells you, and
  the golden-value tests in `src/cc-paths.test.ts` are what fail in CI.
- **Warm-up spends a little quota.** One Haiku request per warm — negligible, but not
  free, and it cannot enlarge a limit.
- **One account per launch.** Running two accounts at once means two terminals.

## Licence

MIT
