/**
 * Direct transport: a WebSocket server on loopback (and optionally the LAN).
 * The macOS app talks to it over ws://127.0.0.1; phones on the same network
 * can too when `lan` is on. Authentication is the pairing token in `hello`.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Hub, Connection } from "./hub.ts";
import type { Frame } from "./protocol.ts";

interface SocketData {
  connection: Connection;
}

export interface DirectServer {
  port: number;
  stop(): void;
}

export function startDirectServer(hub: Hub, options: { port: number; lan: boolean; log: (line: string) => void }): DirectServer {
  let counter = 0;
  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.lan ? "0.0.0.0" : "127.0.0.1",
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, ...hub.info() });
      }
      if (url.pathname !== "/ws") return new Response("cca remote daemon", { status: 404 });
      counter += 1;
      const connection: Connection = {
        id: `direct-${counter}`,
        authenticated: false,
        send: () => undefined,
      };
      if (srv.upgrade(request, { data: { connection } })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws: ServerWebSocket<SocketData>) {
        ws.data.connection.send = (frame: Frame) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(frame));
        };
        hub.attach(ws.data.connection);
      },
      async message(ws: ServerWebSocket<SocketData>, raw) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        if (text === "ping") {
          ws.send("pong");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        const response = await hub.handle(ws.data.connection, parsed);
        if (response) ws.data.connection.send(response);
        // A rejected hello closes the socket so a stale token fails loudly.
        if (response && !response.ok && response.error.code === "unauthorized") ws.close(4001, response.error.message);
      },
      close(ws: ServerWebSocket<SocketData>) {
        hub.detach(ws.data.connection.id);
      },
    },
  });
  options.log(`direct: listening on ws://${options.lan ? "0.0.0.0" : "127.0.0.1"}:${server.port}/ws`);
  return {
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
}
