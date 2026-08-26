/**
 * Repository state for the status line.
 *
 * The branch comes from reading `.git/HEAD` rather than shelling out, so the
 * common case costs one small file read. Counts and upstream divergence need
 * git itself; that call is given a hard deadline, and the branch still renders
 * if it blows through it.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface GitState {
  branch: string;
  /** Tracked files with staged or unstaged changes. */
  modified: number;
  untracked: number;
  conflicted: number;
  /** Commits ahead of / behind the upstream, or null when there is none. */
  ahead: number | null;
  behind: number | null;
  /** True when the status call timed out, so the counts are unknown. */
  countsUnknown: boolean;
}

const STATUS_TIMEOUT_MS = 250;

/** Walk up from `dir` to the first directory holding a `.git` entry. */
async function findGitRoot(dir: string): Promise<string | null> {
  let current = resolve(dir);
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** `.git` is a directory in a normal clone and a pointer file in a worktree. */
async function gitDirOf(root: string): Promise<string> {
  const dotGit = join(root, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  const pointer = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) throw new Error("unreadable .git pointer");
  return resolve(root, match[1]!.trim());
}

export async function readGitState(cwd: string | undefined): Promise<GitState | null> {
  if (!cwd) return null;
  const root = await findGitRoot(cwd);
  if (!root) return null;

  let branch: string;
  try {
    const head = (await readFile(join(await gitDirOf(root), "HEAD"), "utf8")).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    // A detached HEAD holds a raw sha; a short prefix is the useful part.
    branch = ref ? ref[1]! : head.slice(0, 7);
  } catch {
    return null;
  }

  const status = await runStatus(root);
  if (!status) {
    return {
      branch,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      ahead: null,
      behind: null,
      countsUnknown: true,
    };
  }
  return { branch, ...parseStatus(status), countsUnknown: false };
}

function runStatus(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "status", "--porcelain=v2", "--branch"],
      { timeout: STATUS_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * Entry lines are `1 ` (ordinary change), `2 ` (rename/copy), `u ` (unmerged)
 * and `? ` (untracked); `# branch.ab +N -M` carries upstream divergence.
 */
export function parseStatus(output: string): Omit<GitState, "branch" | "countsUnknown"> {
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  let ahead: number | null = null;
  let behind: number | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) modified++;
    else if (line.startsWith("u ")) conflicted++;
    else if (line.startsWith("? ")) untracked++;
  }

  return { modified, untracked, conflicted, ahead, behind };
}
