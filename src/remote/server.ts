/**
 * Direct transport: a WebSocket server on loopback (and optionally the LAN).
 * The macOS app talks to it over ws://127.0.0.1; phones on the same network
 * can too when `lan` is on. Authentication is the pairing token in `hello`.
 *
 * Two runtimes: the compiled binary runs under Bun and uses Bun.serve; the npm
 * package runs under Node, which has no WebSocket server, so it uses `ws` on a
 * plain http server. Same Hub, same frames.
 */
import type { Hub, Connection } from "./hub.ts";
import type { Frame } from "./protocol.ts";

export interface DirectServer {
  port: number;
  stop(): void;
}

export interface DirectServerOptions {
  port: number;
  lan: boolean;
  log: (line: string) => void;
}

export async function startDirectServer(hub: Hub, options: DirectServerOptions): Promise<DirectServer> {
  const server = typeof Bun !== "undefined" ? startBun(hub, options) : await startNode(hub, options);
  options.log(`direct: listening on ws://${options.lan ? "0.0.0.0" : "127.0.0.1"}:${server.port}/ws`);
  return server;
}

/** Shared per-socket behaviour so the two runtimes cannot drift. */
function attach(hub: Hub, id: string, send: (text: string) => void, close: (code: number, reason: string) => void) {
  const connection: Connection = {
    id,
    authenticated: false,
    send: (frame: Frame) => send(JSON.stringify(frame)),
  };
  hub.attach(connection);
  return {
    async message(text: string): Promise<void> {
      if (text === "ping") {
        send("pong");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const response = await hub.handle(connection, parsed);
      if (response) connection.send(response);
      // A rejected hello closes the socket so a stale token fails loudly.
      if (response && !response.ok && response.error.code === "unauthorized") close(4001, response.error.message);
    },
    close(): void {
      hub.detach(id);
    },
  };
}

type Handlers = ReturnType<typeof attach>;

function startBun(hub: Hub, options: DirectServerOptions): DirectServer {
  let counter = 0;
  const server = Bun.serve<{ handlers?: Handlers; id: string }>({
    port: options.port,
    hostname: options.lan ? "0.0.0.0" : "127.0.0.1",
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true, ...hub.info() });
      if (url.pathname !== "/ws") return new Response("cca remote daemon", { status: 404 });
      counter += 1;
      if (srv.upgrade(request, { data: { id: `direct-${counter}` } })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        ws.data.handlers = attach(
          hub,
          ws.data.id,
          (text) => {
            if (ws.readyState === 1) ws.send(text);
          },
          (code, reason) => ws.close(code, reason),
        );
      },
      async message(ws, raw) {
        await ws.data.handlers?.message(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      },
      close(ws) {
        ws.data.handlers?.close();
      },
    },
  });
  return { port: server.port ?? options.port, stop: () => server.stop(true) };
}

async function startNode(hub: Hub, options: DirectServerOptions): Promise<DirectServer> {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  let counter = 0;
  const http = createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, ...hub.info() }));
      return;
    }
    response.statusCode = request.url === "/ws" ? 426 : 404;
    response.end(request.url === "/ws" ? "expected a WebSocket upgrade" : "cca remote daemon");
  });
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) => {
    counter += 1;
    const handlers = attach(
      hub,
      `direct-${counter}`,
      (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      (code, reason) => ws.close(code, reason),
    );
    ws.on("message", (raw) => {
      void handlers.message(typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString("utf8"));
    });
    ws.on("close", () => handlers.close());
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.lan ? "0.0.0.0" : "127.0.0.1", () => resolve());
  });
  return {
    port: options.port,
    stop: () => {
      for (const client of wss.clients) client.close(1001, "daemon stopping");
      wss.close();
      http.close();
    },
  };
}
