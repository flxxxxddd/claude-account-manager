import { describe, expect, test } from "bun:test";
import { selfArgs } from "./statusline.ts";

/**
 * The status line re-invokes this program to refresh its cache in the
 * background. Getting these arguments wrong makes the child a no-op and the
 * cache never fills — which is silent, because the child's output is discarded.
 */
describe("selfArgs", () => {
  test("a real script path is passed through", () => {
    expect(selfArgs("/usr/local/lib/cca/dist/cli.js")).toEqual([
      "/usr/local/lib/cca/dist/cli.js",
    ]);
  });

  test("bun's virtual compiled path is dropped", () => {
    // `bun build --compile` reports a path that exists only inside that process.
    expect(selfArgs("/$bunfs/root/cli.js")).toEqual([]);
  });

  test("a missing argv[1] is dropped", () => {
    expect(selfArgs(undefined)).toEqual([]);
    expect(selfArgs("")).toEqual([]);
  });

  test("argv[1] equal to the executable is dropped", () => {
    expect(selfArgs(process.execPath)).toEqual([]);
  });
});
