/**
 * The request dispatcher shared by every transport. A connection hands in a
 * parsed frame and gets a response; events flow out through `broadcast`.
 * Transports (direct WebSocket, relay) only move bytes and check the token.
 */
import { hostname, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAccounts, useAccount } from "./accounts.ts";
import { listExternalSessions } from "./external.ts";
import { listDirectory, listProjects } from "./projects.ts";
import {
  PROTOCOL_VERSION,
  type Session,
  type DaemonInfo,
  type ErrorCode,
  type Events,
  type Frame,
  type Methods,
  type Request,
  type Response,
  isRequest,
} from "./protocol.ts";
import { SessionError, SessionManager, claudeExecutable, transcriptItems } from "./sessions.ts";
import type { Identity } from "./identity.ts";
import { tokensEqual } from "./crypto.ts";

const execFileAsync = promisify(execFile);

export interface Connection {
  id: string;
  clientName?: string;
  authenticated: boolean;
  send: (frame: Frame) => void;
}

export interface HubOptions {
  identity: Identity;
  daemonVersion: string;
  idleTimeoutSec: number;
  directUrl?: string;
  log: (line: string) => void;
}

export class Hub {
  readonly sessions: SessionManager;
  private connections = new Map<string, Connection>();
  private claudeVersion?: string;
  relayConnected = false;
  private accountsTimer?: ReturnType<typeof setInterval>;
  /** Last `claude agents` snapshot, so `sessions.get`/`items` can answer for ext: ids. */
  private external = new Map<string, Session>();

  constructor(private readonly options: HubOptions) {
    this.sessions = new SessionManager({
      idleTimeoutSec: options.idleTimeoutSec,
      emit: (event, params) => this.broadcast(event, params),
      log: options.log,
    });
    void this.probeClaudeVersion();
  }

