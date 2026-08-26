import { describe, expect, test } from "bun:test";
import { selfArgs, windowsFromPayload } from "./statusline.ts";

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

/**
 * Claude Code reports `rate_limits.*.resets_at` in Unix *seconds* while the
 * rest of this codebase works in milliseconds. Reading it raw puts every reset
 * in January 1970, which renders as a permanently expired window.
 */
describe("windowsFromPayload", () => {
  test("reset timestamps are converted from seconds to milliseconds", () => {
    const windows = windowsFromPayload({
      rate_limits: {
        five_hour: { used_percentage: 43, resets_at: 1787781000 },
        seven_day: { used_percentage: 33, resets_at: 1788224400 },
      },
    });
    expect(windows.fiveHour).toEqual({ utilization: 43, resetsAt: 1787781000000 });
    expect(windows.sevenDay).toEqual({ utilization: 33, resetsAt: 1788224400000 });
  });

  test("a payload without limits reports nothing rather than zero", () => {
    // Zero would render as a full green bar on an account that may be spent.
    expect(windowsFromPayload({})).toEqual({ fiveHour: null, sevenDay: null });
    expect(windowsFromPayload(null)).toEqual({ fiveHour: null, sevenDay: null });
  });

  test("a window missing its percentage keeps the reset time", () => {
    const windows = windowsFromPayload({ rate_limits: { five_hour: { resets_at: 1787781000 } } });
    expect(windows.fiveHour).toEqual({ utilization: null, resetsAt: 1787781000000 });
  });
});
