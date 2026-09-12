/**
 * Wire protocol between the `cca remote` daemon and the CCA Remote apps.
 *
 * One JSON object per WebSocket text frame. The client sends requests, the
 * daemon answers each by `id` and pushes events in between. The same frames
 * travel over the relay, wrapped in an end-to-end encrypted envelope (see
 * crypto.ts), so nothing here assumes the transport is trusted.
 *
 * Keep this file in step with apps/CCARemote/Sources/Protocol/*.swift and
 * docs/remote-protocol.md. Bump PROTOCOL_VERSION on any breaking change.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export interface Request<M extends string = string, P = unknown> {
  id: string;
  method: M;
  params?: P;
}

export interface ResponseOk<R = unknown> {
  id: string;
  ok: true;
  result: R;
}

export interface ResponseErr {
  id: string;
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type Response = ResponseOk | ResponseErr;

export interface Event<E extends string = string, P = unknown> {
  event: E;
  params: P;
}

export type Frame = Request | Response | Event;

export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal";

export function isRequest(frame: unknown): frame is Request {
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof (frame as Request).id === "string" &&
    typeof (frame as Request).method === "string"
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type SessionState = "idle" | "running" | "requires_action" | "starting" | "stopped" | "error";

export interface LimitWindow {
  /** 0..1 */
  utilization: number | null;
  /** ISO 8601 */
  resetsAt: string | null;
}

export interface Account {
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  active: boolean;
  loggedIn: boolean;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  sevenDayOpus?: LimitWindow | null;
  /** ISO 8601 — when the refresh token dies and only `cca login` helps. */
  loginExpiresAt?: string;
  /** ISO 8601 of the usage reading; null when never fetched. */
  usageFetchedAt: string | null;
  error?: string;
}

export interface ModelChoice {
  value: string;
  displayName: string;
  description?: string;
  /** Effort levels this model accepts; empty when it ignores effort. */
  efforts: EffortLevel[];
}

export interface PermissionRequest {
  kind: "permission";
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  /** Human-readable one-liner: the command, the file, the URL. */
  summary: string;
  decisionReason?: string;
  /** True when the daemon can offer "always allow" for this call. */
  canAlwaysAllow: boolean;
  createdAt: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionRequest {
  kind: "question";
  requestId: string;
  toolUseId?: string;
  questions: Question[];
  createdAt: string;
}

export type PendingRequest = PermissionRequest | QuestionRequest;

export interface ExternalInfo {
  /** "interactive" is a terminal `claude`, "background" a `claude --bg`. */
  kind: "interactive" | "background";
  pid?: number;
  /** Claude Code's own idle/busy word for the process. */
  status?: string;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  /** cca profile the session runs as; undefined for external sessions. */
  profile?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  /** Last assistant text, trimmed for the list row. */
  preview?: string;
  pending?: PendingRequest;
  /** "managed" sessions are driven by this daemon; "external" only observed. */
  kind: "managed" | "external";
  external?: ExternalInfo;
  gitBranch?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextMaxTokens?: number;
  totalCostUsd?: number;
  totalDurationMs?: number;
  numTurns?: number;
  /** Live windows for the account this session runs as, from the last API call. */
  limits?: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; sevenDayOpus?: LimitWindow | null };
  /** Claude Code's session UUID once the process has reported it. */
  claudeSessionId?: string;
  error?: string;
}

/** A transcript from ~/.claude/projects the app can resume. */
export interface HistoryEntry {
  claudeSessionId: string;
  cwd: string;
  summary: string;
  firstPrompt?: string;
  gitBranch?: string;
  lastModified: string;
  createdAt?: string;
}

export interface Project {
  path: string;
  name: string;
  /** ISO 8601 of the last session there, when known. */
  lastUsedAt?: string;
  gitBranch?: string;
}

export type ItemKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "result"
  | "status"
  | "error";

export interface ChatItem {
  id: string;
  sessionId: string;
  ts: string;
  role: "user" | "assistant" | "system";
  kind: ItemKind;
  /** text, thinking, status, error, and the user's own messages. */
  text?: string;
  /** tool_use */
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  /** A one-liner for the collapsed card: `bun test`, `src/foo.ts`, a URL. */
  toolSummary?: string;
  /** tool_result */
  output?: string;
  isError?: boolean;
  /** result */
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** Set once streaming is over; the app can stop the cursor. */
  done: boolean;
  /** Subagent parent, when the item came from a Task child. */
  parentToolUseId?: string;
}

