/**
 * Sessions this daemon did not start: terminal `claude` processes and
 * `claude --bg` jobs. Observed through `claude agents --json --all`, which
 * needs no TTY (verified on 2.1.269), so the phone can at least see what the
 * Mac is busy with.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Session } from "./protocol.ts";

const execFileAsync = promisify(execFile);

interface AgentRow {
  id?: string;
  pid?: number;
  cwd: string;
  kind: "interactive" | "background";
  startedAt: number;
  sessionId: string;
  name?: string;
  status?: string;
  state?: string;
}

export function claudeBin(): string {
  return process.env.CCA_CLAUDE_BIN || "claude";
}

export async function listExternalSessions(exclude: Set<string>): Promise<Session[]> {
  let rows: AgentRow[];
  try {
    const { stdout } = await execFileAsync(claudeBin(), ["agents", "--json", "--all"], {
      timeout: 8_000,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cca-remote" },
    });
    rows = JSON.parse(stdout) as AgentRow[];
  } catch {
    return [];
  }

  const now = new Date().toISOString();
  return rows
    .filter((row) => !exclude.has(row.sessionId))
    .map((row) => {
      const busy = row.status === "busy" || row.state === "running";
      const blocked = row.state === "blocked";
      return {
        id: `ext:${row.sessionId}`,
        name: row.name ?? basename(row.cwd),
        cwd: row.cwd,
        permissionMode: "default",
        state: blocked ? "requires_action" : busy ? "running" : row.state === "exited" ? "stopped" : "idle",
        createdAt: new Date(row.startedAt).toISOString(),
        updatedAt: now,
        kind: "external",
        external: { kind: row.kind, pid: row.pid, status: row.status ?? row.state },
        claudeSessionId: row.sessionId,
      } satisfies Session;
    });
}
