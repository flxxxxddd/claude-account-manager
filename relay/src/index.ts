/**
 * CCA Remote relay — a Cloudflare Worker that lets a phone reach the
 * `cca remote` daemon on a Mac that has no public address.
 *
 * The daemon keeps one outbound WebSocket open to its Room; phones open
 * theirs. The Room forwards frames between them, tagging each with the phone's
 * connection id so the daemon can answer the right one. Frames are sealed
 * end-to-end by the daemon and the app (AES-256-GCM, key from the pairing QR),
 * so this code never sees a request, a reply or a token that would let it
 * impersonate either side.
 *
 * Routes:
 *   GET /v1/daemon/:deviceId?token=…   the Mac
 *   GET /v1/client/:deviceId?token=…   a phone or another Mac
 *   GET /health
 *
 * Auth: the first daemon to connect claims the room and its two tokens are
 * stored hashed. Later connections must present matching tokens. Rotating the
 * keys (`cca remote pair --rotate`) re-claims with the daemon's new token,
 * which the old daemon token authorises.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
}

interface Attachment {
  role: "daemon" | "client";
  id: string;
}

interface RelayFrame {
  sys?: "client_open" | "client_close" | "hello" | "error";
  c?: string;
  e?: unknown;
  message?: string;
}

const ROUTE = /^\/v1\/(daemon|client)\/([a-f0-9]{16,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "cca-remote-relay" });

    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const deviceId = match[2]!;
    const room = env.ROOMS.get(env.ROOMS.idFromName(deviceId));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Room implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const role = match[1] as "daemon" | "client";
    const token = url.searchParams.get("token") ?? bearer(request);
    if (!token) return new Response("missing token", { status: 401 });

    const ok = role === "daemon" ? await this.authDaemon(token, url.searchParams.get("clientToken")) : await this.authClient(token);
    if (!ok) return new Response("unauthorized", { status: 401 });

    if (role === "daemon" && this.daemon()) {
      // A second daemon for the same room replaces the first (a restart that
      // outran the old socket's close). Tell the old one why.
      for (const ws of this.state.getWebSockets("daemon")) ws.close(4000, "replaced by a newer daemon connection");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(server, [role, role === "client" ? `client:${id}` : "daemon"]);
    server.serializeAttachment({ role, id } satisfies Attachment);

    if (role === "client") {
      this.daemon()?.send(JSON.stringify({ sys: "client_open", c: id } satisfies RelayFrame));
      if (!this.daemon()) server.send(JSON.stringify({ sys: "error", message: "daemon offline" } satisfies RelayFrame));
    } else {
      // Late-joining daemon learns about phones already waiting.
      for (const ws of this.state.getWebSockets("client")) {
        const att = ws.deserializeAttachment() as Attachment;
        server.send(JSON.stringify({ sys: "client_open", c: att.id } satisfies RelayFrame));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * First daemon claims the room. `clientToken` travels alongside so the room
   * can verify phones without ever seeing the pairing key.
   */
  private async authDaemon(token: string, clientToken: string | null): Promise<boolean> {
    const stored = await this.state.storage.get<string>("daemonHash");
    const hash = await sha256(token);
    if (!stored) {
      if (!clientToken) return false;
      await this.state.storage.put({ daemonHash: hash, clientHash: await sha256(clientToken), claimedAt: Date.now() });
      return true;
    }
    if (stored !== hash) return false;
    // Same daemon may present a rotated client token; adopt it.
    if (clientToken) await this.state.storage.put("clientHash", await sha256(clientToken));
    return true;
  }

  private async authClient(token: string): Promise<boolean> {
    const stored = await this.state.storage.get<string>("clientHash");
    return stored !== undefined && stored === (await sha256(token));
  }

  private daemon(): WebSocket | undefined {
    return this.state.getWebSockets("daemon")[0];
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text.length > 4_000_000) {
      ws.close(1009, "frame too large");
      return;
    }
    if (att.role === "client") {
      const daemon = this.daemon();
      if (!daemon) {
        ws.send(JSON.stringify({ sys: "error", message: "daemon offline" } satisfies RelayFrame));
        return;
      }
      // Re-tag: clients send {e} and the daemon needs to know from whom.
      let frame: RelayFrame;
      try {
        frame = JSON.parse(text) as RelayFrame;
      } catch {
        return;
      }
      daemon.send(JSON.stringify({ c: att.id, e: frame.e } satisfies RelayFrame));
      return;
    }
    // From the daemon: route by connection id, "*" broadcasts.
    let frame: RelayFrame;
    try {
      frame = JSON.parse(text) as RelayFrame;
    } catch {
      return;
    }
    if (frame.c === "*") {
      for (const client of this.state.getWebSockets("client")) client.send(JSON.stringify({ e: frame.e }));
      return;
    }
    if (!frame.c) return;
    const target = this.state.getWebSockets(`client:${frame.c}`)[0];
    target?.send(JSON.stringify({ e: frame.e }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === "client") {
      this.daemon()?.send(JSON.stringify({ sys: "client_close", c: att.id } satisfies RelayFrame));
    } else {
      for (const client of this.state.getWebSockets("client")) {
        client.send(JSON.stringify({ sys: "error", message: `daemon offline (${code}${reason ? ` ${reason}` : ""})` } satisfies RelayFrame));
      }
    }
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}
