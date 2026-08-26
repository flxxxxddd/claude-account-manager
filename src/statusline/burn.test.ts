import { describe, expect, test } from "bun:test";
import { foldSample, project, type Sample } from "./burn.ts";

const MINUTE = 60_000;

/** A steady climb of `perMinute` percent, one sample a minute. */
function ramp(from: number, perMinute: number, minutes: number, now: number): Sample[] {
  const samples: Sample[] = [];
  for (let i = 0; i <= minutes; i++) {
    samples.push({ t: now - (minutes - i) * MINUTE, u: from + perMinute * i });
  }
  return samples;
}

describe("foldSample", () => {
  const now = 1_700_000_000_000;

  test("a new reset timestamp starts a new window", () => {
    const previous = { window: 100, samples: [{ t: now - MINUTE, u: 80 }] };
    const { entry } = foldSample(previous, 3, 200, now);
    expect(entry.window).toBe(200);
    // Carrying the old 80% into a window that just reset would project a cap
    // that already happened.
    expect(entry.samples).toEqual([{ t: now, u: 3 }]);
  });

  test("an unchanged reading inside the gap is not recorded twice", () => {
    const previous = { window: 100, samples: [{ t: now - 5_000, u: 42 }] };
    const { entry, changed } = foldSample(previous, 42, 100, now);
    expect(entry.samples).toHaveLength(1);
    expect(changed).toBe(false);
  });

  test("a changed reading is recorded even inside the gap", () => {
    const previous = { window: 100, samples: [{ t: now - 5_000, u: 42 }] };
    const { entry } = foldSample(previous, 43, 100, now);
    expect(entry.samples).toHaveLength(2);
  });

  test("history is capped so a long window cannot grow the file forever", () => {
    let entry: { window: number | null; samples: Sample[] } = { window: 100, samples: [] };
    for (let i = 0; i < 300; i++) {
      entry = foldSample(entry, i % 100, 100, now + i * MINUTE).entry;
    }
    expect(entry.samples.length).toBeLessThanOrEqual(120);
  });
});

describe("project", () => {
  const now = 1_700_000_000_000;

  test("a steady 2%/min climb projects the cap at the right moment", () => {
    const projection = project(ramp(40, 2, 20, now), null, now);
    expect(projection).not.toBeNull();
    expect(projection!.rate).toBeCloseTo(2, 5);
    // 20% of headroom left at 2%/min is 10 minutes.
    expect((projection!.capsAt - now) / MINUTE).toBeCloseTo(10, 5);
  });

  test("a cap landing before the reset is flagged", () => {
    const samples = ramp(40, 2, 20, now);
    expect(project(samples, now + 60 * MINUTE, now)!.beforeReset).toBe(true);
    expect(project(samples, now + 5 * MINUTE, now)!.beforeReset).toBe(false);
  });

  test("too short a history yields no projection", () => {
    // Two samples a minute apart describe one turn, not a trend.
    expect(project(ramp(40, 2, 1, now), null, now)).toBeNull();
  });

  test("a flat window yields no projection", () => {
    expect(project(ramp(40, 0, 20, now), null, now)).toBeNull();
  });

  test("samples older than the fitting window are ignored", () => {
    const stale = ramp(0, 5, 30, now - 90 * MINUTE);
    expect(project(stale, null, now)).toBeNull();
  });

  test("an already-capped window yields no projection", () => {
    expect(project(ramp(90, 1, 20, now), null, now)).toBeNull();
  });
});
