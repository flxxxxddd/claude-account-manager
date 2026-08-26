/** macOS backend — the `security` CLI, which is what Claude Code itself uses. */
import { spawn } from "node:child_process";
import type { CredentialBlob, CredentialStore } from "./types.ts";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export const keychainStore: CredentialStore = {
  kind: "keychain",

  async read({ service, account }) {
    const { code, stdout, stderr } = await run([
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ]);
    if (code !== 0) {
      if (/could not be found|errSecItemNotFound/i.test(stderr)) return null;
      throw new Error(`keychain read failed: ${stderr.trim() || `exit ${code}`}`);
    }
    const raw = stdout.trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CredentialBlob;
    } catch {
      throw new Error(`keychain item ${service} does not contain valid JSON`);
    }
  },

  async write({ service, account }, blob) {
    // `-w` with no value makes `security` read the secret from stdin (twice,
    // as a confirmation), which keeps the token out of the process argv where
    // `ps` could see it.
    const secret = JSON.stringify(blob);
    const { code, stderr } = await run(
      ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
      `${secret}\n${secret}\n`,
    );
    if (code !== 0) {
      throw new Error(`keychain write failed: ${stderr.trim() || `exit ${code}`}`);
    }
  },

  async remove({ service, account }) {
    const { code, stderr } = await run([
      "delete-generic-password",
      "-s", service,
      "-a", account,
    ]);
    if (code !== 0 && !/could not be found|errSecItemNotFound/i.test(stderr)) {
      throw new Error(`keychain delete failed: ${stderr.trim() || `exit ${code}`}`);
    }
  },
};