  private async probeClaudeVersion(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(await claudeExecutable(), ["--version"], { timeout: 10_000 });
      this.claudeVersion = stdout.trim().split(/\s+/)[0];
    } catch {
      this.claudeVersion = undefined;
    }
  }

  info(): DaemonInfo {
    return {
      protocol: PROTOCOL_VERSION,
      daemonVersion: this.options.daemonVersion,
      claudeVersion: this.claudeVersion,
      hostname: hostname(),
      platform: platform(),
      directUrl: this.options.directUrl,
      relayConnected: this.relayConnected,
    };
  }

  attach(connection: Connection): void {
    this.connections.set(connection.id, connection);
    this.options.log(`connection ${connection.id} open (${this.connections.size} total)`);
    if (this.connections.size === 1) this.startAccountsPolling();
  }

  detach(id: string): void {
    this.connections.delete(id);
    this.options.log(`connection ${id} closed (${this.connections.size} total)`);
    if (this.connections.size === 0) this.stopAccountsPolling();
  }

  broadcast<E extends keyof Events>(event: E, params: Events[E]): void {
    const frame: Frame = { event, params };
    for (const conn of this.connections.values()) {
      if (conn.authenticated) conn.send(frame);
    }
  }

  /**
   * Other accounts' windows move while the app is open; keep them current.
   * `fresh` only re-fetches entries older than 90s, one profile at a time, so
   * this costs at most one request per profile per interval.
   */
  private startAccountsPolling(): void {
    this.stopAccountsPolling();
    this.accountsTimer = setInterval(() => {
      void listAccounts({ fresh: true })
        .then((accounts) => this.broadcast("accounts.updated", { accounts }))
        .catch(() => undefined);
    }, 3 * 60_000);
  }

  private stopAccountsPolling(): void {
    if (this.accountsTimer) clearInterval(this.accountsTimer);
    this.accountsTimer = undefined;
  }

  async handle(connection: Connection, raw: unknown): Promise<Response | undefined> {
    if (!isRequest(raw)) return undefined;
    const request = raw;
    try {
      if (request.method === "hello") {
        const params = request.params as Methods["hello"]["params"];
        if (!params || !tokensEqual(params.token ?? "", this.options.identity.clientToken)) {
          return fail(request, "unauthorized", "pairing token rejected — re-pair from `cca remote pair`");
        }
        if (params.protocol !== PROTOCOL_VERSION) {
          return fail(request, "bad_request", `protocol ${params.protocol} not supported; daemon speaks ${PROTOCOL_VERSION}`);
        }
        connection.authenticated = true;
        connection.clientName = params.clientName;
        this.options.log(`${connection.id} is ${params.clientName} (${params.clientId})`);
        return ok(request, this.info());
      }
      if (!connection.authenticated) return fail(request, "unauthorized", "say hello first");
      return ok(request, await this.dispatch(request));
    } catch (err) {
      if (err instanceof SessionError) return fail(request, err.code, err.message);
      const message = err instanceof Error ? err.message : String(err);
      this.options.log(`${request.method} failed: ${message}`);
      return fail(request, "internal", message);
    }
  }

  private async dispatch(request: Request): Promise<unknown> {
    const p = (request.params ?? {}) as Record<string, unknown>;
    const method = request.method as keyof Methods;
    switch (method) {
      case "daemon.info":
        return this.info();

      case "accounts.list":
        return { accounts: await listAccounts({ fresh: (p as { fresh?: boolean }).fresh }) };
      case "accounts.use": {
        await useAccount(need(p, "name"));
        const accounts = await listAccounts();
        this.broadcast("accounts.updated", { accounts });
        return { accounts };
      }
      case "accounts.refresh": {
        const accounts = await listAccounts({ fresh: true });
        this.broadcast("accounts.updated", { accounts });
        return { accounts };
      }

      case "models.list":
        return { models: await this.sessions.models() };
      case "projects.list":
        return { projects: await listProjects() };
      case "fs.list":
        return listDirectory(need(p, "path"));

      case "sessions.list": {
        const managed = await this.sessions.list();
        const external = await listExternalSessions(this.sessions.managedClaudeIds());
        this.external = new Map(external.map((s) => [s.id, s]));
        return { sessions: [...managed, ...external] };
      }
      case "sessions.history": {
        const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
        const q = p as { cwd?: string; limit?: number };
        const entries = await listSessions({ dir: q.cwd, limit: q.limit ?? 50 });
        return {
          entries: entries.map((e) => ({
            claudeSessionId: e.sessionId,
            cwd: e.cwd ?? q.cwd ?? "",
            summary: e.customTitle ?? e.summary,
            firstPrompt: e.firstPrompt,
            gitBranch: e.gitBranch,
            lastModified: new Date(e.lastModified).toISOString(),
            createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : undefined,
          })),
        };
      }
      case "sessions.create":
        return { session: await this.sessions.create({ ...(p as Methods["sessions.create"]["params"]), cwd: need(p, "cwd") }) };
      case "sessions.get": {
        const id = need(p, "sessionId");
        return { session: (await this.externalSession(id)) ?? (await this.sessions.get(id)) };
      }
      case "sessions.items": {
        const q = p as { sessionId: string; limit?: number; before?: string };
        const id = need(p, "sessionId");
        const ext = await this.externalSession(id);
        let items = ext
          ? await transcriptItems(ext.claudeSessionId!, ext.cwd, ext.createdAt).catch(() => [])
          : await this.sessions.items(id);
        if (q.before) {
          const idx = items.findIndex((i) => i.id === q.before);
          if (idx >= 0) items = items.slice(0, idx);
        }
        const limit = q.limit ?? 200;
        const hasMore = items.length > limit;
        return { items: hasMore ? items.slice(items.length - limit) : items, hasMore };
      }
      case "sessions.send":
        return { session: await this.sessions.send(need(p, "sessionId"), need(p, "text")) };
      case "sessions.interrupt":
        return { session: await this.sessions.interrupt(need(p, "sessionId")) };
      case "sessions.stop":
        return { session: await this.sessions.stop(need(p, "sessionId")) };
      case "sessions.delete":
        await this.sessions.remove(need(p, "sessionId"));
        return { deleted: true };
      case "sessions.rename":
        return { session: await this.sessions.rename(need(p, "sessionId"), need(p, "name")) };
      case "sessions.setModel":
        return { session: await this.sessions.setModel(need(p, "sessionId"), need(p, "model")) };
      case "sessions.setEffort":
        return { session: await this.sessions.setEffort(need(p, "sessionId"), need(p, "effort")) };
      case "sessions.setPermissionMode":
        return { session: await this.sessions.setPermissionMode(need(p, "sessionId"), need(p, "mode")) };
      case "sessions.respondPermission": {
        const q = p as Methods["sessions.respondPermission"]["params"];
        return {
          session: await this.sessions.respondPermission(need(p, "sessionId"), need(p, "requestId"), q.behavior, q.always === true, q.message),
        };
      }
      case "sessions.respondQuestion": {
        const q = p as Methods["sessions.respondQuestion"]["params"];
        return { session: await this.sessions.respondQuestion(need(p, "sessionId"), need(p, "requestId"), q.answers ?? {}) };
      }
      case "sessions.context":
        return this.sessions.contextUsage(need(p, "sessionId"));

      default:
        throw new SessionError("bad_request", `unknown method ${String(method)}`);
    }
  }

  /** Resolve an `ext:` id from the last snapshot, refreshing it once if unknown. */
  private async externalSession(id: string): Promise<Session | undefined> {
    if (!id.startsWith("ext:")) return undefined;
    if (!this.external.has(id)) {
      const external = await listExternalSessions(this.sessions.managedClaudeIds());
      this.external = new Map(external.map((s) => [s.id, s]));
    }
    return this.external.get(id);
  }

  async shutdown(): Promise<void> {
    this.stopAccountsPolling();
    await this.sessions.shutdown();
  }
}

function need<T = string>(params: Record<string, unknown>, key: string): T {
  const value = params[key];
  if (value === undefined || value === null || value === "") throw new SessionError("bad_request", `missing "${key}"`);
  return value as T;
}

function ok(request: Request, result: unknown): Response {
  return { id: request.id, ok: true, result };
}

function fail(request: Request, code: ErrorCode, message: string): Response {
  return { id: request.id, ok: false, error: { code, message } };
}
