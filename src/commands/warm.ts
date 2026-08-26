/**
 * Session warm-up and token upkeep.
 *
 * A Claude subscription's 5-hour session window starts at the first request,
 * not at a fixed hour. Warming sends one minimal request so the window opens
 * at a time that suits the day — it shifts *when* the window runs, it does not
 * enlarge the quota.
 */
import { AuthExpiredError, fetchUsage, oauthOf, refreshTokenExpired, refreshTokens, warmSession } from "../api.ts";
import { requireProfile, saveConfig, type Config, type Profile } from "../config.ts";
import { withLock } from "../lock.ts";
import { accessTokenFor, NotLoggedInError } from "../session.ts";
import { readSlot, writeSlot } from "../store/index.ts";
import { c, formatReset, symbols } from "../ui.ts";

export interface WarmOptions {
  name?: string;
  all?: boolean;
  model?: string;
  /** Skip profiles whose session window is already open. */
  onlyIfCold?: boolean;
  json?: boolean;
}

export interface WarmOutcome {
  name: string;
  status: "warmed" | "already-open" | "skipped" | "failed";
  detail?: string;
  resetsAt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export async function warmCommand(config: Config, options: WarmOptions): Promise<number> {
  const targets = resolveTargets(config, options.name, options.all);
  if (targets.length === 0) {
    process.stderr.write(`${c.red(symbols.fail)} Nothing to warm — no matching profiles.\n`);
    return 1;
  }

  const model = options.model ?? config.warmup.model;
  const outcomes: WarmOutcome[] = [];
  for (const [name, profile] of targets) {
    outcomes.push(await warmProfile(name, profile, model, options.onlyIfCold ?? false));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results: outcomes }, null, 2)}\n`);
  } else {
    for (const outcome of outcomes) process.stdout.write(`${renderOutcome(outcome)}\n`);
  }
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

export async function warmProfile(
  name: string,
  profile: Profile,
  model: string,
  onlyIfCold: boolean,
): Promise<WarmOutcome> {
  try {
    const oauth = await accessTokenFor(name, profile);

    if (onlyIfCold) {
      const usage = await fetchUsage(oauth.accessToken);
      const open = isWindowOpen(usage.five_hour);
      if (open) {
        return {
          name,
          status: "already-open",
          resetsAt: usage.five_hour?.resets_at ?? null,
        };
      }
    }

    const result = await warmSession(oauth.accessToken, model);
    const usage = await fetchUsage(oauth.accessToken);
    return {
      name,
      status: "warmed",
      resetsAt: usage.five_hour?.resets_at ?? null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      return { name, status: "skipped", detail: "not logged in" };
    }
    return {
      name,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * A window counts as open when the account has measurable usage in it and a
 * reset time still ahead — that is what a warm-up would otherwise create.
 */
export function isWindowOpen(window: { utilization: number | null; resets_at: string | null } | null | undefined): boolean {
  if (!window?.resets_at) return false;
  const resetsAt = new Date(window.resets_at).getTime();
  if (Number.isNaN(resetsAt) || resetsAt <= Date.now()) return false;
  return (window.utilization ?? 0) > 0;
}

function renderOutcome(outcome: WarmOutcome): string {
  switch (outcome.status) {
    case "warmed":
      return (
        `${c.green(symbols.ok)} ${c.bold(outcome.name)} warmed ` +
        c.gray(
          `(${outcome.inputTokens ?? 0} in / ${outcome.outputTokens ?? 0} out) · ` +
            `window resets ${formatReset(outcome.resetsAt)}`,
        )
      );
    case "already-open":
      return `${c.gray(symbols.ok)} ${outcome.name} ${c.gray(`already open · resets ${formatReset(outcome.resetsAt)}`)}`;
    case "skipped":
      return `${c.yellow(symbols.warn)} ${outcome.name} ${c.gray(outcome.detail ?? "skipped")}`;
    case "failed":
      return `${c.red(symbols.fail)} ${outcome.name} ${c.red(outcome.detail ?? "failed")}`;
  }
}

export interface RefreshOptions {
  name?: string;
  all?: boolean;
  /** Rotate even when the current token still has life in it. */
  force?: boolean;
  json?: boolean;
}

export interface RefreshOutcome {
  name: string;
  status: "refreshed" | "still-valid" | "skipped" | "failed";
  detail?: string;
  expiresAt?: number;
}

/**
 * Keep idle profiles alive.
 *
 * Refresh tokens expire (~27 days on the accounts observed), so a profile left
 * untouched for a month would need a full re-login. The rotated pair is always
 * written back — dropping it would log the profile out.
 */
export async function refreshCommand(config: Config, options: RefreshOptions): Promise<number> {
  const targets = resolveTargets(config, options.name, options.all);
  if (targets.length === 0) {
    process.stderr.write(`${c.red(symbols.fail)} Nothing to refresh — no matching profiles.\n`);
    return 1;
  }

  const outcomes: RefreshOutcome[] = [];
  for (const [name, profile] of targets) {
    outcomes.push(await refreshProfile(name, profile, options.force ?? false));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results: outcomes }, null, 2)}\n`);
  } else {
    for (const outcome of outcomes) {
      const line =
        outcome.status === "refreshed"
          ? `${c.green(symbols.ok)} ${c.bold(outcome.name)} refreshed ${c.gray(`valid until ${new Date(outcome.expiresAt ?? 0).toLocaleString()}`)}`
          : outcome.status === "still-valid"
            ? `${c.gray(symbols.ok)} ${outcome.name} ${c.gray("still valid")}`
            : outcome.status === "skipped"
              ? `${c.yellow(symbols.warn)} ${outcome.name} ${c.gray(outcome.detail ?? "skipped")}`
              : `${c.red(symbols.fail)} ${outcome.name} ${c.red(outcome.detail ?? "failed")}`;
      process.stdout.write(`${line}\n`);
    }
  }
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

