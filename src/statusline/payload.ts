/**
 * The JSON Claude Code writes to a status-line command's stdin.
 *
 * Only the fields the HUD reads are typed; everything else is ignored so a
 * newer Claude Code adding keys cannot break rendering. Field names mirror the
 * wire format, hence the snake_case.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CCA_HOME } from "../config.ts";

export interface RateLimitWindow {
  used_percentage?: number;
  /** Unix seconds, not milliseconds. */
  resets_at?: number;
}

export interface StatuslinePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  session_name?: string;
  version?: string;
  effort?: { level?: string };
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  output_style?: { name?: string };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number;
    used_percentage?: number;
    remaining_percentage?: number;
  };
  exceeds_200k_tokens?: boolean;
  fast_mode?: boolean;
  thinking?: { enabled?: boolean };
  rate_limits?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow };
}

const PAYLOAD_CACHE = join(CCA_HOME, "cache", "last-payload.json");

/** Claude Code hands over the payload immediately; this only guards a hang. */
const STDIN_TIMEOUT_MS = 250;

/**
 * Read the payload from stdin.
 *
 * Returns null when there is nothing to read — running `cca statusline` by
 * hand in a terminal is a supported way to eyeball the output.
 */
export async function readPayload(): Promise<StatuslinePayload | null> {
  if (process.stdin.isTTY) return null;

  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as StatuslinePayload) : null;
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    timer.unref?.();

    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** Kept so `cca statusline --preview` can re-render the real last frame. */
export async function cachePayload(payload: StatuslinePayload): Promise<void> {
  try {
    await mkdir(join(CCA_HOME, "cache"), { recursive: true, mode: 0o700 });
    const tmp = `${PAYLOAD_CACHE}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await rename(tmp, PAYLOAD_CACHE);
  } catch {
    // A missed cache write only costs `--preview` its realism.
  }
}

export async function readCachedPayload(): Promise<StatuslinePayload | null> {
  try {
    return JSON.parse(await readFile(PAYLOAD_CACHE, "utf8")) as StatuslinePayload;
  } catch {
    return null;
  }
}

/** Unix seconds to the ISO string the rest of the codebase passes around. */
export function isoFromUnixSeconds(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}
