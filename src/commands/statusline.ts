/**
 * `cca statusline` — the HUD for Claude Code's statusLine setting.
 *
 * Claude Code renders this on every turn, so the path never blocks on the
 * network. Two things make that possible: the payload on stdin already carries
 * the active account's rate limits, and every other account is read from a
 * cache that a detached child refills.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bindingUtilization, fetchUsage, type UsageSnapshot } from "../api.ts";
import { CCA_HOME, loadConfig, type Config, type Profile } from "../config.ts";
import { accessTokenFor } from "../session.ts";
import { c, setColor } from "../ui.ts";
import { trackAndProject } from "../statusline/burn.ts";
import { readGitState } from "../statusline/git.ts";
import {
  cachePayload,
  readCachedPayload,
  readPayload,
  type StatuslinePayload,
} from "../statusline/payload.ts";
import { renderLines } from "../statusline/render.ts";
import type { OtherAccount, RenderContext, Window } from "../statusline/segments.ts";

/**
 * One file per profile, not one file for all of them.
 *
 * Refreshes run as independent detached children, so a shared file turns every
 * write into a read-modify-write race: two children that start together each
 * write back the state they read, and the loser's profile silently reverts.
 * Separate files remove the race instead of guarding it, which matters because
 * the render path cannot afford to wait on a lock a network call is holding.
 */
const CACHE_DIR = join(CCA_HOME, "cache", "usage");
/** How long a cached reading for a background account stays presentable. */
const STALE_MS = 5 * 60_000;
/** A refresh started this recently is assumed to still be running. */
const REFRESH_CLAIM_MS = 30_000;
/**
 * How long a cached login deadline is trusted.
 *
 * The deadline itself only moves when someone logs in again, so this is not
 * about drift — it is about noticing that a re-login happened. A warning that
 * keeps crying "expiring" after the user already fixed it is worse than none.
 */
const LOGIN_RECHECK_MS = 6 * 60 * 60_000;

interface CacheEntry {
  fetchedAt: number;
  usage: UsageSnapshot | null;
  error?: string;
  /** When a background refresh for this profile was last started. */
  refreshingAt?: number;
  /**
   * When the credentials were last consulted for the deadline below.
   *
   * Set even when the read fails. A profile whose credentials cannot be read
   * has no deadline to record, and treating that as "still unknown" would
   * spawn a fresh refresh on every single render.
   */
  tokenCheckedAt?: number;
  /** When this profile's refresh token dies and a browser login is required. */
  refreshTokenExpiresAt?: number;
}

type Cache = Record<string, CacheEntry>;

function entryPath(name: string): string {
  // Profile names are validated to letters, digits, dot, dash and underscore
  // with an alphanumeric first character, so they are safe as file names.
  return join(CACHE_DIR, `${name}.json`);
}

async function readEntry(name: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(entryPath(name), "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function readCache(names: string[]): Promise<Cache> {
  const entries = await Promise.all(
    names.map(async (name) => [name, await readEntry(name)] as const),
  );
  const cache: Cache = {};
  for (const [name, entry] of entries) if (entry) cache[name] = entry;
  return cache;
}

async function writeEntry(name: string, entry: CacheEntry): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  const path = entryPath(name);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await rename(tmp, path);
}

export interface StatuslineOptions {
  /** Re-render the last real frame instead of reading stdin. */
  preview?: boolean;
}

