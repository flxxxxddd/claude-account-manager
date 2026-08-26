import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  credentialFilePath,
  credentialServiceName,
  DEFAULT_CC_CONFIG_DIR,
  profileEnv,
} from "./cc-paths.ts";

/**
 * These assertions pin the contract with Claude Code. If a future CC release
 * changes how it namespaces credential storage, this is the test that fails.
 */
describe("credentialServiceName", () => {
  test("no storage dir yields the default slot a plain login writes to", () => {
    expect(credentialServiceName(undefined)).toBe("Claude Code-credentials");
  });

  test("a storage dir appends the first 8 hex chars of its sha256", () => {
    const dir = "/Users/example/.ccacc/profiles/work";
    const expected = createHash("sha256").update(dir).digest("hex").substring(0, 8);
    expect(credentialServiceName(dir)).toBe(`Claude Code-credentials-${expected}`);
  });

  test("distinct directories never share a slot", () => {
    const a = credentialServiceName("/tmp/a");
    const b = credentialServiceName("/tmp/b");
    expect(a).not.toBe(b);
  });

  test("paths are hashed after NFC normalisation", () => {
    // Same path, different unicode encodings: precomposed U+00E9 versus
    // "e" + combining acute U+0301. macOS filesystems hand back the latter.
    const composed = "/tmp/caf\u00E9";
    const decomposed = "/tmp/cafe\u0301";
    expect(composed).not.toBe(decomposed);
    expect(credentialServiceName(composed)).toBe(credentialServiceName(decomposed));
  });

  test("golden values stay stable across platforms", () => {
    // Hashes computed independently of this implementation. A change here
    // means every existing profile would silently lose its credentials.
    expect(credentialServiceName("/Users/example/.ccacc/profiles/work")).toBe(
      "Claude Code-credentials-cb15bcc2",
    );
    expect(credentialServiceName("/home/example/.ccacc/profiles/work")).toBe(
      "Claude Code-credentials-5b9f136a",
    );
  });
});

describe("credentialFilePath", () => {
  test("defaults to the standard config directory", () => {
    expect(credentialFilePath(undefined)).toBe(join(DEFAULT_CC_CONFIG_DIR, ".credentials.json"));
    expect(DEFAULT_CC_CONFIG_DIR).toBe(join(homedir(), ".claude"));
  });

  test("lives inside the profile storage directory", () => {
    expect(credentialFilePath("/tmp/p")).toBe("/tmp/p/.credentials.json");
  });
});

describe("profileEnv", () => {
  test("shared mode separates credentials only", () => {
    expect(profileEnv("/tmp/p", "shared")).toEqual({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/p",
    });
  });

  test("isolated mode redirects the whole config directory", () => {
    expect(profileEnv("/tmp/p", "isolated")).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/p" });
  });

  test("the two modes never set the same variable", () => {
    const shared = Object.keys(profileEnv("/tmp/p", "shared"));
    const isolated = Object.keys(profileEnv("/tmp/p", "isolated"));
    expect(shared).not.toEqual(isolated);
  });
});
