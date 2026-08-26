import { describe, expect, test } from "bun:test";
import type { ProfileStatus } from "../session.ts";
import { stripAnsi } from "../ui.ts";
import { loginWarnings } from "./list.ts";

const DAY = 86_400_000;

function status(name: string, expiresInDays: number | null): ProfileStatus {
  return {
    name,
    active: false,
    loggedIn: true,
    profile: { mode: "shared", dir: `/tmp/${name}`, createdAt: "2026-01-01T00:00:00Z" },
    loginExpiresAt: expiresInDays === null ? undefined : Date.now() + expiresInDays * DAY,
  } as ProfileStatus;
}

/**
 * Rotation cannot move a login deadline, so this footer is the only warning an
 * account gets before it stops working. It has to appear in time and stay away
 * the rest of the month, or people learn to skip it.
 */
describe("loginWarnings", () => {
  test("says nothing while every login has a month left", () => {
    expect(loginWarnings([status("work", 27), status("personal", 20)])).toBeNull();
  });

  test("warns inside the final week and names the fix", () => {
    const text = stripAnsi(loginWarnings([status("work", 5)])!);
    expect(text).toContain("work needs a new login in 5d");
    expect(text).toContain("cca login work");
  });

  test("says outright that rotation will not save it", () => {
    // The daemon rotates tokens twice a day; assuming that is enough is the
    // obvious wrong conclusion.
    expect(stripAnsi(loginWarnings([status("work", 3)])!)).toContain(
      "rotating tokens does not extend it",
    );
  });

  test("a lapsed login reads as logged out, not as a countdown", () => {
    const text = stripAnsi(loginWarnings([status("work", -1)])!);
    expect(text).toContain("work is logged out");
    expect(text).not.toContain("needs a new login in");
  });

  test("several warnings are ordered by urgency", () => {
    const text = stripAnsi(loginWarnings([status("late", 6), status("soon", 1)])!);
    expect(text.indexOf("soon")).toBeLessThan(text.indexOf("late"));
  });

  test("a profile with no recorded deadline is left alone", () => {
    expect(loginWarnings([status("unknown", null)])).toBeNull();
  });
});
