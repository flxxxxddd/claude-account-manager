/**
 * Status-line segments.
 *
 * Each segment renders from an already-gathered context and returns null when
 * it has nothing to say, so an absent git repo or a second account that was
 * never added simply leaves no gap.
 */
import { basename } from "node:path";
import type { BarStyle, Config, Profile } from "../config.ts";
import {
  bar,
  c,
  formatDeadline,
  formatRelative,
  formatReset,
  limitColor,
  LOGIN_URGENT_MS,
  LOGIN_WARN_MS,
  symbols,
} from "../ui.ts";
import type { Projection } from "./burn.ts";
import type { GitState } from "./git.ts";
import type { StatuslinePayload } from "./payload.ts";

export interface Window {
  utilization: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
}

export interface OtherAccount {
  name: string;
  label: string;
  /** Five-hour utilisation — what the segment shows. */
  utilization: number | null;
  /** Highest utilisation across every window — what the hint decides on. */
  binding: number | null;
  /** When this account's refresh token dies and a browser login is required. */
  loginExpiresAt: number | null;
  resetsAt: number | null;
  stale: boolean;
}

export interface RenderContext {
  config: Config;
  payload: StatuslinePayload | null;
  activeName: string | null;
  activeProfile: Profile | null;
  fiveHour: Window;
  sevenDay: Window;
  /** Highest utilisation across the active account's windows. */
  binding: number | null;
  /** When the active account's refresh token dies. */
  loginExpiresAt: number | null;
  /** Tool calls so far this session, or null when not counted. */
  tools: number | null;
  projection: Projection | null;
  others: OtherAccount[];
  git: GitState | null;
  barWidth: number;
  barStyle: BarStyle;
  now: number;
}

export type Segment = (ctx: RenderContext) => string | null;

function relative(epochMs: number | null): string {
  return epochMs === null ? "" : formatRelative(new Date(epochMs).toISOString());
}

function percent(utilization: number | null): string {
  return utilization === null ? "?%" : `${Math.round(utilization)}%`;
}

/** `5h ▉░░░░░░░░░ 43% ↻21m` — the shape both limit windows share. */
function windowSegment(label: string, window: Window, ctx: RenderContext): string | null {
  if (window.utilization === null && window.resetsAt === null) return null;
  const paintFn = limitColor(window.utilization);
  const reset = relative(window.resetsAt);
  return (
    `${c.gray(label)} ${bar(window.utilization, ctx.barWidth, ctx.barStyle)} ` +
    `${paintFn(percent(window.utilization))}` +
    (reset ? ` ${c.gray(`↻${reset}`)}` : "")
  );
}

/** Below this the rate rounds to 0.0%/m and says nothing worth the space. */
const VISIBLE_RATE = 0.05;

/** Only this much idle quota elsewhere justifies suggesting a switch. */
const SWITCH_ADVANTAGE = 30;
/** Below this the current account is fine and the suggestion is noise. */
const SWITCH_PRESSURE = 70;

/**
 * The account worth switching to, or null when staying put is right.
 *
 * A stale reading is never recommended — suggesting a switch on a number from
 * an hour ago is worse than suggesting nothing.
 */
function betterAccount(ctx: RenderContext): string | null {
  // Both sides are judged on their binding window. Comparing five-hour figures
  // would happily send you to an account that is idle this hour and spent for
  // the week.
  const current = ctx.binding;
  if (current === null || current < SWITCH_PRESSURE) return null;

  let best: OtherAccount | null = null;
  for (const other of ctx.others) {
    if (other.stale || other.binding === null) continue;
    if (other.binding > current - SWITCH_ADVANTAGE) continue;
    if (!best || other.binding < best.binding!) best = other;
  }
  return best?.name ?? null;
}

