/** A crude cross-process mutex so two `cca` runs never rotate a token at once. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CCA_HOME } from "./config.ts";

const STALE_MS = 30_000;

function lockPath(name: string): string {
  return join(CCA_HOME, "locks", `${name}.lock`);
}

async function isStale(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const { at } = JSON.parse(raw) as { at: number };
    return Date.now() - at > STALE_MS;
  } catch {
    return true;
  }
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(name);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;

  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }), {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await isStale(path)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock "${name}" (${path})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
