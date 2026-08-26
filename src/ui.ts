/** Terminal formatting — colours, limit bars, relative times. */

/**
 * Colour is off when piped, because tables and prompts are meant for a human
 * at a terminal. The status line is the exception: Claude Code always reads it
 * through a pipe and *does* render ANSI, so that path calls `setColor(true)`.
 */
function detectColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

let colorEnabled = detectColor();

/** NO_COLOR still wins — an explicit opt-out is never overridden. */
export function setColor(on: boolean): void {
  colorEnabled = on && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

export function colorIsOn(): boolean {
  return colorEnabled;
}

function paint(code: string) {
  return (s: string) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const c = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
  gray: paint("90"),
  // 256-colour accents for the status line. Terminals without 256-colour
  // support fall back to their nearest palette entry on their own.
  orange: paint("38;5;208"),
  violet: paint("38;5;141"),
  teal: paint("38;5;80"),
  lime: paint("38;5;149"),
  rose: paint("38;5;211"),
  steel: paint("38;5;110"),
};

/** Utilisation drives the colour: green under half, yellow, then red. */
export function limitColor(utilization: number | null | undefined): (s: string) => string {
  if (utilization === null || utilization === undefined) return c.gray;
  if (utilization >= 90) return c.red;
  if (utilization >= 75) return c.orange;
  if (utilization >= 60) return c.yellow;
  return c.green;
}

const BAR_FULL = "█";
const BAR_EMPTY = "░";
/** Eighth-width blocks let a 10-cell bar resolve to 1% instead of 10%. */
const BAR_PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * A proportional bar with sub-cell resolution.
 *
 * `ascii` keeps the old `#---` look for terminals with no block glyphs.
 */
export function bar(
  utilization: number | null | undefined,
  width = 10,
  style: "blocks" | "ascii" = "blocks",
): string {
  const full = style === "ascii" ? "#" : BAR_FULL;
  const empty = style === "ascii" ? "-" : BAR_EMPTY;
  if (utilization === null || utilization === undefined) return c.gray(empty.repeat(width));

  const clamped = Math.max(0, Math.min(100, utilization));
  const exact = (clamped / 100) * width;
  const filled = Math.floor(exact);
  const paintFn = limitColor(utilization);

  if (style === "ascii") {
    const rounded = Math.round(exact);
    return paintFn(full.repeat(rounded)) + c.gray(empty.repeat(width - rounded));
  }

  // A non-zero reading always shows at least a sliver, so "in use" never
  // renders as an empty bar.
  const eighths = Math.floor((exact - filled) * 8);
  const partial = filled < width ? BAR_PARTIAL[clamped > 0 && filled === 0 && eighths === 0 ? 1 : eighths]! : "";
  const rest = width - filled - (partial ? 1 : 0);
  return paintFn(full.repeat(filled) + partial) + c.gray(empty.repeat(Math.max(0, rest)));
}

/** "21:50" for today, "Mon 03:15" further out — reset times read better local. */
export function formatReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "—";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${time}`;
}

export function formatRelative(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function formatUtilization(utilization: number | null | undefined): string {
  if (utilization === null || utilization === undefined) return "  ?%";
  return `${String(Math.round(utilization)).padStart(3)}%`;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Visible width, ignoring colour codes — needed to lay out or trim a line. */
export function visibleLength(value: string): number {
  return value.replace(ANSI, "").length;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

export function pad(value: string, width: number): string {
  // Pad on the visible length so colour codes do not skew the columns.
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

export const symbols = {
  active: "●",
  inactive: "○",
  ok: "✓",
  warn: "!",
  fail: "✗",
};
