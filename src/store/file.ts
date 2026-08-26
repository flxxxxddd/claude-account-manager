/** Linux backend (and the universal fallback) — a 0600 JSON file. */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialBlob, CredentialStore } from "./types.ts";

export const fileStore: CredentialStore = {
  kind: "file",

  async read({ filePath }) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as CredentialBlob;
    } catch {
      throw new Error(`${filePath} does not contain valid JSON`);
    }
  },

  async write({ filePath }, blob) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    // Write-then-rename would break Claude Code's symlink check on some
    // systems, and CC explicitly refuses to follow a symlinked credentials
    // file — so write in place with restrictive permissions instead.
    await writeFile(filePath, JSON.stringify(blob), { mode: 0o600 });
    await chmod(filePath, 0o600);
  },

  async remove({ filePath }) {
    await rm(filePath, { force: true });
  },
};
