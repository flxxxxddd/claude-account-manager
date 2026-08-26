import { describe, expect, test } from "bun:test";
import { countToolUses } from "./tools.ts";

function assistant(blocks: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { content: blocks } });
}

const TOOL = { type: "tool_use", name: "Bash", input: {} };
const TEXT = { type: "text", text: "hello" };

/**
 * The transcript is read incrementally, so this counts a slice of an
 * append-only file that is being written to while it is read. Miscounting the
 * bytes consumed is the dangerous mistake: the next render resumes from the
 * wrong offset and either double-counts or loses everything after it.
 */
describe("countToolUses", () => {
  test("counts every tool_use block in an assistant turn", () => {
    const chunk = `${assistant([TEXT, TOOL, TOOL])}\n`;
    expect(countToolUses(chunk).tools).toBe(2);
  });

  test("ignores tool results, which belong to user turns", () => {
    const chunk = `${JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    })}\n`;
    expect(countToolUses(chunk).tools).toBe(0);
  });

  test("does not count the phrase appearing in prose", () => {
    const chunk = `${assistant([{ type: "text", text: 'the "tool_use" block' }])}\n`;
    expect(countToolUses(chunk).tools).toBe(0);
  });

  test("a half-written final line is left for the next read", () => {
    const complete = `${assistant([TOOL])}\n`;
    const partial = assistant([TOOL]).slice(0, 20);
    const result = countToolUses(complete + partial);
    expect(result.tools).toBe(1);
    // Consuming the partial line would skip the rest of that turn forever.
    expect(result.consumed).toBe(Buffer.byteLength(complete, "utf8"));
  });

  test("a chunk with no line break consumes nothing", () => {
    const result = countToolUses(assistant([TOOL]).slice(0, 10));
    expect(result).toEqual({ tools: 0, consumed: 0 });
  });

  test("bytes are counted as bytes, not as characters", () => {
    // An offset measured in UTF-16 code units drifts on every emoji.
    const line = `${assistant([{ type: "text", text: "привет 🔧" }, TOOL])}\n`;
    const result = countToolUses(line);
    expect(result.tools).toBe(1);
    expect(result.consumed).toBe(Buffer.byteLength(line, "utf8"));
    expect(result.consumed).toBeGreaterThan(line.length);
  });

  test("a malformed line costs one count, not the whole read", () => {
    const chunk = `{"type":"assistant" broken "tool_use"\n${assistant([TOOL])}\n`;
    expect(countToolUses(chunk).tools).toBe(1);
  });

  test("blank lines are skipped", () => {
    expect(countToolUses(`\n\n${assistant([TOOL])}\n`).tools).toBe(1);
  });
});
