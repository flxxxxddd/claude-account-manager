import { describe, expect, test } from "bun:test";
import { dueSlots } from "./daemon.ts";
import { isWindowOpen } from "./warm.ts";

function at(hours: number, minutes: number): Date {
  return new Date(2026, 7, 26, hours, minutes, 0, 0);
}

describe("dueSlots", () => {
  test("a slot fires once its time has passed", () => {
    expect(dueSlots(["08:00"], [], at(8, 5))).toEqual(["2026-08-26 08:00"]);
  });

  test("a slot in the future does not fire", () => {
    expect(dueSlots(["08:00"], [], at(7, 59))).toEqual([]);
  });

  test("a slot already fired today does not fire again", () => {
    expect(dueSlots(["08:00"], ["2026-08-26 08:00"], at(12, 0))).toEqual([]);
  });

  test("yesterday's record does not suppress today's slot", () => {
    expect(dueSlots(["08:00"], ["2026-08-25 08:00"], at(9, 0))).toEqual(["2026-08-26 08:00"]);
  });

  test("multiple slots are evaluated independently", () => {
    expect(dueSlots(["08:00", "13:00", "20:00"], [], at(14, 0))).toEqual([
      "2026-08-26 08:00",
      "2026-08-26 13:00",
    ]);
  });

  test("malformed slots are ignored rather than throwing", () => {
    expect(dueSlots(["nope", "25:00", "08:70", "08:00"], [], at(23, 0))).toEqual([
      "2026-08-26 08:00",
    ]);
  });
});

describe("isWindowOpen", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();

  test("usage inside a window that has not reset means it is open", () => {
    expect(isWindowOpen({ utilization: 5, resets_at: future })).toBe(true);
  });

  test("zero usage means nothing has started the window", () => {
    expect(isWindowOpen({ utilization: 0, resets_at: future })).toBe(false);
  });

  test("a reset time in the past means the window has lapsed", () => {
    expect(isWindowOpen({ utilization: 40, resets_at: past })).toBe(false);
  });

  test("missing data is treated as closed so warm-up still runs", () => {
    expect(isWindowOpen(null)).toBe(false);
    expect(isWindowOpen(undefined)).toBe(false);
    expect(isWindowOpen({ utilization: 10, resets_at: null })).toBe(false);
  });
});
