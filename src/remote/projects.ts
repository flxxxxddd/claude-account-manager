/** Directories the user has run Claude Code in, plus a tiny file browser. */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project } from "./protocol.ts";

const execFileAsync = promisify(execFile);

interface ClaudeJson {
  projects?: Record<string, { lastSessionId?: string; lastDuration?: number }>;
}

/** Best-effort: ~/.claude.json lists every project directory Claude Code saw. */
export async function listProjects(): Promise<Project[]> {
  let parsed: ClaudeJson = {};
  try {
    parsed = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")) as ClaudeJson;
  } catch {
    /* no history yet */
  }
  const paths = Object.keys(parsed.projects ?? {});
  const projects: (Project | null)[] = await Promise.all(
    paths.map(async (path): Promise<Project | null> => {
      try {
        const info = await stat(path);
        if (!info.isDirectory()) return null;
        return {
          path,
          name: basename(path),
          lastUsedAt: info.mtime.toISOString(),
          gitBranch: await gitBranch(path),
        };
      } catch {
        return null;
      }
    }),
  );
  return projects
    .filter((p): p is Project => p !== null)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
}

export async function gitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function listDirectory(path: string): Promise<{
  path: string;
  parent?: string;
  entries: { name: string; path: string; isGit: boolean }[];
}> {
  const abs = resolve(path.startsWith("~") ? path.replace("~", homedir()) : path);
  const names = await readdir(abs, { withFileTypes: true });
  const entries = await Promise.all(
    names
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map(async (d) => {
        const full = join(abs, d.name);
        let isGit = false;
        try {
          await stat(join(full, ".git"));
          isGit = true;
        } catch {
          /* not a repo */
        }
        return { name: d.name, path: full, isGit };
      }),
  );
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? undefined : parent, entries };
}