export const segments: Record<string, Segment> = {
  account(ctx) {
    if (!ctx.activeName) return c.gray("no profile");
    const label = ctx.activeProfile?.label ?? ctx.activeName;
    const dot = limitColor(ctx.fiveHour.utilization)(symbols.active);
    const plan = ctx.activeProfile?.subscriptionType;
    return `${dot} ${c.bold(label)}${plan ? c.gray(` ${plan}`) : ""}`;
  },

  limits(ctx) {
    const parts = [
      windowSegment("5h", ctx.fiveHour, ctx),
      windowSegment("7d", ctx.sevenDay, ctx),
    ].filter((p): p is string => p !== null);
    return parts.length ? parts.join("  ") : null;
  },

  /**
   * The projection only earns its space when it changes a decision: either the
   * window runs out early, or the rate is high enough to be worth watching.
   * An idle session drifts at a rate that rounds to zero, and "⇗0.0%/m" is
   * noise dressed up as information.
   */
  burn(ctx) {
    const projection = ctx.projection;
    if (!projection) return null;
    const rate = `⇗${projection.rate.toFixed(1)}%/m`;
    if (!projection.beforeReset) return projection.rate < VISIBLE_RATE ? null : c.gray(rate);
    const at = formatReset(new Date(projection.capsAt).toISOString());
    const paintFn = projection.capsAt - ctx.now < 30 * 60_000 ? c.red : c.orange;
    return paintFn(`${rate} caps ${at}`);
  },

  /**
   * The one thing a single-account status line cannot show.
   *
   * The account worth switching to is marked with an arrow instead of a bullet,
   * which is the whole point of running a manager: knowing that the other
   * login still has room is only useful if you notice it before you run out.
   */
  others(ctx) {
    if (ctx.others.length === 0) return null;
    const better = betterAccount(ctx);
    return ctx.others
      .map((other) => {
        const isBetter = other.name === better;
        const paintFn = other.stale ? c.gray : limitColor(other.utilization);
        const reset = relative(other.resetsAt);
        const marker = isBetter ? c.green("↦") : c.gray(symbols.inactive);
        const label = isBetter ? c.bold(other.label) : c.gray(other.label);
        return (
          `${marker} ${label} ${paintFn(percent(other.utilization))}` +
          (reset ? ` ${c.gray(`↻${reset}`)}` : "")
        );
      })
      .join("  ");
  },

  /**
   * Advance notice that an account is about to need a browser login.
   *
   * Rotating tokens does not move this deadline — it is fixed at login, about
   * 28 days out — so an account left alone simply dies on schedule. Silence
   * until the last week, then a countdown; anything more would be noise for
   * twenty-one days running.
   */
  login(ctx) {
    const deadlines: { label: string; at: number }[] = [];
    if (ctx.loginExpiresAt !== null && ctx.activeName) {
      deadlines.push({ label: ctx.activeProfile?.label ?? ctx.activeName, at: ctx.loginExpiresAt });
    }
    for (const other of ctx.others) {
      if (other.loginExpiresAt !== null) {
        deadlines.push({ label: other.label, at: other.loginExpiresAt });
      }
    }

    const due = deadlines
      .filter((entry) => entry.at - ctx.now <= LOGIN_WARN_MS)
      .sort((a, b) => a.at - b.at);
    if (due.length === 0) return null;

    return due
      .map((entry) => {
        const remaining = entry.at - ctx.now;
        const paintFn = remaining <= LOGIN_URGENT_MS ? c.red : c.orange;
        const mark = remaining <= 0 ? symbols.fail : "⚠";
        return paintFn(`${mark} ${entry.label} login ${formatDeadline(remaining)}`);
      })
      .join("  ");
  },

  model(ctx) {
    const model = ctx.payload?.model?.display_name;
    if (!model) return null;
    const flags: string[] = [];
    const effort = ctx.payload?.effort?.level;
    if (effort && effort !== "medium") flags.push(effort);
    if (ctx.payload?.thinking?.enabled) flags.push("think");
    if (ctx.payload?.fast_mode) flags.push("fast");
    const style = ctx.payload?.output_style?.name;
    if (style && style !== "default") flags.push(style);
    return c.teal(model) + (flags.length ? c.gray(` ·${flags.join(" ·")}`) : "");
  },

  ctx(ctx) {
    const window = ctx.payload?.context_window;
    if (!window || window.used_percentage === undefined) return null;
    const used = window.used_percentage;
    const size = window.context_window_size;
    // A 1M window is worth calling out: the same percentage means something
    // very different when the denominator is five times larger.
    const suffix = size && size >= 1_000_000 ? c.gray("/1M") : "";
    return `${c.gray("ctx")} ${bar(used, ctx.barWidth, ctx.barStyle)} ${limitColor(used)(percent(used))}${suffix}`;
  },

  git(ctx) {
    const git = ctx.git;
    if (!git) return null;
    const parts = [`${c.gray("⎇")} ${c.violet(git.branch)}`];
    if (git.ahead) parts.push(c.teal(`↑${git.ahead}`));
    if (git.behind) parts.push(c.teal(`↓${git.behind}`));
    if (git.conflicted) parts.push(c.red(`✗${git.conflicted}`));
    if (git.modified) parts.push(c.yellow(`!${git.modified}`));
    if (git.untracked) parts.push(c.gray(`?${git.untracked}`));
    if (git.countsUnknown) parts.push(c.gray("…"));
    return parts.join(" ");
  },

  cost(ctx) {
    const cost = ctx.payload?.cost;
    if (!cost) return null;
    const parts: string[] = [];
    if (cost.total_cost_usd !== undefined) parts.push(c.lime(`$${cost.total_cost_usd.toFixed(2)}`));
    const added = cost.total_lines_added ?? 0;
    const removed = cost.total_lines_removed ?? 0;
    if (added || removed) parts.push(`${c.green(`+${added}`)}${c.gray("/")}${c.red(`-${removed}`)}`);
    return parts.length ? parts.join(" ") : null;
  },

  tools(ctx) {
    return ctx.tools === null ? null : c.gray(`⚒${ctx.tools}`);
  },

  uptime(ctx) {
    const ms = ctx.payload?.cost?.total_duration_ms;
    if (ms === undefined) return null;
    const minutes = Math.floor(ms / 60_000);
    const text = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
    return c.gray(text);
  },

  dir(ctx) {
    const dir = ctx.payload?.workspace?.current_dir ?? ctx.payload?.cwd;
    return dir ? c.steel(basename(dir)) : null;
  },

  warmup(ctx) {
    const warmup = ctx.config.warmup;
    if (!warmup.enabled) return null;
    return c.gray(`♨${warmup.mode}`);
  },

  version(ctx) {
    const version = ctx.payload?.version;
    return version ? c.gray(`cc${version}`) : null;
  },
};
