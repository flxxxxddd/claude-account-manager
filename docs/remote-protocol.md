# CCA Remote protocol

How the `cca remote` daemon, the relay and the CCA Remote app talk. The source
of truth for shapes is `src/remote/protocol.ts`; `apps/CCARemote/Sources/Protocol`
mirrors it. Bump `PROTOCOL_VERSION` on any breaking change — `hello` rejects a
mismatch so an old app fails loudly instead of misrendering.

## Pieces

```
 iPhone / other Mac                 Cloudflare Worker (relay/)              this Mac
 ┌─────────────────┐   wss, sealed   ┌──────────────────────┐   wss, sealed  ┌───────────────────┐
 │ CCA Remote app  │◄──────────────►│ Room (Durable Object) │◄─────────────►│ cca remote serve  │
 └─────────────────┘                 └──────────────────────┘                │  ├ Hub            │
        ▲                                                                    │  ├ SessionManager │──► claude (Agent SDK)
        │ ws://127.0.0.1:48712/ws (plaintext, loopback / LAN)                │  └ accounts, fs   │      one per session
        └────────────────────────────────────────────────────────────────────┘
```

* **Direct** transport: the daemon listens on loopback (and on every interface
  with `--lan`). Frames are plain JSON; the pairing token in `hello` is the
  only authentication, so LAN listening is off by default.
* **Relay** transport: the daemon keeps one outbound socket to
  `/v1/daemon/<deviceId>`; apps connect to `/v1/client/<deviceId>`. The Worker
  forwards `{c, e}` frames where `e` is an AES-256-GCM envelope
  (`{v:1, n: nonce, c: ciphertext||tag}`, base64url, AAD = deviceId) under the
  key from the QR. The Worker stores only SHA-256 hashes of the two tokens.

## Pairing

`cca remote pair` prints `ccaremote://pair#<base64url JSON>`:

```json
{ "v": 1, "deviceId": "…", "clientToken": "…", "e2eKey": "…",
  "relayUrl": "wss://…", "directUrl": "ws://192.168.0.5:48712", "hostname": "MacBook-Pro.local" }
```

Every paired device shares the same key; `--rotate` re-keys and invalidates
them all. Secrets live in `~/.ccacc/remote/identity.json` (mode 600) on the Mac
and in the Keychain on the app side.

## Framing

```jsonc
{ "id": "c12", "method": "sessions.send", "params": { "sessionId": "…", "text": "…" } }   // request
{ "id": "c12", "ok": true,  "result": { "session": { … } } }                             // response
{ "id": "c12", "ok": false, "error": { "code": "not_found", "message": "…" } }
{ "event": "session.delta", "params": { "sessionId": "…", "itemId": "…", "text": "pon" } }  // push
```

Error codes: `unauthorized`, `bad_request`, `not_found`, `conflict`,
`unavailable`, `internal`. Requests before a successful `hello` get
`unauthorized`; a rejected `hello` closes a direct socket with 4001.

## Methods

| method | purpose |
| --- | --- |
| `hello {protocol, token, clientName, clientId}` | authenticate; returns `DaemonInfo` |
| `daemon.info` | versions, hostname, relay state |
| `accounts.list {fresh?}` · `accounts.use {name}` · `accounts.refresh` | cca profiles with 5h / 7d windows; set the active one |
| `models.list` | what Claude Code offers this account, with supported effort levels |
| `projects.list` · `fs.list {path}` | directories Claude Code has seen; a folder browser |
| `sessions.list` | managed sessions plus external (`claude` in a terminal, `claude --bg`) |
| `sessions.history {cwd?, limit?}` | resumable transcripts from `~/.claude/projects` |
| `sessions.create {cwd, profile?, model?, effort?, permissionMode?, name?, prompt?, resumeClaudeSessionId?}` | start (or resume) a session |
| `sessions.get` · `sessions.items {limit?, before?}` | detail and the normalized transcript |
| `sessions.send {text}` · `sessions.interrupt` · `sessions.stop` · `sessions.delete` · `sessions.rename` | drive it |
| `sessions.setModel` · `sessions.setEffort` · `sessions.setPermissionMode` | change mid-conversation |
| `sessions.respondPermission {requestId, behavior, always?, message?}` | answer a tool prompt |
| `sessions.respondQuestion {requestId, answers}` | answer `AskUserQuestion` |
| `sessions.context` | live context-window usage |

Events: `session.updated`, `session.removed`, `session.item` (upsert by id),
`session.delta` (append to an open text/thinking item), `accounts.updated`,
`daemon.updated`.

## Session lifecycle

A managed session is one Claude Code process started through the Agent SDK
with `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointing at the profile, exactly as
`cca <profile>` does. The first start passes `sessionId`, so our id *is*
Claude Code's session id; after the idle timeout (`--idle`, default 20 min)
the process is closed and the next message starts a new one with `resume`.
Items are normalized (`src/remote/normalize.ts`) and appended to
`~/.ccacc/remote/sessions/<id>.jsonl`, so history is instant on reconnect.

`canUseTool` drives the "Waiting for you" card: a permission request or an
`AskUserQuestion` becomes `session.pending`, the state flips to
`requires_action`, and the answer flows back through `sessions.respond*`.
"Always allow" returns the SDK's own `suggestions` as `updatedPermissions`.

External sessions come from `claude agents --json --all` and are read-only.
