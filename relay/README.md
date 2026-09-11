# cca-remote-relay

The Cloudflare Worker that carries frames between the `cca remote` daemon on a
Mac and the CCA Remote app when they are not on the same network. It forwards
ciphertext only: every frame is sealed end-to-end with the key from the pairing
QR code, so the relay can neither read nor forge traffic.

## Deploy

```bash
cd relay
bun install
bunx wrangler login
bunx wrangler deploy          # prints https://cca-remote-relay.<you>.workers.dev
```

Then on the Mac:

```bash
cca remote config --relay wss://cca-remote-relay.<you>.workers.dev
cca remote install            # or re-run `cca remote serve`
cca remote pair               # new QR carries the relay URL
```

## Local run

```bash
bunx wrangler dev --port 8787
cca remote serve --relay ws://127.0.0.1:8787
```

Durable Objects run in miniflare locally; no login needed.

## What it stores

Per device id: SHA-256 of the daemon token and of the client token, plus the
claim time. Nothing else — not the pairing key, not a single message.