export interface DaemonInfo {
  protocol: number;
  daemonVersion: string;
  claudeVersion?: string;
  hostname: string;
  platform: string;
  /** Where this daemon accepts direct connections, if anywhere. */
  directUrl?: string;
  relayConnected: boolean;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface Methods {
  hello: {
    params: { protocol: number; token: string; clientName: string; clientId: string };
    result: DaemonInfo;
  };
  "daemon.info": { params: undefined; result: DaemonInfo };

  "accounts.list": { params: { fresh?: boolean } | undefined; result: { accounts: Account[] } };
  "accounts.use": { params: { name: string }; result: { accounts: Account[] } };
  "accounts.refresh": { params: { name?: string } | undefined; result: { accounts: Account[] } };

  "models.list": { params: undefined; result: { models: ModelChoice[] } };
  "projects.list": { params: undefined; result: { projects: Project[] } };
  "fs.list": {
    params: { path: string };
    result: { path: string; parent?: string; entries: { name: string; path: string; isGit: boolean }[] };
  };

  "sessions.list": { params: undefined; result: { sessions: Session[] } };
  "sessions.history": {
    params: { cwd?: string; limit?: number };
    result: { entries: HistoryEntry[] };
  };
  "sessions.create": {
    params: {
      cwd: string;
      profile?: string;
      model?: string;
      effort?: EffortLevel;
      permissionMode?: PermissionMode;
      name?: string;
      /** First message, sent right after the session starts. */
      prompt?: string;
      /** Resume this Claude Code transcript instead of starting fresh. */
      resumeClaudeSessionId?: string;
    };
    result: { session: Session };
  };
  "sessions.get": { params: { sessionId: string }; result: { session: Session } };
  "sessions.items": {
    params: { sessionId: string; limit?: number; before?: string };
    result: { items: ChatItem[]; hasMore: boolean };
  };
  "sessions.send": { params: { sessionId: string; text: string }; result: { session: Session } };
  "sessions.interrupt": { params: { sessionId: string }; result: { session: Session } };
  "sessions.stop": { params: { sessionId: string }; result: { session: Session } };
  "sessions.delete": { params: { sessionId: string }; result: { deleted: true } };
  "sessions.rename": { params: { sessionId: string; name: string }; result: { session: Session } };
  "sessions.setModel": { params: { sessionId: string; model: string }; result: { session: Session } };
  "sessions.setEffort": { params: { sessionId: string; effort: EffortLevel }; result: { session: Session } };
  "sessions.setPermissionMode": {
    params: { sessionId: string; mode: PermissionMode };
    result: { session: Session };
  };
  "sessions.respondPermission": {
    params: {
      sessionId: string;
      requestId: string;
      behavior: "allow" | "deny";
      /** Remember the decision for the rest of the session. */
      always?: boolean;
      message?: string;
    };
    result: { session: Session };
  };
  "sessions.respondQuestion": {
    params: {
      sessionId: string;
      requestId: string;
      /** question text → chosen label(s), comma-joined for multiSelect. */
      answers: Record<string, string>;
    };
    result: { session: Session };
  };
  "sessions.context": {
    params: { sessionId: string };
    result: { percentage: number; totalTokens: number; maxTokens: number; model: string };
  };
}

export type MethodName = keyof Methods;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface Events {
  "session.updated": { session: Session };
  "session.removed": { sessionId: string };
  /** A finished or newly started item. Replaces any item with the same id. */
  "session.item": { item: ChatItem };
  /** Streaming append to a text/thinking item that is not `done` yet. */
  "session.delta": { sessionId: string; itemId: string; text: string };
  /**
   * What the running turn is doing, for the spinner line. Sent when the
   * activity changes and at most once a second otherwise; absent activity
   * means the turn ended.
   */
  "session.progress": {
    sessionId: string;
    activity?: "thinking" | "writing" | "tool" | "reading" | "waiting";
    /** Tool name while activity is "tool". */
    detail?: string;
    /** ISO 8601 of the turn's start. */
    startedAt: string;
    outputTokens: number;
  };
  "accounts.updated": { accounts: Account[] };
  "daemon.updated": DaemonInfo;
}

export type EventName = keyof Events;
