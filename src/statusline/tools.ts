/**
 * Tool-call count for the current session.
 *
 * Claude Code does not put this in the status-line payload, so it has to come
 * from the transcript — a JSONL file that reaches megabytes in a long session
 * and would be absurd to re-read on every turn. It is append-only, though, so
 * each render reads only the bytes added since the last one and adds to a
 * running total.
 */
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CCA_HOME } from "../config.ts";

const TOOLS_DIR = join(CCA_HOME, "cache", "tools");
/** Session tallies older than this belong to conversations long finished. */
const PRUNE_AFTER_MS = 7 * 86_400_000;

interface Tally {
  /** Transcript this tally belongs to; a different one resets the count. */
  path: string;
  /** Bytes already counted. */
  offset: number;
  tools: number;
}

function tallyPath(sessionId: string): string {
  // Session ids are UUIDs from Claude Code, but the file name is built from a
  // sanitised copy rather than trusting that.
  return join(TOOLS_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/**
 * Count `tool_use` blocks in assistant messages.
 *
 * Only complete lines are parsed: the transcript is being appended to while
 * this runs, so the final line may be half-written.
 */
export function countToolUses(chunk: string): { tools: number; consumed: number } {
  const lastBreak = chunk.lastIndexOf("\n");
  if (lastBreak === -1) return { tools: 0, consumed: 0 };

  let tools = 0;
  for (const line of chunk.slice(0, lastBreak).split("\n")) {
    if (!line.trim()) continue;
    // Cheap reject first: most transcript lines are not assistant turns.
    if (!line.includes('"tool_use"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { content?: unknown };
      };
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use") {
          tools++;
        }
      }
    } catch {
      // A malformed line costs one uncounted tool call, not a broken HUD.
    }
  }
  // `consumed` counts bytes, and the transcript is UTF-8, so a chunk with
  // multi-byte characters must not be measured in code units.
  return { tools, consumed: Buffer.byteLength(chunk.slice(0, lastBreak + 1), "utf8") };
}

async function readTally(sessionId: string): Promise<Tally | null> {
  try {
    return JSON.parse(await Bun.file(tallyPath(sessionId)).text()) as Tally;
  } catch {
    return null;
  }
}

async function writeTally(sessionId: string, tally: Tally): Promise<void> {
  await mkdir(TOOLS_DIR, { recursive: true, mode: 0o700 });
  const path = tallyPath(sessionId);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(tally), { mode: 0o600 });
  await rename(tmp, path);
}

/** Tallies are per session, so they accumulate; drop the stale ones. */
async function pruneTallies(now: number): Promise<void> {
  try {
    for (const name of await readdir(TOOLS_DIR)) {
      const path = join(TOOLS_DIR, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > PRUNE_AFTER_MS) await rm(path, { force: true });
    }
  } catch {
    // Housekeeping only.
  }
}

/**
 * The running tool-call count for a session, updated from whatever the
 * transcript has gained since the last render.
 */
export async function countTools(
  sessionId: string | undefined,
  transcriptPath: string | undefined,
  now = Date.now(),
): Promise<number | null> {
  if (!sessionId || !transcriptPath) return null;

  const previous = await readTally(sessionId);
  // A new transcript for the same session — or one that shrank, which means it
  // was replaced — invalidates the byte offset the count is built on.
  const size = (await stat(transcriptPath).catch(() => null))?.size;
  if (size === undefined) return previous?.tools ?? null;

  const reusable = previous && previous.path === transcriptPath && previous.offset <= size;
  const tally: Tally = reusable ? previous : { path: transcriptPath, offset: 0, tools: 0 };
  if (!reusable) await pruneTallies(now);

  if (size > tally.offset) {
    const handle = await open(transcriptPath, "r").catch(() => null);
    if (!handle) return tally.tools;
    try {
      const buffer = Buffer.alloc(size - tally.offset);
      await handle.read(buffer, 0, buffer.length, tally.offset);
      const { tools, consumed } = countToolUses(buffer.toString("utf8"));
      tally.tools += tools;
      tally.offset += consumed;
    } finally {
      await handle.close();
    }
    await writeTally(sessionId, tally);
  }

  return tally.tools;
}
