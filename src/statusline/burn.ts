/**
 * Burn rate for the five-hour window.
 *
 * Claude Code reports how much of the window is spent but not how fast it is
 * going, so the answer everyone actually wants — "will I hit the wall before
 * this resets?" — is unanswerable from one reading. Sampling utilisation over
 * the life of the window turns it into arithmetic: fit a rate, extend it to
 * 100%, and compare that moment with the reset.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CCA_HOME } from "../config.ts";

const BURN_PATH = join(CCA_HOME, "cache", "burn.json");
const HISTORY_DIR = join(CCA_HOME, "history");
/** How much history `cca stats` can look back over. */
const HISTORY_KEEP_MS = 60 * 86_400_000;

/** Two samples closer than this add noise, not signal. */
const MIN_SAMPLE_GAP_MS = 20_000;
/** Enough history to smooth a burst without outliving a five-hour window. */
const MAX_SAMPLES = 120;
/** A rate fitted over less than this is dominated by a single turn. */
const MIN_SPAN_MS = 4 * 60_000;
/** Recent behaviour predicts the next hour better than the whole window does. */
const WINDOW_MS = 45 * 60_000;

export interface Sample {
  /** Epoch milliseconds. */
  t: number;
  /** Utilisation percent. */
  u: number;
}

interface ProfileBurn {
  /** Reset timestamp identifying the window these samples belong to. */
  window: number | null;
  samples: Sample[];
}

type BurnFile = Record<string, ProfileBurn>;

export interface Projection {
  /** Percent per minute. */
  rate: number;
  /** Epoch ms when utilisation would reach 100%. */
  capsAt: number;
  /** True when the cap lands before the window resets. */
  beforeReset: boolean;
}

export async function readBurn(): Promise<BurnFile> {
  try {
    return JSON.parse(await readFile(BURN_PATH, "utf8")) as BurnFile;
  } catch {
    return {};
  }
}

async function writeBurn(data: BurnFile): Promise<void> {
  try {
    await mkdir(join(CCA_HOME, "cache"), { recursive: true, mode: 0o700 });
    const tmp = `${BURN_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, BURN_PATH);
  } catch {
    // Losing a sample only delays the projection by one turn.
  }
}

/**
 * Fold one reading in and return the samples for the current window.
 *
 * A changed reset timestamp means a new window opened, so the old samples
 * describe a quota that no longer exists and are dropped.
 */
export function foldSample(
  previous: ProfileBurn | undefined,
  utilization: number,
  resetsAt: number | null,
  now: number,
): { entry: ProfileBurn; changed: boolean } {
  const sameWindow = previous && previous.window === resetsAt;
  const samples = sameWindow ? [...previous.samples] : [];

  const last = samples[samples.length - 1];
  if (last && now - last.t < MIN_SAMPLE_GAP_MS && last.u === utilization) {
    return { entry: { window: resetsAt, samples }, changed: !sameWindow };
  }
  samples.push({ t: now, u: utilization });
  return {
    entry: { window: resetsAt, samples: samples.slice(-MAX_SAMPLES) },
    changed: true,
  };
}

/**
 * Least-squares slope over the recent samples, extended to the cap.
 *
 * Returns null while the history is too short or utilisation is flat or
 * falling — a projection from noise is worse than no projection.
 */
export function project(samples: Sample[], resetsAt: number | null, now: number): Projection | null {
  const recent = samples.filter((s) => now - s.t <= WINDOW_MS);
  if (recent.length < 2) return null;

  const span = recent[recent.length - 1]!.t - recent[0]!.t;
  if (span < MIN_SPAN_MS) return null;

  const rate = slopePerMinute(recent);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const current = recent[recent.length - 1]!.u;
  const remaining = 100 - current;
  if (remaining <= 0) return null;

  const capsAt = now + (remaining / rate) * 60_000;
  return { rate, capsAt, beforeReset: resetsAt !== null && capsAt < resetsAt };
}

function slopePerMinute(samples: Sample[]): number {
  const n = samples.length;
  const t0 = samples[0]!.t;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const s of samples) {
    const x = (s.t - t0) / 60_000;
    sumX += x;
    sumY += s.u;
    sumXY += x * s.u;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

export interface HistoryPoint extends Sample {
  /** The window this reading belongs to, so windows can be told apart. */
  w: number | null;
}

function historyPath(profile: string): string {
  return join(HISTORY_DIR, `${profile}.jsonl`);
}

/**
 * Append a reading to the profile's long history.
 *
 * The rolling buffer above is deliberately small and resets every window,
 * because a projection should not be dragged around by yesterday. `cca stats`
 * wants the opposite, so the same readings are also appended here, where they
 * outlive the window that produced them.
 */
async function appendHistory(profile: string, point: HistoryPoint): Promise<void> {
  try {
    await mkdir(HISTORY_DIR, { recursive: true, mode: 0o700 });
    await appendFile(historyPath(profile), `${JSON.stringify(point)}\n`, { mode: 0o600 });
  } catch {
    // History is a convenience; losing a line must not disturb a render.
  }
}

export async function readHistory(profile: string): Promise<HistoryPoint[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(profile), "utf8");
  } catch {
    return [];
  }
  const points: HistoryPoint[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      points.push(JSON.parse(line) as HistoryPoint);
    } catch {
      // A truncated final line from an interrupted append.
    }
  }
  return points;
}

/** Drop history past the retention window; done when a window rolls over. */
async function pruneHistory(profile: string, now: number): Promise<void> {
  try {
    const kept = (await readHistory(profile)).filter((p) => now - p.t <= HISTORY_KEEP_MS);
    const path = historyPath(profile);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, kept.map((p) => JSON.stringify(p)).join("\n") + (kept.length ? "\n" : ""), {
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch {
    // Housekeeping only.
  }
}

/** Record a reading and project from the resulting history. */
export async function trackAndProject(
  profile: string,
  utilization: number | null | undefined,
  resetsAt: number | null,
  now = Date.now(),
): Promise<Projection | null> {
  if (utilization === null || utilization === undefined) return null;

  const data = await readBurn();
  const previousWindow = data[profile]?.window;
  const { entry, changed } = foldSample(data[profile], utilization, resetsAt, now);
  data[profile] = entry;
  if (changed) {
    await writeBurn(data);
    await appendHistory(profile, { t: now, u: utilization, w: resetsAt });
    // A rolled-over window is a rare, natural moment to tidy up.
    if (previousWindow !== undefined && previousWindow !== resetsAt) {
      await pruneHistory(profile, now);
    }
  }

  return project(entry.samples, resetsAt, now);
}