export async function refreshProfile(
  name: string,
  profile: Profile,
  force: boolean,
): Promise<RefreshOutcome> {
  try {
    if (!force) {
      const oauth = await accessTokenFor(name, profile);
      return { name, status: "still-valid", expiresAt: oauth.expiresAt };
    }

    return await withLock(`token-${name}`, async () => {
      const blob = (await readSlot(profile.dir)) ?? {};
      const oauth = oauthOf(blob);
      if (!oauth) return { name, status: "skipped", detail: "not logged in" } as const;
      if (refreshTokenExpired(oauth)) {
        return { name, status: "failed", detail: "refresh token expired — re-login required" } as const;
      }
      const rotated = await refreshTokens(oauth);
      await writeSlot(profile.dir, { ...blob, claudeAiOauth: rotated });
      return { name, status: "refreshed", expiresAt: rotated.expiresAt } as const;
    });
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      return { name, status: "skipped", detail: "not logged in" };
    }
    if (err instanceof AuthExpiredError) {
      return { name, status: "failed", detail: err.message };
    }
    return { name, status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

function resolveTargets(
  config: Config,
  name: string | undefined,
  all: boolean | undefined,
): Array<[string, Profile]> {
  if (name) return [[name, requireProfile(config, name)]];
  if (all) return Object.entries(config.profiles);
  const active = config.activeProfile;
  if (active) return [[active, requireProfile(config, active)]];
  return Object.entries(config.profiles);
}

/** Persist warm-up settings edited via `cca warmup ...`. */
export async function configureWarmup(
  config: Config,
  patch: Partial<Config["warmup"]>,
): Promise<number> {
  config.warmup = { ...config.warmup, ...patch };
  await saveConfig(config);
  process.stdout.write(
    `${c.green(symbols.ok)} Warm-up: ${config.warmup.enabled ? c.bold(config.warmup.mode) : c.gray("disabled")}` +
      (config.warmup.mode === "schedule" ? c.gray(` at ${config.warmup.at.join(", ")}`) : "") +
      `\n`,
  );
  return 0;
}
