/** Terminal formatting — colours, limit bars, relative times. */
const noColor =
  process.env.NO_COLOR !== undefined ||
  process.env.TERM === "dumb" ||
  !process.stdout.isTTY;

function paint(code: string) {
  return (s: string) => (noColor ? s : `\x1b[${code}m${s}\x1b[0m`);
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
};

/** Utilisation drives the colour: green under half, yellow, then red. */
export function limitColor(utilization: number | null | undefined): (s: string) => string {
  if (utilization === null || utilization === undefined) return c.gray;
  if (utilization >= 90) return c.red;
  if (utilization >= 60) return c.yellow;
  return c.green;
}

const BAR_FULL = "█";
const BAR_EMPTY = "░";

export function bar(utilization: number | null | undefined, width = 10): string {
  if (utilization === null || utilization === undefined) return c.gray(BAR_EMPTY.repeat(width));
  const clamped = Math.max(0, Math.min(100, utilization));
  const filled = Math.round((clamped / 100) * width);
  const paintFn = limitColor(utilization);
  return paintFn(BAR_FULL.repeat(filled)) + c.gray(BAR_EMPTY.repeat(width - filled));
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

export function pad(value: string, width: number): string {
  // Pad on the visible length so colour codes do not skew the columns.
  const visible = value.replace(/\x1b\[[0-9;]*m/g, "").length;
  return value + " ".repeat(Math.max(0, width - visible));
}

export const symbols = {
  active: "●",
  inactive: "○",
  ok: "✓",
  warn: "!",
  fail: "✗",
};
