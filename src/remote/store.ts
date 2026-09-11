/**
 * Persistence for managed sessions: ~/.ccacc/remote/sessions.json holds the
 * list, ~/.ccacc/remote/sessions/<id>.jsonl the normalized items. Kept apart
 * from Claude Code's own transcript so a daemon restart can show history
 * instantly without re-parsing a multi-megabyte JSONL.
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REMOTE_DIR } from "./identity.ts";
import type { ChatItem, Session } from "./protocol.ts";

const SESSIONS_PATH = join(REMOTE_DIR, "sessions.json");
const ITEMS_DIR = join(REMOTE_DIR, "sessions");

interface SessionsFile {
  version: 1;
  sessions: Session[];
}

export async function loadSessions(): Promise<Session[]> {
  try {
    const parsed = JSON.parse(await readFile(SESSIONS_PATH, "utf8")) as SessionsFile;
    return parsed.version === 1 ? parsed.sessions : [];
  } catch {
    return [];
  }
}

let saveChain: Promise<void> = Promise.resolve();

/**
 * Writes are serialised: two `touch` calls in the same tick used to race on
 * one temp file, and the loser's rename threw ENOENT and took the daemon down.
 */
export function saveSessions(sessions: Session[]): Promise<void> {
  const snapshot = JSON.stringify({ version: 1, sessions } satisfies SessionsFile, null, 2);
  saveChain = saveChain
    .catch(() => undefined)
    .then(async () => {
      await mkdir(REMOTE_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${SESSIONS_PATH}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, SESSIONS_PATH);
    });
  return saveChain;
}

function itemsPath(sessionId: string): string {
  return join(ITEMS_DIR, `${sessionId}.jsonl`);
}

export async function appendItem(item: ChatItem): Promise<void> {
  await mkdir(ITEMS_DIR, { recursive: true, mode: 0o700 });
  await appendFile(itemsPath(item.sessionId), `${JSON.stringify(item)}\n`, { mode: 0o600 });
}

/**
 * Items are appended when finished, but a streaming item is written once at
 * start and once at the end, so the reader keeps the last version per id.
 */
export async function readItems(sessionId: string): Promise<ChatItem[]> {
  let raw: string;
  try {
    raw = await readFile(itemsPath(sessionId), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, ChatItem>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line) as ChatItem;
      byId.set(item.id, item);
    } catch {
      /* torn last line after a crash */
    }
  }
  return [...byId.values()];
}

export async function deleteItems(sessionId: string): Promise<void> {
  await rm(itemsPath(sessionId), { force: true });
}
