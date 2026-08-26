import { describe, expect, test } from "bun:test";
import type { UsageSnapshot } from "../api.ts";
import type { ProfileStatus } from "../session.ts";
import { bestByLimit } from "./picker.ts";

function status(name: string, five: number | null, week: number | null, loggedIn = true): ProfileStatus {
  const usage: UsageSnapshot = {
    five_hour: five === null ? null : { utilization: five, resets_at: null },
    seven_day: week === null ? null : { utilization: week, resets_at: null },
  };
  return {
    name,
    active: false,
    loggedIn,
    profile: { mode: "shared", dir: `/tmp/${name}`, createdAt: "2026-01-01T00:00:00Z" },
    usage: loggedIn ? usage : null,
  } as ProfileStatus;
}

/**
 * `--best` exists so you do not walk into a wall. Ranking on the five-hour
 * window alone hands you an account that is idle this hour and spent for the
 * week, which is the wall one request later.
 */
describe("bestByLimit", () => {
  test("prefers the account with the most headroom overall", () => {
    const best = bestByLimit([status("fresh", 10, 95), status("steady", 30, 20)]);
    expect(best?.name).toBe("steady");
  });

  test("still uses the five-hour window when nothing else binds", () => {
    const best = bestByLimit([status("busy", 60, 10), status("idle", 5, 10)]);
    expect(best?.name).toBe("idle");
  });

  test("breaks a tie on the binding window with the freer hour", () => {
    const best = bestByLimit([status("a", 50, 80), status("b", 20, 80)]);
    expect(best?.name).toBe("b");
  });

  test("skips accounts that are not logged in", () => {
    const best = bestByLimit([status("out", 0, 0, false), status("in", 70, 70)]);
    expect(best?.name).toBe("in");
  });

  test("an account with no readings loses to one with real numbers", () => {
    const best = bestByLimit([status("unknown", null, null), status("known", 80, 80)]);
    expect(best?.name).toBe("known");
  });

  test("no usable account yields nothing", () => {
    expect(bestByLimit([status("out", 0, 0, false)])).toBeUndefined();
  });
});
