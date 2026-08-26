/**
 * `cca statusline` — a compact line for Claude Code's statusLine setting.
 *
 * Claude Code renders the status line on every turn, so this path never blocks
 * on the network: it prints whatever the usage cache holds and kicks off a
 * detached refresh when that cache has gone stale.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchUsage, type UsageSnapshot } from "../api.ts";
import { CCA_HOME, loadConfig, type Config } from "../config.ts";
import { accessTokenFor } from "../session.ts";
import { c, formatReset, formatUtilization, limitColor, symbols } from "../ui.ts";

const CACHE_DIR = join(CCA_HOME, "cache");
const CACHE_PATH = join(CACHE_DIR, "usage.json");
const STALE_MS = 90_000;

interface CacheEntry {
  fetchedAt: number;
  usage: UsageSnapshot | null;
  error?: string;
}

type Cache = Record<string, CacheEntry>;

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(cache: Cache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CACHE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
  await rename(tmp, CACHE_PATH);
}

export async function statuslineCommand(config: Config): Promise<number> {
  const name = config.activeProfile;
  if (!name) {
    process.stdout.write(`${c.gray("cca: no profile")}\n`);
    return 0;
  }
  const profile = config.profiles[name];
  if (!profile) {
    process.stdout.write(`${c.gray(`cca: unknown profile ${name}`)}\n`);
    return 0;
  }

  const cache = await readCache();
  const entry = cache[name];
  const stale = !entry || Date.now() - entry.fetchedAt > STALE_MS;

  if (stale) spawnDetachedRefresh(name);

  const label = profile.label ?? name;
  if (!entry?.usage) {
    const marker = stale ? c.gray("…") : c.gray(symbols.warn);
    process.stdout.write(`${c.green(symbols.active)} ${label} ${marker}\n`);
    return 0;
  }

  const five = entry.usage.five_hour;
  const utilization = five?.utilization ?? null;
  const paint = limitColor(utilization);
  process.stdout.write(
    `${paint(symbols.active)} ${label} ` +
      `${paint(formatUtilization(utilization).trim())} ` +
      `${c.gray(`↻${formatReset(five?.resets_at)}`)}\n`,
  );
  return 0;
}

/** Refresh one profile's cached usage; used by the detached child. */
export async function refreshUsageCache(name: string): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles[name];
  if (!profile) return;

  const cache = await readCache();
  try {
    const oauth = await accessTokenFor(name, profile);
    cache[name] = { fetchedAt: Date.now(), usage: await fetchUsage(oauth.accessToken) };
  } catch (err) {
    // Keep the last good reading: a throttled or offline refresh should show a
    // slightly stale number rather than blanking the status line.
    cache[name] = {
      fetchedAt: Date.now(),
      usage: cache[name]?.usage ?? null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  await writeCache(cache);
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
