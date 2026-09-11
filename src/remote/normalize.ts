/**
 * Turn the Agent SDK's message stream into the flat ChatItem list the app
 * renders. The SDK emits partial stream events, full assistant messages that
 * repeat them, tool results wrapped in user messages, and a result summary;
 * the app wants one item per visible thing, updated in place while it streams.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatItem } from "./protocol.ts";

export interface Normalized {
  /** Items to upsert (replace by id). */
  items: ChatItem[];
  /** Streaming appends for items that are still open. */
  deltas: { itemId: string; text: string }[];
}

interface OpenBlock {
  itemId: string;
  kind: "text" | "thinking" | "tool_use";
  toolName?: string;
  toolUseId?: string;
  json: string;
}

/** Per-session streaming state: which content block index maps to which item. */
export class Normalizer {
  private open = new Map<string, OpenBlock>();
  private counter = 0;

  constructor(private readonly sessionId: string) {}

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }

  private base(role: ChatItem["role"], kind: ChatItem["kind"], parent: string | null): ChatItem {
    return {
      id: this.nextId(kind),
      sessionId: this.sessionId,
      ts: new Date().toISOString(),
      role,
      kind,
      done: true,
      parentToolUseId: parent ?? undefined,
    };
  }

  private key(parent: string | null, index: number): string {
    return `${parent ?? "main"}:${index}`;
  }

  private findOpen(parent: string | null, kind: OpenBlock["kind"], toolUseId?: string): string | undefined {
    const prefix = `${parent ?? "main"}:`;
    for (const [key, block] of this.open) {
      if (!key.startsWith(prefix) || block.kind !== kind) continue;
      if (kind === "tool_use" && toolUseId && block.toolUseId !== toolUseId) continue;
      return key;
    }
    return undefined;
  }

  handle(message: SDKMessage): Normalized {
    const out: Normalized = { items: [], deltas: [] };

    switch (message.type) {
      case "stream_event": {
        const parent = message.parent_tool_use_id;
        const ev = message.event as Record<string, unknown> & { type: string };
        if (ev.type === "content_block_start") {
          const block = ev.content_block as { type: string; name?: string; id?: string };
          const index = ev.index as number;
          const kind = block.type === "thinking" ? "thinking" : block.type === "tool_use" ? "tool_use" : block.type === "text" ? "text" : null;
          if (!kind) break;
          const item = this.base("assistant", kind, parent);
          item.done = false;
          if (kind === "tool_use") {
            item.toolName = block.name;
            item.toolUseId = block.id;
          } else {
            item.text = "";
          }
          this.open.set(this.key(parent, index), {
            itemId: item.id,
            kind,
            toolName: block.name,
            toolUseId: block.id,
            json: "",
          });
          out.items.push(item);
        } else if (ev.type === "content_block_delta") {
          const index = ev.index as number;
          const block = this.open.get(this.key(parent, index));
          if (!block) break;
          const delta = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          if (delta.type === "text_delta" && delta.text) out.deltas.push({ itemId: block.itemId, text: delta.text });
          else if (delta.type === "thinking_delta" && delta.thinking) out.deltas.push({ itemId: block.itemId, text: delta.thinking });
          else if (delta.type === "input_json_delta" && delta.partial_json) block.json += delta.partial_json;
        }
        // content_block_stop is answered by the full `assistant` message below,
        // which carries the final text and the parsed tool input.
        break;
      }

      case "assistant": {
        // Claude Code emits one `assistant` message per content block, so the
        // index inside `content` says nothing about the stream index. Match a
        // tool_use by its id and a text/thinking block by kind, oldest first.
        const parent = message.parent_tool_use_id;
        const content = message.message.content as unknown as Array<Record<string, unknown> & { type: string }>;
        for (const block of content) {
          const kind = block.type === "thinking" ? "thinking" : block.type === "tool_use" ? "tool_use" : block.type === "text" ? "text" : null;
          if (!kind) continue;
          const item = this.base("assistant", kind, parent);
          const openKey = this.findOpen(parent, kind, kind === "tool_use" ? String(block.id ?? "") : undefined);
          if (openKey) {
            item.id = this.open.get(openKey)!.itemId;
            this.open.delete(openKey);
          }
          if (kind === "text") item.text = String(block.text ?? "");
          if (kind === "thinking") item.text = String(block.thinking ?? "");
          if (kind === "tool_use") {
            item.toolName = String(block.name ?? "");
            item.toolUseId = String(block.id ?? "");
            item.toolInput = (block.input as Record<string, unknown>) ?? {};
            item.toolSummary = summarizeToolInput(item.toolName, item.toolInput);
          }
          // Redacted thinking arrives empty; the item is still finalised so the
          // app can drop the placeholder it opened while streaming.
          out.items.push(item);
        }
        if (message.error) {
          const item = this.base("system", "error", parent);
          item.text = describeAssistantError(message.error);
          out.items.push(item);
        }
        break;
      }

      case "user": {
        // Tool results come back as user messages with tool_result blocks.
        // Real user turns are echoed only with --replay-user-messages, which we
        // do not use — the daemon records those itself when it sends them.
        const content = message.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content as unknown as Array<Record<string, unknown> & { type: string }>) {
          if (block.type !== "tool_result") continue;
          const item = this.base("system", "tool_result", message.parent_tool_use_id);
          item.toolUseId = String(block.tool_use_id ?? "");
          item.isError = block.is_error === true;
          item.output = truncate(flattenContent(block.content), 20_000);
          out.items.push(item);
        }
        break;
      }

      case "result": {
        const item = this.base("system", "result", null);
        item.costUsd = message.total_cost_usd;
        item.durationMs = message.duration_ms;
        item.numTurns = message.num_turns;
        if (message.is_error) {
          item.kind = "error";
          item.text = "errors" in message ? message.errors.join("\n") : message.subtype;
        }
        out.items.push(item);
        this.open.clear();
        break;
      }

      case "system": {
        if (message.subtype === "status" && message.status === "compacting") {
          const item = this.base("system", "status", null);
          item.text = "Compacting context…";
          out.items.push(item);
        }
        break;
      }

      default:
        break;
    }
    return out;
  }
}

function describeAssistantError(error: string): string {
  switch (error) {
    case "rate_limit":
      return "Rate limited — this account's window is spent. Switch accounts or wait for the reset.";
    case "authentication_failed":
      return "Authentication failed — run `cca login <profile>` on the Mac.";
    case "billing_error":
      return "Billing error on this account.";
    case "max_output_tokens":
      return "The reply hit the output-token ceiling.";
    default:
      return `API error: ${error}`;
  }
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part: Record<string, unknown>) =>
      part.type === "text" ? String(part.text ?? "") : part.type === "image" ? "[image]" : JSON.stringify(part),
    )
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

/** The one line the collapsed tool card shows. */
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  switch (name) {
    case "Bash":
      return firstLine(str("command") ?? str("description") ?? "");
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return str("file_path") ?? str("notebook_path") ?? "";
    case "Glob":
    case "Grep":
      return [str("pattern"), str("path")].filter(Boolean).join(" in ");
    case "WebFetch":
    case "WebSearch":
      return str("url") ?? str("query") ?? "";
    case "Task":
    case "Agent":
      return str("description") ?? str("prompt")?.slice(0, 80) ?? "";
    case "Skill":
      return str("skill") ?? "";
    case "AskUserQuestion":
      return "Asking you a question";
    case "TodoWrite":
      return "Updating the plan";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ? firstLine(first).slice(0, 120) : "";
    }
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : `${text.slice(0, nl)} …`;
}
