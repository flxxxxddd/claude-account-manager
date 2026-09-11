/**
 * Relay transport: one outbound WebSocket from the daemon to our Cloudflare
 * Worker. The Worker multiplexes every phone onto this socket and tags each
 * frame with a connection id; nothing it forwards is readable to it, because
 * both directions are sealed with the pairing key (crypto.ts).
 *
 * Wire format on the relay socket (Worker ⇄ daemon), plaintext JSON:
 *   { "sys": "client_open" | "client_close", "c": "<connId>" }   from Worker
 *   { "c": "<connId>", "e": Envelope }                            either way
 *   { "c": "*", "e": Envelope }                                   broadcast
 */
import type { Hub, Connection } from "./hub.ts";
import type { Identity } from "./identity.ts";
import type { Frame } from "./protocol.ts";
import { fromBase64Url, importKey, isEnvelope, open, seal, type Envelope } from "./crypto.ts";

interface RelayFrame {
  sys?: "client_open" | "client_close" | "hello" | "error";
  c?: string;
  e?: Envelope;
  message?: string;
}

export interface RelayClient {
  stop(): void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const KEEPALIVE_MS = 30_000;

export function startRelayClient(
  hub: Hub,
  identity: Identity,
  relayUrl: string,
  log: (line: string) => void,
): RelayClient {
  let socket: WebSocket | undefined;
  let stopped = false;
  let attempt = 0;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const clients = new Map<string, Connection>();
  const keyPromise = importKey(fromBase64Url(identity.e2eKey));

  const url = new URL(relayUrl.replace(/^http/, "ws"));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/daemon/${identity.deviceId}`;
  url.searchParams.set("token", identity.daemonToken);
  // The Worker verifies phones against this hash; the first connection claims
  // the room with it and a rotation replaces it.
  url.searchParams.set("clientToken", identity.clientToken);

  const sendRelay = (frame: RelayFrame): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const sealed = async (frame: Frame): Promise<Envelope> => seal(await keyPromise, JSON.stringify(frame), identity.deviceId);

  const dropClient = (id: string): void => {
    if (clients.delete(id)) hub.detach(`relay-${id}`);
  };

  const connect = (): void => {
    if (stopped) return;
    log(`relay: connecting to ${url.host}`);
    const ws = new WebSocket(url.toString());
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      // The Worker answers "ping" with "pong" via setWebSocketAutoResponse.
      keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, KEEPALIVE_MS);
      hub.relayConnected = true;
      hub.broadcast("daemon.updated", hub.info());
      log("relay: connected");
    };

    ws.onmessage = async (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      if (text === "pong") return;
      let frame: RelayFrame;
      try {
        frame = JSON.parse(text) as RelayFrame;
      } catch {
        return;
      }
      if (frame.sys === "error") {
        log(`relay: ${frame.message ?? "error"}`);
        return;
      }
      if (frame.sys === "client_open" && frame.c) {
        const id = frame.c;
        const connection: Connection = {
          id: `relay-${id}`,
          authenticated: false,
          send: (out) => {
            void sealed(out).then((e) => sendRelay({ c: id, e }));
          },
        };
        clients.set(id, connection);
        hub.attach(connection);
        return;
      }
      if (frame.sys === "client_close" && frame.c) {
        dropClient(frame.c);
        return;
      }
      if (!frame.c || !isEnvelope(frame.e)) return;
      const connection = clients.get(frame.c);
      if (!connection) return;
      let inner: unknown;
      try {
        inner = JSON.parse(await open(await keyPromise, frame.e, identity.deviceId));
      } catch {
        log(`relay: dropped an undecryptable frame from ${frame.c} (wrong pairing key?)`);
        return;
      }
      const response = await hub.handle(connection, inner);
      if (response) connection.send(response);
    };

    ws.onclose = (event) => {
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      if (socket === ws) socket = undefined;
      hub.relayConnected = false;
      for (const id of [...clients.keys()]) dropClient(id);
      if (stopped) return;
      hub.broadcast("daemon.updated", hub.info());
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      attempt += 1;
      log(`relay: closed (${event.code}${event.reason ? ` ${event.reason}` : ""}); retry in ${delay / 1000}s`);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      socket?.close(1000, "daemon stopping");
    },
  };
}
