# CCA Remote

Native iOS + macOS client for the `cca remote` daemon: see every Claude Code
session on your Mac, start new ones under any cca account, answer permission
prompts and questions, switch models and effort, and watch the limit windows —
from the phone or from another Mac.

One SwiftUI code base, iOS 26 / macOS 26, Swift 6 strict concurrency.

## Build

```bash
brew install xcodegen
cd apps/CCARemote
xcodegen generate
open CCARemote.xcodeproj
```

In Xcode pick your team under *Signing & Capabilities* (a free Apple ID works:
the app is re-signed every 7 days and has no push notifications — nothing here
needs a paid account). Run the `CCARemote` scheme on your iPhone or on *My Mac*.

Command line, no signing (simulator and macOS only):

```bash
xcodebuild -scheme CCARemote -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme CCARemote -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
```

## Pair

On the Mac:

```bash
cca remote install     # launchd keeps the daemon running
cca remote pair        # QR code
```

On the iPhone: *Add device* → point the camera at the QR, or paste the
`ccaremote://pair#…` link. The Mac app finds the daemon on the same machine by
itself (it reads `~/.ccacc/remote/identity.json`).

Away from home you need the relay: deploy `relay/` once and run
`cca remote config --relay wss://<worker>.workers.dev` before pairing.

Simulator without a camera:

```bash
SIMCTL_CHILD_CCA_PAIR_LINK="$(cca remote pair --json | jq -r .url)" \
  xcrun simctl launch booted app.cca.remote
```

## Layout

```
Sources/App          entry point
Sources/Protocol     Codable mirrors of src/remote/protocol.ts, frame parsing
Sources/Networking   Envelope (AES-GCM), Direct/Relay transports, DaemonClient actor
Sources/Model        Device + Keychain secrets, AppStore (@Observable)
Sources/Views        Home (iOS), Sidebar (macOS), Session, NewSession, Model, Accounts, Pairing
```

The store keeps one `DaemonClient` per paired Mac and merges their events;
views read the store directly. Items stream in as `session.item` upserts and
`session.delta` appends, so a reply renders token by token.
