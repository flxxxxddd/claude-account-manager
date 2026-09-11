import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Normalizer, summarizeToolInput } from "./normalize.ts";

const sid = "s1";
const ev = (event: Record<string, unknown>, parent: string | null = null): SDKMessage =>
  ({ type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: sid }) as unknown as SDKMessage;
const assistant = (content: unknown[], parent: string | null = null): SDKMessage =>
  ({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: parent, uuid: "u", session_id: sid }) as unknown as SDKMessage;

describe("Normalizer", () => {
  test("a streamed text block and its final message share one item id", () => {
    const n = new Normalizer(sid);
    const start = n.handle(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    expect(start.items).toHaveLength(1);
    expect(start.items[0]!.done).toBe(false);

    const delta = n.handle(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pon" } }));
    expect(delta.deltas).toEqual([{ itemId: start.items[0]!.id, text: "pon" }]);

    const final = n.handle(assistant([{ type: "text", text: "pong" }]));
    expect(final.items).toHaveLength(1);
    expect(final.items[0]!.id).toBe(start.items[0]!.id);
    expect(final.items[0]!.text).toBe("pong");
    expect(final.items[0]!.done).toBe(true);
  });

  test("one assistant message per block still matches by stream order", () => {
    // Claude Code sends thinking at index 0 and text at index 1 as two
    // separate `assistant` messages, each with a single-element content array.
    const n = new Normalizer(sid);
    const think = n.handle(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })).items[0]!;
    const text = n.handle(ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })).items[0]!;
    const finalThink = n.handle(assistant([{ type: "thinking", thinking: "", signature: "x" }])).items[0]!;
    const finalText = n.handle(assistant([{ type: "text", text: "done" }])).items[0]!;
    expect(finalThink.id).toBe(think.id);
    expect(finalThink.done).toBe(true);
    expect(finalText.id).toBe(text.id);
  });

  test("tool_use matches by tool id and carries a summary", () => {
    const n = new Normalizer(sid);
    const open = n.handle(ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } })).items[0]!;
    n.handle(ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }));
    const final = n.handle(assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la\necho x" } }])).items[0]!;
    expect(final.id).toBe(open.id);
    expect(final.toolSummary).toBe("ls -la …");
    expect(final.toolInput).toEqual({ command: "ls -la\necho x" });
  });

  test("tool results come out of user messages", () => {
    const n = new Normalizer(sid);
    const msg = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "hello" }], is_error: false }] },
      parent_tool_use_id: null,
      session_id: sid,
    } as unknown as SDKMessage;
    const out = n.handle(msg).items[0]!;
    expect(out.kind).toBe("tool_result");
    expect(out.toolUseId).toBe("toolu_1");
    expect(out.output).toBe("hello");
  });

  test("subagent blocks are scoped by parent tool id", () => {
    const n = new Normalizer(sid);
    const main = n.handle(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })).items[0]!;
    const child = n.handle(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "toolu_task")).items[0]!;
    const childFinal = n.handle(assistant([{ type: "text", text: "child" }], "toolu_task")).items[0]!;
    expect(childFinal.id).toBe(child.id);
    expect(childFinal.parentToolUseId).toBe("toolu_task");
    const mainFinal = n.handle(assistant([{ type: "text", text: "main" }])).items[0]!;
    expect(mainFinal.id).toBe(main.id);
  });

  test("result and error results", () => {
    const n = new Normalizer(sid);
    const ok = n.handle({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 } as unknown as SDKMessage).items[0]!;
    expect(ok.kind).toBe("result");
    expect(ok.costUsd).toBe(0.01);
    const bad = n.handle({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], total_cost_usd: 0, duration_ms: 1, num_turns: 1 } as unknown as SDKMessage).items[0]!;
    expect(bad.kind).toBe("error");
    expect(bad.text).toBe("boom");
  });
});

describe("summarizeToolInput", () => {
  test("picks the field a human would look at", () => {
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(summarizeToolInput("WebFetch", { url: "https://x.y" })).toBe("https://x.y");
    expect(summarizeToolInput("mcp__x__y", { query: "q" })).toBe("q");
  });
});
