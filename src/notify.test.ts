import { describe, expect, test } from "bun:test";
import { appleScriptString } from "./notify.ts";

/**
 * Profile names and API error messages end up in this text, so a quote in the
 * wrong place would not just garble the notification — it would end the
 * AppleScript literal and let the rest be read as code.
 */
describe("appleScriptString", () => {
  test("wraps plain text in quotes", () => {
    expect(appleScriptString("all good")).toBe('"all good"');
  });

  test("escapes a quote so it cannot end the literal", () => {
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("escapes backslashes before quotes, not after", () => {
    // The other order turns a backslash-quote pair into an escaped backslash
    // followed by a live quote, which ends the literal.
    expect(appleScriptString('a\\"b')).toBe('"a\\\\\\"b"');
  });

  test("a trailing backslash cannot escape the closing quote", () => {
    expect(appleScriptString("path\\")).toBe('"path\\\\"');
  });

  test("control characters are flattened to spaces", () => {
    expect(appleScriptString("one\ntwo\rthree")).toBe('"one two three"');
  });

  test("an attempt to break out stays inside the literal", () => {
    const escaped = appleScriptString('" & (do shell script "id") & "');
    // The literal must open exactly once and close exactly once: every quote
    // from the payload is escaped.
    expect(escaped.match(/(?<!\\)"/g)).toHaveLength(2);
    expect(escaped).toContain("do shell script");
  });
});
