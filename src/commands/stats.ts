/**
 * `cca stats` — what the quota actually goes on.
 *
 * Built entirely from readings the status line already took, so this costs no
 * requests and works offline. It answers two questions a single percentage
 * cannot: how close to the ceiling a normal window gets, and which hours of
 * the day the quota disappears in.
 */
import type { Config } from "../config.ts";
import { readHistory, type HistoryPoint } from "../statusline/burn.ts";
import { bar, c, limitColor, pad, symbols } from "../ui.ts";

export interface WindowSummary {
  /** The window's reset timestamp, or null for readings taken without one. */
  window: number | null;
  start: number;
  end: number;
  peak: number;
}

export interface ProfileStats {
  name: string;
  windows: WindowSummary[];
  /** Percent burned, indexed by local hour of day. */
  byHour: number[];
  points: number;
}

/**
 * Group readings into the windows they belong to.
 *
 * A window is identified by its reset timestamp, not by a time range: two
 * windows can otherwise blur together across a gap when nothing was recorded.
 */
export function summariseWindows(points: HistoryPoint[]): WindowSummary[] {
  const byWindow = new Map<string, WindowSummary>();
  for (const point of points) {
    const key = String(point.w);
    const existing = byWindow.get(key);
    if (!existing) {
      byWindow.set(key, { window: point.w, start: point.t, end: point.t, peak: point.u });
      continue;
    }
    existing.start = Math.min(existing.start, point.t);
    existing.end = Math.max(existing.end, point.t);
    existing.peak = Math.max(existing.peak, point.u);
  }
  return [...byWindow.values()].sort((a, b) => a.start - b.start);
}

/**
 * Quota burned per hour of the local day.
 *
 * Only rises count. A window reset shows up as utilisation dropping, and
 * treating that as negative burn would quietly cancel out real usage.
 */
export function burnByHour(points: HistoryPoint[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    if (previous.w !== current.w) continue;
    const delta = current.u - previous.u;
    if (delta > 0) hours[new Date(current.t).getHours()]! += delta;
  }
  return hours;
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  const peak = Math.max(...values);
  if (peak <= 0) return SPARK[0]!.repeat(values.length);
  return values
    .map((value) => SPARK[Math.min(SPARK.length - 1, Math.round((value / peak) * (SPARK.length - 1)))]!)
    .join("");
}

export async function collectStats(name: string, sinceMs: number): Promise<ProfileStats> {
  const points = (await readHistory(name)).filter((point) => point.t >= sinceMs);
  return {
    name,
    windows: summariseWindows(points),
    byHour: burnByHour(points),
    points: points.length,
  };
}

export interface StatsOptions {
  name?: string;
  days?: number;
  json?: boolean;
}

export async function statsCommand(config: Config, options: StatsOptions = {}): Promise<number> {
  const names = options.name ? [options.name] : Object.keys(config.profiles);
  if (names.length === 0) {
    process.stderr.write(`${c.red(symbols.fail)} No profiles configured.\n`);
    return 1;
  }

  const days = Math.max(1, options.days ?? 7);
  const since = Date.now() - days * 86_400_000;
  const stats = await Promise.all(names.map((name) => collectStats(name, since)));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ days, profiles: stats }, null, 2)}\n`);
    return 0;
  }

  const measured = stats.filter((entry) => entry.points > 0);
  if (measured.length === 0) {
    process.stdout.write(
      `${c.gray(`No history yet for the last ${days} days.`)}\n` +
        `Readings accumulate while ${c.bold("cca statusline")} runs in Claude Code.\n`,
    );
    return 0;
  }

  for (const entry of measured) {
    process.stdout.write(`${render(entry, days)}\n`);
  }
  return 0;
}

function render(stats: ProfileStats, days: number): string {
  const peaks = stats.windows.map((w) => w.peak);
  const average = peaks.reduce((sum, value) => sum + value, 0) / peaks.length;
  const highest = Math.max(...peaks);
  const capped = peaks.filter((peak) => peak >= 99).length;

  const lines = [
    `${c.bold(stats.name)} ${c.gray(`· last ${days} day${days === 1 ? "" : "s"}`)}`,
    `  ${c.gray("windows")}  ${stats.windows.length} seen · ` +
      `peak ${limitColor(average)(`${Math.round(average)}% avg`)} · ` +
      `${limitColor(highest)(`${Math.round(highest)}% worst`)}` +
      (capped ? c.red(` · ${capped} ran out`) : ""),
    `  ${c.gray("by hour")}  ${c.cyan(sparkline(stats.byHour))}`,
    `           ${c.gray("0h        6h        12h       18h    23h")}`,
  ];

  const recent = stats.windows.slice(-5).reverse();
  if (recent.length > 0) {
    lines.push(`  ${c.gray("recent")}`);
    for (const window of recent) {
      // Built from the two parts rather than `toLocaleString`, whose combined
      // form inserts a connecting word in most locales and breaks the column.
      const at = new Date(window.start);
      const when =
        `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ` +
        `${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
      lines.push(
        `    ${pad(c.gray(when), 14)}  ${bar(window.peak, 12)} ${limitColor(window.peak)(`${Math.round(window.peak)}%`)}`,
      );
    }
  }
  return lines.join("\n");
}
