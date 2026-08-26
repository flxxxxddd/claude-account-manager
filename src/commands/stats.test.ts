import { describe, expect, test } from "bun:test";
import type { HistoryPoint } from "../statusline/burn.ts";
import { burnByHour, sparkline, summariseWindows } from "./stats.ts";

const HOUR = 3_600_000;
/** A fixed local-midnight anchor, so hour buckets do not depend on the date. */
const MIDNIGHT = new Date(2026, 0, 15, 0, 0, 0).getTime();

function point(hoursIn: number, u: number, w: number | null): HistoryPoint {
  return { t: MIDNIGHT + hoursIn * HOUR, u, w };
}

describe("summariseWindows", () => {
  test("groups readings by the window they belong to", () => {
    const windows = summariseWindows([
      point(1, 10, 100),
      point(2, 40, 100),
      point(7, 5, 200),
      point(8, 60, 200),
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ window: 100, peak: 40 });
    expect(windows[1]).toMatchObject({ window: 200, peak: 60 });
  });

  test("a gap in recording does not split one window in two", () => {
    // Nothing is recorded while Claude Code is closed; the window is the same
    // one when it reopens.
    const windows = summariseWindows([point(0, 10, 100), point(4, 55, 100)]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.peak).toBe(55);
  });

  test("windows come back in the order they happened", () => {
    const windows = summariseWindows([point(9, 5, 200), point(1, 5, 100)]);
    expect(windows.map((w) => w.window)).toEqual([100, 200]);
  });
});

describe("burnByHour", () => {
  test("attributes a rise to the hour it landed in", () => {
    const hours = burnByHour([point(9, 10, 100), point(10, 30, 100)]);
    expect(hours[10]).toBe(20);
    expect(hours[9]).toBe(0);
  });

  test("a window reset is not counted as negative burn", () => {
    // Utilisation dropping from 90 to 2 is a fresh window, not 88% recovered;
    // counting it would cancel out real usage elsewhere in the day.
    const hours = burnByHour([point(4, 90, 100), point(5, 2, 200), point(6, 20, 200)]);
    expect(hours[5]).toBe(0);
    expect(hours[6]).toBe(18);
  });

  test("a single reading burns nothing", () => {
    expect(burnByHour([point(3, 50, 100)]).every((value) => value === 0)).toBe(true);
  });

  test("every hour of the day has a bucket", () => {
    expect(burnByHour([])).toHaveLength(24);
  });
});

describe("sparkline", () => {
  test("scales the tallest value to the tallest glyph", () => {
    const line = sparkline([0, 5, 10]);
    expect(line[0]).toBe("▁");
    expect(line[2]).toBe("█");
    // The middle sits between the two, wherever rounding puts it exactly.
    expect("▂▃▄▅▆▇").toContain(line[1]!);
  });

  test("an idle span renders flat rather than blank", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });

  test("one glyph per value", () => {
    expect(sparkline(new Array(24).fill(1))).toHaveLength(24);
  });
});
