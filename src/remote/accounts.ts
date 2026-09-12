/** Accounts as the app sees them: cca profiles plus their limit windows. */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { UsageSnapshot } from "../api.ts";
import { CCA_HOME, loadConfig, requireProfile, saveConfig } from "../config.ts";
import { refreshUsageCache } from "../commands/statusline.ts";
import type { Account, LimitWindow } from "./protocol.ts";

/** Written by `cca cache-refresh`; the same file the status line reads. */
const USAGE_CACHE_DIR = join(CCA_HOME, "cache", "usage");

interface CachedUsage {
  fetchedAt: number;
  usage: UsageSnapshot | null;
  refreshTokenExpiresAt?: number;
  error?: string;
}

async function readCached(name: string): Promise<CachedUsage | null> {
  try {
    return JSON.parse(await readFile(join(USAGE_CACHE_DIR, `${name}.json`), "utf8")) as CachedUsage;
  } catch {
    return null;
  }
}

function windowOf(raw: { utilization: number | null; resets_at: string | null } | null | undefined): LimitWindow | null {
  if (!raw) return null;
  return {
    utilization: typeof raw.utilization === "number" ? raw.utilization / 100 : null,
    resetsAt: raw.resets_at ?? null,
  };
}

function iso(ms: number | undefined | null): string | undefined {
  return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

/** A reading younger than this is served as-is even when `fresh` is asked for. */
const FRESH_MAX_AGE_MS = 90_000;

/**
 * Accounts always come from the status line's per-profile cache. `fresh`
 * refreshes stale entries first — one profile at a time, never in parallel,
 * and never more often than FRESH_MAX_AGE_MS. Polling /api/oauth/usage for
 * every account every minute in parallel is exactly what earned the app a
 * 429 ("usage endpoint is throttling") while the terminal was fine.
 */
export async function listAccounts(options: { fresh?: boolean } = {}): Promise<Account[]> {
  const config = await loadConfig();
  const names = Object.keys(config.profiles);

  if (options.fresh) {
    for (const name of names) {
      const cached = await readCached(name);
      if (cached && Date.now() - cached.fetchedAt < FRESH_MAX_AGE_MS) continue;
      await refreshUsageCache(name);
    }
  }

  return Promise.all(
    names.map(async (name) => {
      const profile = config.profiles[name]!;
      const cached = await readCached(name);
      const throttled = /throttling/i.test(cached?.error ?? "");
      return {
        name,
        email: profile.email,
        organization: profile.organizationName,
        plan: profile.subscriptionType,
        active: name === config.activeProfile,
        // Without a fresh probe, "has a cache entry without an auth error" is
        // the best cheap approximation; the app can ask for `fresh` to be sure.
        loggedIn: cached ? !/not logged in|no credentials|expired/i.test(cached.error ?? "") : true,
        fiveHour: windowOf(cached?.usage?.five_hour),
        sevenDay: windowOf(cached?.usage?.seven_day),
        sevenDayOpus: windowOf(cached?.usage?.seven_day_opus),
        loginExpiresAt: iso(cached?.refreshTokenExpiresAt),
        usageFetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
        // A throttled refresh keeps the last good reading; that is not an error
        // worth showing unless there is no reading at all.
        error: throttled && cached?.usage ? undefined : cached?.error,
      } satisfies Account;
    }),
  );
}

/** Same effect as `cca use <name>`: the next plain `cca` launch runs as it. */
export async function useAccount(name: string): Promise<void> {
  const config = await loadConfig();
  requireProfile(config, name);
  config.activeProfile = name;
  await saveConfig(config);
}
