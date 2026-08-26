import type { Config } from "../config.ts";
import { statusAll, type ProfileStatus } from "../session.ts";
import {
  bar,
  c,
  formatDeadline,
  formatRelative,
  formatReset,
  formatUtilization,
  limitColor,
  LOGIN_URGENT_MS,
  LOGIN_WARN_MS,
  pad,
  symbols,
} from "../ui.ts";

export interface ListOptions {
  json?: boolean;
  /** Skip the network round-trip when only names are needed. */
  noUsage?: boolean;
}

export async function listCommand(config: Config, options: ListOptions = {}): Promise<number> {
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ profiles: [] }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      `${c.yellow("No profiles yet.")}\n` +
        `Run ${c.bold("cca import")} to bring your current Claude Code session in,\n` +
        `then ${c.bold("cca login <name>")} to add the second account.\n`,
    );
    return 0;
  }

  const statuses = await statusAll(config, { usage: !options.noUsage });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ profiles: statuses.map(toJson) }, null, 2)}\n`);
    return 0;
  }

  const nameWidth = Math.max(4, ...names.map((n) => n.length));
  const emailWidth = Math.max(
    5,
    ...statuses.map((s) => (s.profile.email ?? "").length),
  );

  const header =
    `  ${pad("NAME", nameWidth)}  ${pad("ACCOUNT", emailWidth)}  ` +
    `${pad("SESSION (5h)", 24)}  ${pad("WEEK", 18)}  MODE`;
  process.stdout.write(`${c.gray(header)}\n`);

  for (const status of statuses) {
    process.stdout.write(`${renderRow(status, nameWidth, emailWidth)}\n`);
  }

  const footer = loginWarnings(statuses);
  if (footer) process.stdout.write(`\n${footer}\n`);
  return 0;
}

/**
 * Warn about logins about to lapse.
 *
 * Rotation does not move this deadline, so an account nobody touches simply
 * stops working one day. This line is the notice.
 */
export function loginWarnings(statuses: ProfileStatus[]): string | null {
  const now = Date.now();
  const due = statuses
    .filter((s) => s.loginExpiresAt !== undefined && s.loginExpiresAt - now <= LOGIN_WARN_MS)
    .sort((a, b) => a.loginExpiresAt! - b.loginExpiresAt!);
  if (due.length === 0) return null;

  return due
    .map((status) => {
      const remaining = status.loginExpiresAt! - now;
      const paint = remaining <= LOGIN_URGENT_MS ? c.red : c.yellow;
      return remaining <= 0
        ? `${c.red(symbols.fail)} ${status.name} is logged out — run ${c.bold(`cca login ${status.name}`)}`
        : `${paint("!")} ${status.name} needs a new login in ${paint(formatDeadline(remaining))} — ` +
            `run ${c.bold(`cca login ${status.name}`)} ${c.gray("(rotating tokens does not extend it)")}`;
    })
    .join("\n");
}

function renderRow(status: ProfileStatus, nameWidth: number, emailWidth: number): string {
  const marker = status.active ? c.green(symbols.active) : c.gray(symbols.inactive);
  const name = status.active ? c.bold(status.name) : status.name;
  const email = c.gray(status.profile.email ?? "—");
  const mode = c.gray(status.profile.mode);

  if (!status.loggedIn) {
    return `${marker} ${pad(name, nameWidth)}  ${pad(email, emailWidth)}  ${c.red("not logged in")}`;
  }
  if (!status.usage) {
    const why = status.throttled
      ? c.gray("limits throttled — retry shortly")
      : status.error
        ? c.red(truncate(status.error, 46))
        : c.gray("no usage data");
    return `${marker} ${pad(name, nameWidth)}  ${pad(email, emailWidth)}  ${why}`;
  }

  const five = status.usage.five_hour;
  const week = status.usage.seven_day;

  const sessionCell =
    `${bar(five?.utilization, 10)} ${limitColor(five?.utilization)(formatUtilization(five?.utilization))} ` +
    c.gray(`↻${formatReset(five?.resets_at)}`);
  const weekCell =
    `${limitColor(week?.utilization)(formatUtilization(week?.utilization))} ` +
    c.gray(`↻${formatRelative(week?.resets_at)}`);

  return (
    `${marker} ${pad(name, nameWidth)}  ${pad(email, emailWidth)}  ` +
    `${pad(sessionCell, 24)}  ${pad(weekCell, 18)}  ${mode}`
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function toJson(status: ProfileStatus) {
  return {
    name: status.name,
    active: status.active,
    loggedIn: status.loggedIn,
    email: status.profile.email ?? null,
    mode: status.profile.mode,
    dir: status.profile.dir,
    lastUsedAt: status.profile.lastUsedAt ?? null,
    fiveHour: status.usage?.five_hour ?? null,
    sevenDay: status.usage?.seven_day ?? null,
    throttled: status.throttled ?? false,
    error: status.error ?? null,
  };
}
