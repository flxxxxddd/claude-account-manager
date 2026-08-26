# claude-account-manager

`cca` points Claude Code at one of several stored Claude.ai logins. TypeScript, run and
built with Bun, shipped as an npm package and as standalone binaries.

## The one thing to understand

Claude Code namespaces credential storage by `sha256(effective config dir)[0:8]`. Set
`CLAUDE_SECURESTORAGE_CONFIG_DIR` (credentials only) or `CLAUDE_CONFIG_DIR` (everything)
and it reads a different slot. `src/cc-paths.ts` reproduces that addressing and carries
the decompiled original in a comment.

**If `src/cc-paths.ts` is wrong, every profile silently loses its credentials.** Its
tests pin golden hash values computed outside the implementation. Do not "fix" a failing
golden test by regenerating it from the code it is testing.

## Layout

```
src/cc-paths.ts      credential addressing — the contract with Claude Code
src/store/           per-platform credential storage
  darwin.ts          read Keychain→file, write file (see below)
  keychain.ts        macOS `security` CLI
  file.ts            Linux and universal fallback, mode 600
  credman.ts         Windows Credential Manager via PowerShell P/Invoke
src/api.ts           /api/oauth/usage, /api/oauth/profile, token refresh, warm-up
src/session.ts       token freshness, refresh-with-write-back, per-profile status
src/config.ts        ~/.ccacc/config.json
src/commands/        one file per command group
src/statusline/      the HUD: stdin payload, segments, burn rate, git state
src/tui/picker.ts    dependency-free arrow-key picker
plugin/              the Claude Code plugin (/account, switching-accounts skill)
```

## Rules that are not obvious

**Never write the default credential slot.** `credentialServiceName(undefined)` is the
slot a plain `claude` login owns. `darwinStore` throws if asked to write or delete it.
Users must be able to uninstall this tool and still be logged in.

**Always persist a rotated refresh token.** The server rotates the refresh token on every
exchange. Calling `refreshTokens()` and dropping the result logs the profile out. Every
call site writes the result back inside `withLock("token-<profile>")`.

**macOS writes go to the file, not the Keychain.** Claude Code reads Keychain first and
falls back to the file, but writes the Keychain natively — there is no
`add-generic-password` in its binary. `security add-generic-password` truncates a piped
secret at 128 bytes and otherwise needs the secret in `argv`, and a credential blob is
~11 KB. So `darwinStore` writes the file and clears the profile's Keychain entry, and
reads Keychain-first so it still sees credentials CC has since migrated.

**The status line must not block.** `cca statusline` runs on every Claude Code turn.
The active account's limits, context window and cost arrive on stdin, so that account
needs no network at all; other accounts print from `~/.ccacc/cache/usage/<name>.json`
and a detached `cca cache-refresh` refills a stale one. Keep it free of awaited network
calls, and free of awaited locks — a lock the refresh child holds across a fetch would
stall every render waiting on it.

**One cache file per profile, never a shared one.** Refreshes are independent detached
children. A single `usage.json` makes every write a read-modify-write race, and the
child that finishes second silently reverts the other's profile.

**`rate_limits.*.resets_at` on stdin is in Unix seconds.** Everything else in this
codebase is milliseconds. Reading it raw puts the reset in 1970 and the window renders
as permanently expired; `windowsFromPayload` converts, and a test pins it.

**Warm-up shifts a window, it does not enlarge a quota.** Say so in any user-facing text.
It is an ordinary billed request.

## Working on this

```bash
bun test                  # pure logic: addressing, schedule slots, window state
bunx tsc --noEmit
bun run build             # → dist/cca
bun run src/cli.ts <cmd>  # run without building
```

`CCA_HOME=/tmp/cca-test` isolates a scratch profile set so experiments never touch a
real login.

Verify behaviour against Claude Code itself rather than against this code's own
assumptions:

```bash
CCA_HOME=/tmp/cca-test bun run src/cli.ts doctor --deep
CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/x claude auth status
```

The second command is the ground truth for the whole project: if Claude Code reports the
account you expect under a profile's environment, the addressing is right.

## Commits

Conventional Commits, and **never** a `Co-authored-by` trailer or any other
attribution footer — commits are authored by `flxxxxddd <flxxd@lunaria.land>` alone.

```
<type>(<optional scope>): <subject in the imperative, lowercase, no full stop>

<body: what changed and why, wrapped at ~80 columns>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`.
Scope is the area touched — `api`, `store`, `test`, `daemon` — and is optional.

One logical change per commit. A bug fix and a new skill are two commits, even when
the same working session produced both.

## Style

Match the surrounding code: named exports, `.ts` import extensions, `type` imports where
the import is only a type. Comments explain *why* — especially anything that encodes a
Claude Code implementation detail, which should say what was observed and in which
version. Errors name the fix (`run \`cca login <name>\``), not just the problem.
