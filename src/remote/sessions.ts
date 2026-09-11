/**
 * Managed sessions: Claude Code processes this daemon drives through the
 * Agent SDK, one per session, each pinned to a cca profile via
 * CLAUDE_SECURESTORAGE_CONFIG_DIR exactly like `cca <profile>` does.
 *
 * A session's Claude process lives while it is busy or recently used and is
 * closed after `idleTimeoutSec`; the next message resumes the same Claude
 * session id, so the conversation continues where it left off (verified on
 * 2.1.269: `sessionId` on the first start and `resume` afterwards land in the
 * same ~/.claude/projects transcript).
 */
import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { profileEnv } from "../cc-paths.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { Normalizer, summarizeToolInput } from "./normalize.ts";
import type {
  ChatItem,
  EffortLevel,
  Events,
  PendingRequest,
  PermissionMode,
  Question,
  Session,
} from "./protocol.ts";
import { gitBranch } from "./projects.ts";
import { appendItem, deleteItems, loadSessions, readItems, saveSessions } from "./store.ts";

const execFileAsync = promisify(execFile);

export type Emit = <E extends keyof Events>(event: E, params: Events[E]) => void;

export class SessionError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "bad_request" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

interface Pending {
  request: PendingRequest;
  /** The SDK's "always allow" rule set for this call, when it offered one. */
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

/** A push-based async iterable: the SDK pulls user turns as we enqueue them. */
class TurnQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.queue.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

interface Runtime {
  query: Query;
  turns: TurnQueue;
  normalizer: Normalizer;
  pending: Map<string, Pending>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Resolves when the SDK stream ends, so stop() can await teardown. */
  finished: Promise<void>;
}

export interface SessionManagerOptions {
  idleTimeoutSec: number;
  emit: Emit;
  log: (line: string) => void;
}

let cachedClaudePath: string | undefined;

/**
 * The SDK bundles its own Claude Code binary; we point it at the one the user
 * runs so plugins, settings and the credential slot match `cca` exactly.
 */
export async function claudeExecutable(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath;
  if (process.env.CCA_CLAUDE_BIN) return (cachedClaudePath = process.env.CCA_CLAUDE_BIN);
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-lc", "command -v claude"], { timeout: 5_000 });
    const found = stdout.trim();
    if (found) return (cachedClaudePath = found);
  } catch {
    /* fall through */
  }
  return (cachedClaudePath = "claude");
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private runtimes = new Map<string, Runtime>();
  private ready: Promise<void>;

  constructor(private readonly options: SessionManagerOptions) {
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    for (const session of await loadSessions()) {
      // Nothing survives a daemon restart as a live process.
      if (session.state === "running" || session.state === "requires_action" || session.state === "starting") {
        session.state = "idle";
        session.pending = undefined;
      }
      this.sessions.set(session.id, session);
    }
  }

  private async persist(): Promise<void> {
    try {
      await saveSessions([...this.sessions.values()]);
    } catch (err) {
      this.options.log(`could not save sessions.json: ${(err as Error).message}`);
    }
  }

  private touch(session: Session, patch: Partial<Session> = {}): Session {
    const next = { ...session, ...patch, updatedAt: new Date().toISOString() };
    this.sessions.set(next.id, next);
    this.options.emit("session.updated", { session: next });
    void this.persist();
    return next;
  }

