/** Launch Claude Code pinned to a profile. */
import { profileEnv } from "../cc-paths.ts";
import { requireProfile, saveConfig, type Config } from "../config.ts";
import { statusAll, statusOf } from "../session.ts";
import { bestByLimit, pickProfile } from "../tui/picker.ts";
import { c, formatDeadline, LOGIN_WARN_MS, symbols } from "../ui.ts";
import { runClaude } from "./profiles.ts";

export interface RunOptions {
  /** Explicit profile name; omitted means "decide below". */
  name?: string;
  /** Reuse the active profile without showing the picker. */
  last?: boolean;
  /** Pick whichever account has the most session quota left. */
  best?: boolean;
  /** Arguments forwarded verbatim to `claude`. */
  claudeArgs: string[];
}

export async function runCommand(config: Config, options: RunOptions): Promise<number> {
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    process.stderr.write(
      `${c.red(symbols.fail)} No profiles configured.\n` +
        `  Run ${c.bold("cca import")} to adopt your current session.\n`,
    );
    return 1;
  }

  const chosen = await resolveProfileName(config, options);
  if (!chosen) {
    process.stderr.write(`${c.gray("Cancelled.")}\n`);
    return 130;
  }

  const profile = requireProfile(config, chosen);

  config.activeProfile = chosen;
  config.profiles[chosen] = { ...profile, lastUsedAt: new Date().toISOString() };
  await saveConfig(config);

  process.stderr.write(
    `${c.green(symbols.active)} ${c.bold(chosen)}` +
      `${profile.email ? c.gray(` · ${profile.email}`) : ""}` +
      `${c.gray(` · ${profile.mode}`)}\n`,
  );

  return runClaude(options.claudeArgs, profileEnv(profile.dir, profile.mode));
}

async function resolveProfileName(config: Config, options: RunOptions): Promise<string | undefined> {
  if (options.name) {
    requireProfile(config, options.name);
    return options.name;
  }

  if (options.last) {
    return config.activeProfile ?? Object.keys(config.profiles)[0];
  }

  if (options.best) {
    const statuses = await statusAll(config);
    const best = bestByLimit(statuses);
    if (!best) {
      process.stderr.write(`${c.red(symbols.fail)} No profile has usable credentials.\n`);
      return undefined;
    }
    return best.name;
  }

  const statuses = await statusAll(config);
  const picked = await pickProfile(statuses, { title: "Launch Claude Code as" });
  return picked?.name;
}

/** `cca status` — the active profile in detail. */
export async function statusCommand(
  config: Config,
  options: { json?: boolean; name?: string } = {},
): Promise<number> {
  const name = options.name ?? config.activeProfile;
  if (!name) {
    process.stderr.write(`${c.red(symbols.fail)} No active profile.\n`);
    return 1;
  }
  const profile = requireProfile(config, name);
  const status = await statusOf(name, profile, name === config.activeProfile);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: status.name,
          active: status.active,
          loggedIn: status.loggedIn,
          email: profile.email ?? null,
          organization: profile.organizationName ?? null,
          subscriptionType: profile.subscriptionType ?? null,
          mode: profile.mode,
          dir: profile.dir,
          usage: status.usage ?? null,
          loginExpiresAt: status.loginExpiresAt
            ? new Date(status.loginExpiresAt).toISOString()
            : null,
          error: status.error ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return status.loggedIn ? 0 : 1;
  }

  const lines = [
    `${c.bold(status.name)}${status.active ? c.green(` ${symbols.active} active`) : ""}`,
    `  account       ${profile.email ?? c.gray("unknown")}`,
    `  organization  ${profile.organizationName ?? c.gray("unknown")}`,
    `  plan          ${profile.subscriptionType ?? c.gray("unknown")}`,
    `  isolation     ${profile.mode}`,
    `  storage       ${c.gray(profile.dir)}`,
  ];
  if (status.usage) {
    const five = status.usage.five_hour;
    const week = status.usage.seven_day;
    lines.push(
      `  session (5h)  ${format(five?.utilization)} ${c.gray(`resets ${five?.resets_at ?? "—"}`)}`,
      `  week          ${format(week?.utilization)} ${c.gray(`resets ${week?.resets_at ?? "—"}`)}`,
    );
  }
  if (status.loginExpiresAt !== undefined) {
    const remaining = status.loginExpiresAt - Date.now();
    const text = `${formatDeadline(remaining)} ${c.gray(`(${new Date(status.loginExpiresAt).toLocaleDateString()})`)}`;
    lines.push(`  login expires  ${remaining <= LOGIN_WARN_MS ? c.orange(text) : text}`);
  }
  if (status.error) lines.push(`  ${c.red(status.error)}`);

  process.stdout.write(`${lines.join("\n")}\n`);
  return status.loggedIn ? 0 : 1;
}

function format(utilization: number | null | undefined): string {
  return utilization === null || utilization === undefined
    ? c.gray("unknown")
    : `${Math.round(utilization)}%`;
}