export async function statuslineCommand(
  config: Config,
  options: StatuslineOptions = {},
): Promise<number> {
  // Claude Code reads this through a pipe but renders ANSI, so the usual
  // "not a TTY means no colour" rule would silently strip the whole palette.
  setColor(config.statusline.color !== "off");

  const payload = options.preview ? await readCachedPayload() : await readPayload();
  if (payload && !options.preview) await cachePayload(payload);

  const now = Date.now();
  const activeName = config.activeProfile ?? null;
  const activeProfile = activeName ? config.profiles[activeName] ?? null : null;
  const cache = await readCache(Object.keys(config.profiles));

  const live = windowsFromPayload(payload);
  const cached = windowsFromCache(cache[activeName ?? ""]);
  const fiveHour = live.fiveHour ?? cached.fiveHour;
  const sevenDay = live.sevenDay ?? cached.sevenDay;

  // The payload's limits are fresher than anything a poll could get, so they
  // are folded back into the cache for `cca list` and for the next render.
  if (activeName && live.fiveHour) {
    const previous = cache[activeName];
    cache[activeName] = {
      fetchedAt: now,
      usage: toSnapshot(live),
      // The payload knows nothing about credentials; dropping these would
      // erase the active account's only expiry warning.
      tokenCheckedAt: previous?.tokenCheckedAt,
      refreshTokenExpiresAt: previous?.refreshTokenExpiresAt,
    };
    await writeEntry(activeName, cache[activeName]!);
  }

  const others = collectOthers(config, cache, activeName, now);
  await refreshStaleProfiles(config, cache, activeName, Boolean(live.fiveHour), now);

  // Only gather what the configured layout will actually draw: tracking burn
  // costs a file write and reading git costs a subprocess, and a HUD that has
  // switched those segments off should pay for neither.
  const enabled = new Set(config.statusline.lines.flat());
  const [projection, git] = await Promise.all([
    enabled.has("burn") && activeName
      ? trackAndProject(activeName, fiveHour.utilization, fiveHour.resetsAt, now)
      : null,
    enabled.has("git")
      ? readGitState(payload?.workspace?.current_dir ?? payload?.cwd ?? process.cwd())
      : null,
  ]);

  const ctx: RenderContext = {
    config,
    payload,
    activeName,
    activeProfile,
    fiveHour,
    sevenDay,
    binding: highest(fiveHour.utilization, sevenDay.utilization),
    loginExpiresAt: (activeName ? cache[activeName]?.refreshTokenExpiresAt : undefined) ?? null,
    projection,
    others,
    git,
    barWidth: Math.max(3, Math.min(40, config.statusline.barWidth)),
    barStyle: config.statusline.barStyle,
    now,
  };

  const lines = renderLines(ctx);
  process.stdout.write(lines.length ? `${lines.join("\n")}\n` : `${c.gray("cca")}\n`);
  return 0;
}

const EMPTY_WINDOW: Window = { utilization: null, resetsAt: null };

function highest(...values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
}

export function windowsFromPayload(payload: StatuslinePayload | null): {
  fiveHour: Window | null;
  sevenDay: Window | null;
} {
  const limits = payload?.rate_limits;
  if (!limits) return { fiveHour: null, sevenDay: null };
  const convert = (window: { used_percentage?: number; resets_at?: number } | undefined) =>
    window === undefined
      ? null
      : {
          utilization: window.used_percentage ?? null,
          resetsAt: window.resets_at === undefined ? null : window.resets_at * 1000,
        };
  return { fiveHour: convert(limits.five_hour), sevenDay: convert(limits.seven_day) };
}

function windowsFromCache(entry: CacheEntry | undefined): { fiveHour: Window; sevenDay: Window } {
  return {
    fiveHour: windowFromSnapshot(entry?.usage?.five_hour),
    sevenDay: windowFromSnapshot(entry?.usage?.seven_day),
  };
}

function windowFromSnapshot(
  window: { utilization: number | null; resets_at: string | null } | null | undefined,
): Window {
  if (!window) return EMPTY_WINDOW;
  const resets = window.resets_at ? new Date(window.resets_at).getTime() : NaN;
  return {
    utilization: window.utilization,
    resetsAt: Number.isFinite(resets) ? resets : null,
  };
}

function toSnapshot(live: { fiveHour: Window | null; sevenDay: Window | null }): UsageSnapshot {
  const convert = (window: Window | null) =>
    window === null
      ? null
      : {
          utilization: window.utilization,
          resets_at: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
        };
  return { five_hour: convert(live.fiveHour), seven_day: convert(live.sevenDay) };
}