  async list(): Promise<Session[]> {
    await this.ready;
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Session> {
    await this.ready;
    const session = this.sessions.get(id);
    if (!session) throw new SessionError("not_found", `no session ${id}`);
    return session;
  }

  async items(id: string): Promise<ChatItem[]> {
    await this.get(id);
    return readItems(id);
  }

  managedClaudeIds(): Set<string> {
    return new Set([...this.sessions.values()].map((s) => s.claudeSessionId ?? s.id));
  }

  async create(params: {
    cwd: string;
    profile?: string;
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    name?: string;
    prompt?: string;
    resumeClaudeSessionId?: string;
  }): Promise<Session> {
    await this.ready;
    const config = await loadConfig();
    const profile = params.profile ?? config.activeProfile;
    if (!profile || !config.profiles[profile]) {
      throw new SessionError("bad_request", `unknown profile "${profile ?? ""}" — run \`cca list\` on the Mac`);
    }
    const id = params.resumeClaudeSessionId ?? crypto.randomUUID();
    if (this.sessions.has(id)) throw new SessionError("conflict", `session ${id} already exists`);

    const now = new Date().toISOString();
    const session: Session = {
      id,
      name: params.name?.trim() || (params.prompt ? titleFrom(params.prompt) : basename(params.cwd)),
      cwd: params.cwd,
      profile,
      model: params.model,
      effort: params.effort,
      permissionMode: params.permissionMode ?? "default",
      state: "idle",
      createdAt: now,
      updatedAt: now,
      kind: "managed",
      claudeSessionId: id,
      gitBranch: await gitBranch(params.cwd),
    };
    this.sessions.set(id, session);
    await this.persist();
    this.options.emit("session.updated", { session });

    if (params.resumeClaudeSessionId) {
      // Seed our item log from Claude Code's transcript so the app has history.
      await this.importTranscript(session);
    }
    if (params.prompt) await this.send(id, params.prompt);
    return this.sessions.get(id)!;
  }

  private async importTranscript(session: Session): Promise<void> {
    try {
      const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
      const messages = await getSessionMessages(session.id, { dir: session.cwd, limit: 400 });
      const normalizer = new Normalizer(session.id);
      let count = 0;
      for (const msg of messages) {
        const m = msg.message as { role?: string; content?: unknown };
        if (msg.type === "user" && m && typeof m.content === "string") {
          await appendItem({
            id: `hist-${msg.uuid}`,
            sessionId: session.id,
            ts: (msg as { timestamp?: string }).timestamp ?? session.createdAt,
            role: "user",
            kind: "text",
            text: m.content,
            done: true,
          });
          count++;
          continue;
        }
        const wrapped = { ...(msg as unknown as Record<string, unknown>), parent_tool_use_id: null } as unknown as SDKMessage;
        const { items } = normalizer.handle(wrapped);
        for (const item of items) {
          await appendItem(item);
          count++;
        }
      }
      this.options.log(`imported ${count} items into ${session.id} from transcript`);
    } catch (err) {
      this.options.log(`transcript import failed for ${session.id}: ${(err as Error).message}`);
    }
  }

  async send(id: string, text: string): Promise<Session> {
    let session = await this.get(id);
    if (session.kind !== "managed") throw new SessionError("bad_request", "only managed sessions accept messages");
    const trimmed = text.trim();
    if (!trimmed) throw new SessionError("bad_request", "empty message");

    const userItem: ChatItem = {
      id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: id,
      ts: new Date().toISOString(),
      role: "user",
      kind: "text",
      text: trimmed,
      done: true,
    };
    await appendItem(userItem);
    this.options.emit("session.item", { item: userItem });

    if (session.name === basename(session.cwd) && !session.preview) {
      session = this.touch(session, { name: titleFrom(trimmed) });
    }

    const runtime = this.runtimes.get(id) ?? (await this.start(session));
    this.clearIdle(runtime);
    runtime.turns.push({
      type: "user",
      message: { role: "user", content: trimmed },
      parent_tool_use_id: null,
      session_id: id,
    });
    return this.touch(this.sessions.get(id)!, { state: "running", error: undefined });
  }

  private async start(session: Session): Promise<Runtime> {
    const config = await loadConfig();
    const profile = config.profiles[session.profile ?? ""];
    if (!profile) throw new SessionError("bad_request", `profile "${session.profile}" no longer exists`);

    const turns = new TurnQueue();
    const pending = new Map<string, Pending>();
    const normalizer = new Normalizer(session.id);
    const hasHistory = (await readItems(session.id)).some((i) => i.role === "assistant");

    const options: Options = {
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode as Options["permissionMode"],
      allowDangerouslySkipPermissions: session.permissionMode === "bypassPermissions",
      env: { ...process.env, ...profileEnv(profile.dir, profile.mode), CLAUDE_CODE_ENTRYPOINT: "cca-remote" },
      pathToClaudeCodeExecutable: await claudeExecutable(),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      ...(hasHistory ? { resume: session.id } : { sessionId: session.id }),
      canUseTool: (toolName, input, opts) => this.askPermission(session.id, pending, toolName, input, opts),
      stderr: (line) => this.options.log(`[${session.id.slice(0, 8)}] ${line.trimEnd()}`),
    };

    this.touch(session, { state: "starting" });
    const q = query({ prompt: turns, options });
    const runtime: Runtime = { query: q, turns, normalizer, pending, finished: Promise.resolve() };
    this.runtimes.set(session.id, runtime);
    runtime.finished = this.pump(session.id, runtime);
    return runtime;
  }

  private async pump(id: string, runtime: Runtime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        await this.onMessage(id, runtime, message);
      }
      const session = this.sessions.get(id);
      if (session && session.state !== "stopped" && session.state !== "error") this.touch(session, { state: "idle", pending: undefined });
    } catch (err) {
      const session = this.sessions.get(id);
      const message = err instanceof Error ? err.message : String(err);
      this.options.log(`session ${id} failed: ${message}`);
      if (session) {
        this.touch(session, { state: "error", error: message, pending: undefined });
        const item: ChatItem = {
          id: `err-${Date.now().toString(36)}`,
          sessionId: id,
          ts: new Date().toISOString(),
          role: "system",
          kind: "error",
          text: message,
          done: true,
        };
        await appendItem(item);
        this.options.emit("session.item", { item });
      }
    } finally {
      for (const p of runtime.pending.values()) p.resolve({ behavior: "deny", message: "session ended" });
      runtime.pending.clear();
      this.clearIdle(runtime);
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    }
  }

  private async onMessage(id: string, runtime: Runtime, message: SDKMessage): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    if (message.type === "system" && message.subtype === "init") {
      this.touch(session, {
        state: "running",
        model: message.model,
        effort: message.effort ?? session.effort,
        permissionMode: message.permissionMode as PermissionMode,
        claudeSessionId: message.session_id,
      });
      return;
    }
    if (message.type === "system" && message.subtype === "session_state_changed") {
      if (message.state === "idle" && session.state !== "requires_action") this.touch(session, { state: "idle" });
      else if (message.state === "running") this.touch(session, { state: "running", pending: undefined });
      return;
    }
    if (message.type === "system" && message.subtype === "status" && message.permissionMode) {
      if (message.permissionMode !== session.permissionMode) this.touch(session, { permissionMode: message.permissionMode as PermissionMode });
    }
    if (message.type === "assistant" && message.context_usage) {
      this.sessions.set(id, { ...session, contextPercent: message.context_usage.percentage });
    }

    const { items, deltas } = runtime.normalizer.handle(message);
    for (const delta of deltas) this.options.emit("session.delta", { sessionId: id, itemId: delta.itemId, text: delta.text });
    for (const item of items) {
      await appendItem(item);
      this.options.emit("session.item", { item });
    }

    const lastText = [...items].reverse().find((i) => i.kind === "text" && i.role === "assistant" && i.done && i.text);
    if (lastText) this.sessions.set(id, { ...this.sessions.get(id)!, preview: lastText.text!.slice(0, 200) });

    if (message.type === "result") {
      const current = this.sessions.get(id)!;
      this.touch(current, {
        state: "idle",
        pending: undefined,
        totalCostUsd: message.total_cost_usd,
        error: message.is_error ? ("errors" in message ? message.errors.join("; ") : message.subtype) : undefined,
      });
      this.armIdle(id, runtime);
    }
  }

  private askPermission(
    id: string,
    pending: Map<string, Pending>,
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<NonNullable<Options["canUseTool"]>>[2],
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const request: PendingRequest =
        toolName === "AskUserQuestion"
          ? {
              kind: "question",
              requestId,
              toolUseId: opts.toolUseID,
              questions: (input.questions as Question[]) ?? [],
              createdAt: new Date().toISOString(),
            }
          : {
              kind: "permission",
              requestId,
              toolName,
              toolUseId: opts.toolUseID,
              input,
              summary: summarizeToolInput(toolName, input),
              decisionReason: opts.decisionReason,
              canAlwaysAllow: (opts.suggestions?.length ?? 0) > 0,
              createdAt: new Date().toISOString(),
            };

      const answer = (result: PermissionResult): void => {
        pending.delete(requestId);
        const session = this.sessions.get(id);
        if (session && session.pending?.requestId === requestId) this.touch(session, { state: "running", pending: undefined });
        resolve(result);
      };
      pending.set(requestId, { request, suggestions: opts.suggestions, resolve: answer });
      opts.signal.addEventListener("abort", () => answer({ behavior: "deny", message: "cancelled" }), { once: true });

      const session = this.sessions.get(id);
      if (session) this.touch(session, { state: "requires_action", pending: request });
    });
  }

  async respondPermission(id: string, requestId: string, behavior: "allow" | "deny", always: boolean, message?: string): Promise<Session> {
    const runtime = this.runtimes.get(id);
    const pending = runtime?.pending.get(requestId);
    if (!runtime || !pending || pending.request.kind !== "permission") throw new SessionError("not_found", "that request is no longer open");
    if (behavior === "allow") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.request.input,
        updatedPermissions: always ? pending.suggestions : undefined,
      });
    } else {
      pending.resolve({ behavior: "deny", message: message ?? "Denied from CCA Remote" });
    }
    return this.get(id);
  }

  async respondQuestion(id: string, requestId: string, answers: Record<string, string>): Promise<Session> {
    const runtime = this.runtimes.get(id);
    const pending = runtime?.pending.get(requestId);
    if (!runtime || !pending || pending.request.kind !== "question") throw new SessionError("not_found", "that question is no longer open");
    pending.resolve({ behavior: "allow", updatedInput: { questions: pending.request.questions, answers } });
    return this.get(id);
  }

  async interrupt(id: string): Promise<Session> {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      for (const [requestId, p] of runtime.pending) {
        p.resolve({ behavior: "deny", message: "interrupted", interrupt: true });
        runtime.pending.delete(requestId);
      }
      await runtime.query.interrupt().catch(() => undefined);
    }
    return this.get(id);
  }

  /** Close the Claude process; the conversation resumes on the next message. */
  async stop(id: string): Promise<Session> {
    const session = await this.get(id);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      this.clearIdle(runtime);
      runtime.turns.close();
      runtime.query.close();
      this.runtimes.delete(id);
    }
    return this.touch(session, { state: "stopped", pending: undefined });
  }

  async remove(id: string): Promise<void> {
    await this.stop(id).catch(() => undefined);
    this.sessions.delete(id);
    await deleteItems(id);
    await this.persist();
    this.options.emit("session.removed", { sessionId: id });
  }

  async rename(id: string, name: string): Promise<Session> {
    const session = await this.get(id);
    return this.touch(session, { name: name.trim() || session.name });
  }

  async setModel(id: string, model: string): Promise<Session> {
    const session = await this.get(id);
    await this.runtimes.get(id)?.query.setModel(model);
    return this.touch(session, { model });
  }

  async setEffort(id: string, effort: EffortLevel): Promise<Session> {
    const session = await this.get(id);
    await this.runtimes.get(id)?.query.applyFlagSettings({ effortLevel: effort });
    return this.touch(session, { effort });
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<Session> {
    const session = await this.get(id);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      if (mode === "bypassPermissions" && session.permissionMode !== "bypassPermissions") {
        // The flag is fixed at spawn; the process must restart to gain it.
        await this.stop(id);
      } else {
        await runtime.query.setPermissionMode(mode as Parameters<Query["setPermissionMode"]>[0]);
      }
    }
    return this.touch(this.sessions.get(id)!, { permissionMode: mode, state: this.runtimes.has(id) ? this.sessions.get(id)!.state : "idle" });
  }

  async contextUsage(id: string): Promise<{ percentage: number; totalTokens: number; maxTokens: number; model: string }> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new SessionError("unavailable", "session is not running");
    const usage = await runtime.query.getContextUsage({ detail: "summary" });
    return { percentage: usage.percentage, totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, model: usage.model };
  }

  async models(): Promise<{ value: string; displayName: string; description?: string; efforts: EffortLevel[] }[]> {
    // Any live runtime can answer; otherwise spin up nothing and return the
    // aliases Claude Code accepts on every plan.
    const runtime = [...this.runtimes.values()][0];
    if (runtime) {
      try {
        const models = await runtime.query.supportedModels();
        return models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          efforts: ((m as { supportedEffortLevels?: EffortLevel[] }).supportedEffortLevels ?? DEFAULT_EFFORTS) as EffortLevel[],
        }));
      } catch {
        /* fall through */
      }
    }
    return FALLBACK_MODELS;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.stop(id).catch(() => undefined);
  }

  private armIdle(id: string, runtime: Runtime): void {
    this.clearIdle(runtime);
    runtime.idleTimer = setTimeout(() => {
      const session = this.sessions.get(id);
      if (!session || session.state !== "idle" || this.runtimes.get(id) !== runtime) return;
      this.options.log(`idle timeout: closing ${id}`);
      runtime.turns.close();
      runtime.query.close();
      this.runtimes.delete(id);
      // Stays "idle", not "stopped": from the app's point of view nothing changed.
    }, this.options.idleTimeoutSec * 1000);
  }

  private clearIdle(runtime: Runtime): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }
}

const DEFAULT_EFFORTS: EffortLevel[] = ["low", "medium", "high"];

const FALLBACK_MODELS = [
  { value: "default", displayName: "Default", description: "Whatever the account's plan recommends", efforts: ["low", "medium", "high", "xhigh", "max"] as EffortLevel[] },
  { value: "fable", displayName: "Fable 5.1", description: "For your toughest challenges", efforts: ["low", "medium", "high", "xhigh", "max"] as EffortLevel[] },
  { value: "opus", displayName: "Opus 5", description: "For complex tasks", efforts: ["low", "medium", "high", "xhigh", "max"] as EffortLevel[] },
  { value: "sonnet", displayName: "Sonnet 5", description: "Most efficient for everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"] as EffortLevel[] },
  { value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers", efforts: [] as EffortLevel[] },
];

/** First line of the first prompt, the way Claude Code titles a transcript. */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Keep `saveConfig` reachable for callers that toggle the active profile. */
export { saveConfig };
