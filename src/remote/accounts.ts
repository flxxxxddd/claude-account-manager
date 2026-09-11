/** Accounts as the app sees them: cca profiles plus their limit windows. */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { UsageSnapshot } from "../api.ts";
import { CCA_HOME, loadConfig, requireProfile, saveConfig } from "../config.ts";
import { statusAll } from "../session.ts";
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

/**
 * `fresh` hits /api/oauth/usage for every profile (a few hundred ms); the
 * default answers from the status line's cache so the app opens instantly.
 */
export async function listAccounts(options: { fresh?: boolean } = {}): Promise<Account[]> {
  const config = await loadConfig();
  const names = Object.keys(config.profiles);

  if (options.fresh) {
    const statuses = await statusAll(config, { usage: true });
    return statuses.map((s) => ({
      name: s.name,
      email: s.profile.email,
      organization: s.profile.organizationName,
      plan: s.profile.subscriptionType,
      active: s.active,
      loggedIn: s.loggedIn,
      fiveHour: windowOf(s.usage?.five_hour),
      sevenDay: windowOf(s.usage?.seven_day),
      sevenDayOpus: windowOf(s.usage?.seven_day_opus),
      loginExpiresAt: iso(s.loginExpiresAt),
      usageFetchedAt: s.usage ? new Date().toISOString() : null,
      error: s.error,
    }));
  }

  return Promise.all(
    names.map(async (name) => {
      const profile = config.profiles[name]!;
      const cached = await readCached(name);
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
        error: cached?.error,
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
