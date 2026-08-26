import { describe, expect, test } from "bun:test";
import { reliefFor } from "./daemon.ts";
import type { WarmOutcome } from "./warm.ts";

function outcome(name: string, utilization: number | null): WarmOutcome {
  return { name, status: "already-open", utilization };
}

/**
 * The "switch accounts" alert is the intrusive one — it fires while you are
 * working. It has to be right about there being somewhere better to go, or it
 * is just an interruption telling you something you cannot act on.
 */
describe("reliefFor", () => {
  test("pairs a spent account with the roomiest alternative", () => {
    const relief = reliefFor([outcome("work", 94), outcome("spare", 30), outcome("fresh", 2)], 90);
    expect(relief?.spent.name).toBe("work");
    expect(relief?.roomy.name).toBe("fresh");
  });

  test("stays silent below the threshold", () => {
    expect(reliefFor([outcome("work", 80), outcome("fresh", 1)], 90)).toBeNull();
  });

  test("stays silent when the alternative is nearly as tired", () => {
    // Interrupting someone to move them from 94% to 80% is not worth it.
    expect(reliefFor([outcome("work", 94), outcome("other", 80)], 90)).toBeNull();
  });

  test("stays silent when there is nowhere else to go", () => {
    expect(reliefFor([outcome("work", 99)], 90)).toBeNull();
  });

  test("ignores accounts whose usage could not be read", () => {
    expect(reliefFor([outcome("work", 95), outcome("unknown", null)], 90)).toBeNull();
  });
});
