import { describe, expect, test } from "bun:test";
import { applyTokenResponse, bindingUtilization, refreshTokenExpired } from "./api.ts";
import type { ClaudeAiOauth } from "./store/index.ts";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function stored(overrides: Partial<ClaudeAiOauth> = {}): ClaudeAiOauth {
  return {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 2 * DAY,
    scopes: ["user:inference"],
    ...overrides,
  } as ClaudeAiOauth;
}

/**
 * The response states when the refresh token dies. That deadline is anchored to
 * the login and rotation does not move it, so it is the only warning an idle
 * account ever gets — reading it from the server keeps the stored copy honest.
 */
describe("applyTokenResponse", () => {
  test("the refresh deadline is taken from the server, not carried forward", () => {
    const next = applyTokenResponse(
      stored(),
      { access_token: "new", refresh_token: "new-refresh", refresh_token_expires_in: 2_479_370 },
      NOW,
    );
    expect(next.refreshTokenExpiresAt).toBe(NOW + 2_479_370_000);
  });

  test("a response without a refresh lifetime keeps the stored one", () => {
    const next = applyTokenResponse(stored(), { access_token: "new" }, NOW);
    expect(next.refreshTokenExpiresAt).toBe(NOW + 2 * DAY);
  });

  test("a response without a refresh token keeps the current one", () => {
    const next = applyTokenResponse(stored(), { access_token: "new" }, NOW);
    expect(next.refreshToken).toBe("old-refresh");
  });

  test("access-token expiry comes from expires_in", () => {
    const next = applyTokenResponse(stored(), { access_token: "new", expires_in: 28_800 }, NOW);
    expect(next.expiresAt).toBe(NOW + 28_800_000);
  });

  test("scopes are replaced only when the response carries them", () => {
    expect(applyTokenResponse(stored(), { access_token: "n" }, NOW).scopes).toEqual([
      "user:inference",
    ]);
    expect(
      applyTokenResponse(stored(), { access_token: "n", scope: "a b" }, NOW).scopes,
    ).toEqual(["a", "b"]);
  });

  test("fields the response does not mention survive untouched", () => {
    const next = applyTokenResponse(
      stored({ subscriptionType: "pro" } as Partial<ClaudeAiOauth>),
      { access_token: "new" },
      NOW,
    );
    expect((next as { subscriptionType?: string }).subscriptionType).toBe("pro");
  });
});

/** This one reads the wall clock, so its fixtures are relative to real time. */
describe("refreshTokenExpired", () => {
  test("a token with time left is not expired", () => {
    expect(
      refreshTokenExpired(stored({ refreshTokenExpiresAt: Date.now() + DAY })),
    ).toBe(false);
  });

  test("a lapsed token is expired", () => {
    expect(refreshTokenExpired(stored({ refreshTokenExpiresAt: Date.now() - 1 }))).toBe(true);
  });

  test("an unknown expiry is not treated as expired", () => {
    // Guessing "dead" here would force a re-login on credentials that work.
    expect(refreshTokenExpired(stored({ refreshTokenExpiresAt: undefined }))).toBe(false);
  });
});

describe("bindingUtilization", () => {
  test("reports the window closest to full", () => {
    expect(
      bindingUtilization({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 95, resets_at: null },
      }),
    ).toBe(95);
  });

  test("counts the Opus weekly window too", () => {
    expect(
      bindingUtilization({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
        seven_day_opus: { utilization: 88, resets_at: null },
      }),
    ).toBe(88);
  });

  test("no readings at all is unknown, not zero", () => {
    expect(bindingUtilization(null)).toBeNull();
    expect(bindingUtilization({ five_hour: null, seven_day: null })).toBeNull();
  });
});