function collectOthers(
  config: Config,
  cache: Cache,
  activeName: string | null,
  now: number,
): OtherAccount[] {
  return Object.entries(config.profiles)
    .filter(([name]) => name !== activeName)
    .map(([name, profile]: [string, Profile]) => {
      const entry = cache[name];
      const window = windowFromSnapshot(entry?.usage?.five_hour);
      return {
        name,
        label: profile.label ?? name,
        utilization: window.utilization,
        binding: bindingUtilization(entry?.usage),
        loginExpiresAt: entry?.refreshTokenExpiresAt ?? null,
        resetsAt: window.resetsAt,
        stale: !entry || now - entry.fetchedAt > STALE_MS,
      };
    });
}

/**
 * Kick off background refreshes for whatever the cache cannot answer.
 *
 * The active account is skipped when the payload already carried its limits —
 * that is the common case, and it keeps the usage endpoint (which throttles)
 * out of the everyday path entirely.
 */
async function refreshStaleProfiles(
  config: Config,
  cache: Cache,
  activeName: string | null,
  activeIsLive: boolean,
  now: number,
): Promise<void> {
  for (const name of Object.keys(config.profiles)) {
    const entry = cache[name];
    const loginUnknown = entry?.tokenCheckedAt === undefined
      || now - entry.tokenCheckedAt > LOGIN_RECHECK_MS;
    if (name === activeName && activeIsLive && !loginUnknown) continue;
    if (entry && now - entry.fetchedAt <= STALE_MS && !loginUnknown) continue;
    // Several sessions render at once and a cold cache stays cold until the
    // first child lands, so without a claim every one of them would spawn its
    // own refresh for the same profile.
    if (entry?.refreshingAt !== undefined && now - entry.refreshingAt < REFRESH_CLAIM_MS) continue;
    await writeEntry(name, {
      fetchedAt: entry?.fetchedAt ?? 0,
      usage: entry?.usage ?? null,
      refreshingAt: now,
    });
    spawnDetachedRefresh(name);
  }
}

/**
 * Drop a profile's cached reading.
 *
 * Logging in again moves the deadline the status line warns about, and a
 * warning that keeps firing after the user has already fixed it teaches them
 * to ignore it.
 */
export async function forgetCachedUsage(name: string): Promise<void> {
  await rm(entryPath(name), { force: true });
}

/** Refresh one profile's cached usage; used by the detached child. */
export async function refreshUsageCache(name: string): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles[name];
  if (!profile) return;

  const previous = await readEntry(name);
  try {
    const oauth = await accessTokenFor(name, profile);
    await writeEntry(name, {
      fetchedAt: Date.now(),
      usage: await fetchUsage(oauth.accessToken),
      tokenCheckedAt: Date.now(),
      refreshTokenExpiresAt: oauth.refreshTokenExpiresAt,
    });
  } catch (err) {
    // Keep the last good reading: a throttled or offline refresh should show a
    // slightly stale number rather than blanking the status line.
    await writeEntry(name, {
      fetchedAt: Date.now(),
      usage: previous?.usage ?? null,
      tokenCheckedAt: Date.now(),
      refreshTokenExpiresAt: previous?.refreshTokenExpiresAt,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function spawnDetachedRefresh(name: string): void {
  try {
    const child = spawn(process.execPath, [...selfArgs(process.argv[1]), "cache-refresh", name], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // A missed cache refresh only costs a slightly stale number.
  }
}

/**
 * Arguments needed to re-invoke this program.
 *
 * Running from a script (`node dist/cli.js`, `bun run src/cli.ts`) means
 * passing the script path along. A `bun build --compile` binary instead
 * reports a virtual `/$bunfs/root/...` path in argv[1] that only exists inside
 * that process, so re-invoking must pass nothing but the executable itself.
 */
export function selfArgs(script: string | undefined): string[] {
  const isCompiled = !script || script === process.execPath || script.startsWith("/$bunfs/");
  return isCompiled ? [] : [script];
}
