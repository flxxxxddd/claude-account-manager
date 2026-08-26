import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_STATUSLINE,
  DEFAULT_WARMUP,
  serialisableConfig,
  type Config,
} from "./config.ts";

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    activeProfile: "work",
    profiles: {},
    warmup: { ...DEFAULT_WARMUP },
    statusline: structuredClone(DEFAULT_STATUSLINE),
    notifications: { ...DEFAULT_NOTIFICATIONS },
    ...overrides,
  };
}

/**
 * Every command that changes anything writes the whole config. Writing back
 * sections the user never touched pins that release's defaults forever, so a
 * later version adding a status-line segment would reach nobody who had ever
 * run `cca use`.
 */
describe("serialisableConfig", () => {
  test("untouched sections are left out", () => {
    const written = serialisableConfig(config());
    expect(written.statusline).toBeUndefined();
    expect(written.notifications).toBeUndefined();
    expect(written.warmup).toBeUndefined();
  });

  test("profiles and the active choice are always written", () => {
    const written = serialisableConfig(config());
    expect(written.activeProfile).toBe("work");
    expect(written.profiles).toEqual({});
  });

  test("a customised section is written in full", () => {
    const statusline = structuredClone(DEFAULT_STATUSLINE);
    statusline.lines = [["account"]];
    expect(serialisableConfig(config({ statusline })).statusline).toEqual(statusline);
  });

  test("one changed field is enough to pin its section", () => {
    const notifications = { ...DEFAULT_NOTIFICATIONS, enabled: true };
    expect(serialisableConfig(config({ notifications })).notifications).toEqual(notifications);
  });

  test("key order does not count as a change", () => {
    // The defaults are spread in different orders around the codebase; that
    // must not be mistaken for the user having an opinion.
    const reordered = Object.fromEntries(
      Object.entries(DEFAULT_WARMUP).reverse(),
    ) as typeof DEFAULT_WARMUP;
    expect(serialisableConfig(config({ warmup: reordered })).warmup).toBeUndefined();
  });
});
