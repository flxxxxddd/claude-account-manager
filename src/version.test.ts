import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version is written in four places: the npm package, the CLI's own
 * `--version`, the plugin manifest and the marketplace entry. Nothing forces
 * them to agree, and a release that bumps three of them ships a binary that
 * misreports itself — which is the one number a bug report quotes.
 */
const ROOT = join(import.meta.dir, "..");

function read(...path: string[]): string {
  return readFileSync(join(ROOT, ...path), "utf8");
}

describe("version strings", () => {
  const packageVersion = (JSON.parse(read("package.json")) as { version: string }).version;

  test("package.json carries a plain semver version", () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the CLI reports the packaged version", () => {
    const declared = /const VERSION = "([^"]+)"/.exec(read("src", "cli.ts"))?.[1];
    expect(declared).toBe(packageVersion);
  });

  test("the plugin manifest matches", () => {
    const plugin = JSON.parse(read("plugin", ".claude-plugin", "plugin.json")) as {
      version: string;
    };
    expect(plugin.version).toBe(packageVersion);
  });

  test("the marketplace entry matches", () => {
    const marketplace = JSON.parse(read(".claude-plugin", "marketplace.json")) as {
      metadata: { version: string };
    };
    expect(marketplace.metadata.version).toBe(packageVersion);
  });
});
