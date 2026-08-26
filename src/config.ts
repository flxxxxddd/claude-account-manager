/** The manager's own state: ~/.ccacc/config.json plus per-profile dirs. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IsolationMode } from "./cc-paths.ts";

export const CCA_HOME = process.env.CCA_HOME || join(homedir(), ".ccacc");
export const CONFIG_PATH = join(CCA_HOME, "config.json");
export const PROFILES_DIR = join(CCA_HOME, "profiles");

export interface Profile {
  /** "shared" keeps history/settings/plugins in ~/.claude; only creds differ. */
  mode: IsolationMode;
  /** Storage directory handed to Claude Code via env. */
  dir: string;
  email?: string;
  accountUuid?: string;
  organizationName?: string;
  subscriptionType?: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Optional per-profile colour/label for the picker and statusline. */
  label?: string;
}

export type WarmupMode = "off" | "schedule" | "smart";

export interface WarmupConfig {
  enabled: boolean;
  mode: WarmupMode;
  /** Local wall-clock times for "schedule" mode, e.g. ["08:00"]. */
  at: string[];
  /** Empty means every profile. */
  profiles: string[];
  model: string;
  /** Keep idle profiles' refresh tokens alive (~27 day expiry). */
  refreshTokens: boolean;
  /** "smart" mode poll interval, minutes. */
  pollMinutes: number;
}

export interface NotificationConfig {
  enabled: boolean;
  /** A fresh session window opened after a warm-up. */
  onWarm: boolean;
  /** The account in use is nearly spent and another one has room. */
  onLimit: boolean;
  /** A login is about to lapse and only a browser can renew it. */
  onLoginExpiry: boolean;
  /** Utilisation, in percent, at which `onLimit` fires. */
  limitThreshold: number;
}

export type BarStyle = "blocks" | "ascii";

export interface StatuslineConfig {
  /**
   * Segments to draw, one array per rendered line. Unknown names are skipped,
   * so trimming the HUD is a matter of deleting entries.
   *
   * Available: account, limits, burn, others, login, model, ctx, git, cost,
   * tools, uptime, dir, warmup, version.
   */
  lines: string[][];
  barWidth: number;
  barStyle: BarStyle;
  /** "off" drops ANSI even though Claude Code renders it. */
  color: "on" | "off";
}

export interface Config {
  version: 1;
  activeProfile?: string;
  profiles: Record<string, Profile>;
  warmup: WarmupConfig;
  statusline: StatuslineConfig;
  notifications: NotificationConfig;
}

export const DEFAULT_WARMUP: WarmupConfig = {
  enabled: false,
  mode: "smart",
  at: ["08:00"],
  profiles: [],
  model: "claude-haiku-4-5-20251001",
  refreshTokens: true,
  pollMinutes: 5,
};

export const DEFAULT_STATUSLINE: StatuslineConfig = {
  lines: [
    ["account", "limits", "burn", "others", "login"],
    ["model", "ctx", "git", "cost", "tools", "uptime"],
  ],
  barWidth: 10,
  barStyle: "blocks",
  color: "on",
};

/** Off by default: a tool that starts popping up windows unasked is a nuisance. */
export const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  enabled: false,
  onWarm: true,
  onLimit: true,
  onLoginExpiry: true,
  limitThreshold: 90,
};

const EMPTY: Config = {
  version: 1,
  profiles: {},
  warmup: { ...DEFAULT_WARMUP },
  statusline: structuredClone(DEFAULT_STATUSLINE),
  notifications: { ...DEFAULT_NOTIFICATIONS },
};

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<Config>;
  return {
    version: 1,
    activeProfile: parsed.activeProfile,
    profiles: parsed.profiles ?? {},
    warmup: { ...DEFAULT_WARMUP, ...(parsed.warmup ?? {}) },
    statusline: { ...structuredClone(DEFAULT_STATUSLINE), ...(parsed.statusline ?? {}) },
    notifications: { ...DEFAULT_NOTIFICATIONS, ...(parsed.notifications ?? {}) },
  };
}

/** Key-order-independent comparison, for deciding what is worth writing. */
function sameShape(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, inner) =>
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner as object).sort(([x], [y]) => x.localeCompare(y)))
        : inner,
    );
  return stable(a) === stable(b);
}

/**
 * Write the config, leaving out sections the user has not changed.
 *
 * Persisting a whole section of defaults freezes them: a later release that
 * adds a status-line segment or a warm-up option would never reach anyone
 * whose config had been written once — and every command that touches the
 * config writes it. Omitting untouched sections keeps them following the
 * defaults until the user actually has an opinion.
 */
export function serialisableConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  if (sameShape(config.statusline, DEFAULT_STATUSLINE)) delete out.statusline;
  if (sameShape(config.notifications, DEFAULT_NOTIFICATIONS)) delete out.notifications;
  if (sameShape(config.warmup, DEFAULT_WARMUP)) delete out.warmup;
  return out;
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CCA_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(serialisableConfig(config), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, CONFIG_PATH);
}

export function profileDir(name: string): string {
  return join(PROFILES_DIR, name);
}

export async function ensureProfileDir(name: string): Promise<string> {
  const dir = profileDir(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Profile names double as directory names, so keep them boring. */
export function validateProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    throw new Error(
      `invalid profile name "${name}" — use letters, digits, dot, dash or underscore`,
    );
  }
}

export function requireProfile(config: Config, name: string): Profile {
  const profile = config.profiles[name];
  if (!profile) {
    const known = Object.keys(config.profiles);
    throw new Error(
      known.length
        ? `no profile "${name}" — known profiles: ${known.join(", ")}`
        : `no profile "${name}" — run \`cca import\` to add your current session`,
    );
  }
  return profile;
}
