import { describe, expect, test } from "bun:test";
import { fromBase64Url, importKey, open, randomBytes, seal, toBase64Url, tokensEqual } from "./crypto.ts";

describe("envelope", () => {
  test("round-trips and binds to the device id", async () => {
    const key = await importKey(randomBytes(32));
    const env = await seal(key, '{"id":"r1"}', "device-a");
    expect(await open(key, env, "device-a")).toBe('{"id":"r1"}');
    await expect(open(key, env, "device-b")).rejects.toThrow();
  });

  test("a different key cannot open it", async () => {
    const a = await importKey(randomBytes(32));
    const b = await importKey(randomBytes(32));
    const env = await seal(a, "secret", "d");
    await expect(open(b, env, "d")).rejects.toThrow();
  });

  test("base64url survives the trip", () => {
    const bytes = randomBytes(32);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  test("rejects a wrongly sized key", async () => {
    await expect(importKey(randomBytes(16))).rejects.toThrow(/32 bytes/);
  });

  test("tokensEqual", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("abc", "ab")).toBe(false);
  });
});
