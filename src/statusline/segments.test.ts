import { describe, expect, test } from "bun:test";
import { DEFAULT_STATUSLINE, DEFAULT_WARMUP, type Config } from "../config.ts";
import { stripAnsi } from "../ui.ts";
import { renderLines } from "./render.ts";
import { segments, type OtherAccount, type RenderContext } from "./segments.ts";

const NOW = 1_700_000_000_000;

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  const config: Config = {
    version: 1,
    activeProfile: "work",
    profiles: {},
    warmup: { ...DEFAULT_WARMUP },
    statusline: structuredClone(DEFAULT_STATUSLINE),
  };
  return {
    config,
    payload: null,
    activeName: "work",
    activeProfile: null,
    fiveHour: { utilization: 20, resetsAt: NOW + 3_600_000 },
    sevenDay: { utilization: 10, resetsAt: NOW + 86_400_000 },
    projection: null,
    others: [],
    git: null,
    barWidth: 10,
    barStyle: "blocks",
    now: NOW,
    ...overrides,
  };
}

function other(overrides: Partial<OtherAccount> = {}): OtherAccount {
  return {
    name: "personal",
    label: "personal",
    utilization: 5,
    resetsAt: NOW + 7_200_000,
    stale: false,
    ...overrides,
  };
}

/**
 * The switch hint is the manager's whole reason to exist on the status line:
 * it must appear when the other account genuinely rescues you, and stay quiet
 * otherwise, or it becomes decoration people stop reading.
 */
describe("switch hint", () => {
  const render = (ctx: RenderContext) => stripAnsi(segments.others!(ctx) ?? "");

  test("marks the roomier account once the current one is under pressure", () => {
    const line = render(context({ fiveHour: { utilization: 85, resetsAt: NOW }, others: [other()] }));
    expect(line).toContain("↦ personal");
  });

  test("stays quiet while the current account has room", () => {
    const line = render(context({ fiveHour: { utilization: 40, resetsAt: NOW }, others: [other()] }));
    expect(line).toContain("○ personal");
    expect(line).not.toContain("↦");
  });

  test("does not suggest an account that is barely better", () => {
    const line = render(
      context({
        fiveHour: { utilization: 85, resetsAt: NOW },
        others: [other({ utilization: 70 })],
      }),
    );
    expect(line).not.toContain("↦");
  });

  test("never suggests a switch on a stale reading", () => {
    const line = render(
      context({
        fiveHour: { utilization: 85, resetsAt: NOW },
        others: [other({ stale: true })],
      }),
    );
    expect(line).not.toContain("↦");
  });

  test("picks the roomiest of several alternatives", () => {
    const line = render(
      context({
        fiveHour: { utilization: 95, resetsAt: NOW },
        others: [other({ name: "a", label: "a", utilization: 40 }), other({ name: "b", label: "b", utilization: 5 })],
      }),
    );
    expect(line).toContain("↦ b");
    expect(line).toContain("○ a");
  });
});

describe("renderLines", () => {
  test("unknown segment names are skipped rather than crashing", () => {
    const ctx = context();
    ctx.config.statusline.lines = [["account", "nonsense-segment"]];
    expect(stripAnsi(renderLines(ctx)[0]!)).toBe("● work");
  });

  test("a line whose segments all render empty is dropped", () => {
    const ctx = context();
    // No payload means no model and no context window to report.
    ctx.config.statusline.lines = [["account"], ["model", "ctx", "cost"]];
    expect(renderLines(ctx)).toHaveLength(1);
  });

  test("segments are joined in the configured order", () => {
    const ctx = context({ git: { branch: "main", modified: 2, untracked: 0, conflicted: 0, ahead: null, behind: null, countsUnknown: false } });
    ctx.config.statusline.lines = [["git", "account"]];
    const line = stripAnsi(renderLines(ctx)[0]!);
    expect(line.indexOf("main")).toBeLessThan(line.indexOf("work"));
  });
});

/**
 * The burn projection competes for space with the limits it comments on, so it
 * has to stay quiet unless it is telling you something you would act on.
 */
describe("burn", () => {
  const render = (ctx: RenderContext) => stripAnsi(segments.burn!(ctx) ?? "");

  test("says nothing without enough history to fit a rate", () => {
    expect(segments.burn!(context())).toBeNull();
  });

  test("says nothing while the session idles", () => {
    const projection = { rate: 0.02, capsAt: NOW + 80 * 3_600_000, beforeReset: false };
    expect(segments.burn!(context({ projection }))).toBeNull();
  });

  test("reports a rate worth watching even when the window survives it", () => {
    const projection = { rate: 0.8, capsAt: NOW + 3 * 3_600_000, beforeReset: false };
    expect(render(context({ projection }))).toBe("⇗0.8%/m");
  });

  test("names the moment the cap arrives when it beats the reset", () => {
    const projection = { rate: 1.4, capsAt: NOW + 20 * 60_000, beforeReset: true };
    expect(render(context({ projection }))).toContain("caps");
  });
});
