import { describe, expect, test } from "bun:test";
import { bar, setColor, stripAnsi, visibleLength } from "./ui.ts";

/**
 * The bar is the densest thing on the status line: ten cells stand in for the
 * whole quota, so an off-by-one cell is a visible lie about how much is left.
 */
describe("bar", () => {
  const cells = (value: number | null, width = 10) => stripAnsi(bar(value, width));

  test("a full bar has no empty cells", () => {
    expect(cells(100)).toBe("█".repeat(10));
  });

  test("an unknown reading renders empty, not zero", () => {
    expect(cells(null)).toBe("░".repeat(10));
  });

  test("cell count always matches the requested width", () => {
    for (let value = 0; value <= 100; value++) {
      expect(cells(value)).toHaveLength(10);
    }
  });

  test("a fraction of a cell still shows a sliver", () => {
    // 1% of a ten-cell bar is a tenth of a cell — it must not read as empty.
    expect(cells(1).startsWith("░")).toBe(false);
  });

  test("zero is the only reading that renders fully empty", () => {
    expect(cells(0)).toBe("░".repeat(10));
  });

  test("out-of-range readings are clamped", () => {
    expect(cells(140)).toBe("█".repeat(10));
    expect(cells(-20)).toBe("░".repeat(10));
  });

  test("ascii style avoids block glyphs entirely", () => {
    const ascii = stripAnsi(bar(50, 10, "ascii"));
    expect(ascii).toBe(`${"#".repeat(5)}${"-".repeat(5)}`);
  });
});

describe("visibleLength", () => {
  test("colour codes do not count toward width", () => {
    setColor(true);
    const painted = bar(50, 10);
    expect(painted).toContain("\x1b[");
    expect(visibleLength(painted)).toBe(10);
    setColor(false);
  });
});
