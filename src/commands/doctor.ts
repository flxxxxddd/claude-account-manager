/**
 * `cca doctor` — prove the whole chain works rather than assume it.
 *
 * The important check is the last one: it asks Claude Code itself, running
 * under a profile's environment, which account it sees. If that matches the
 * profile's recorded email, the credential addressing is correct on this
 * machine and this CC version.
 */
import { spawn } from "node:child_process";
import { credentialServiceName, DEFAULT_CC_CONFIG_DIR } from "../cc-paths.ts";
import { profileEnv } from "../cc-paths.ts";
import type { Config } from "../config.ts";
import { CONFIG_PATH } from "../config.ts";
import { getStore, readSlot } from "../store/index.ts";
import { c, formatDeadline, LOGIN_WARN_MS, symbols } from "../ui.ts";
import { claudeBin } from "./profiles.ts";

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

export async function doctorCommand(config: Config, options: { deep?: boolean } = {}): Promise<number> {
  const checks: Check[] = [];

  const version = await claudeVersion();
  checks.push({
    label: "claude CLI on PATH",
    ok: version !== null,
    detail: version ?? `not found (set CCA_CLAUDE_BIN to override)`,
  });

  const store = await getStore();
  checks.push({ label: "credential backend", ok: true, detail: store.kind });

  checks.push({ label: "manager config", ok: true, detail: CONFIG_PATH });

  const defaultBlob = await readSlot(undefined).catch(() => null);
  checks.push({
    label: "default Claude Code session",
    ok: defaultBlob?.claudeAiOauth !== undefined,
    detail: defaultBlob?.claudeAiOauth
      ? `present (${credentialServiceName(undefined)})`
      : `none — a plain \`claude\` login would write to ${credentialServiceName(undefined)}`,
  });

  checks.push({
    label: "default config dir",
    ok: true,
    detail: DEFAULT_CC_CONFIG_DIR,
  });

  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    checks.push({ label: "profiles", ok: false, detail: "none — run `cca import`" });
  }

  for (const name of names) {
    const profile = config.profiles[name]!;
    const blob = await readSlot(profile.dir).catch(() => null);
    checks.push({
      label: `profile ${name}: credentials`,
      ok: blob?.claudeAiOauth !== undefined,
      detail: blob?.claudeAiOauth
        ? credentialServiceName(profile.dir)
        : `missing at ${credentialServiceName(profile.dir)}`,
    });

    const expiresAt = blob?.claudeAiOauth?.refreshTokenExpiresAt;
    if (expiresAt !== undefined) {
      const remaining = expiresAt - Date.now();
      checks.push({
        label: `profile ${name}: login`,
        ok: remaining > 0,
        detail:
          remaining <= 0
            ? `expired — run \`cca login ${name}\``
            : remaining <= LOGIN_WARN_MS
              // Worth spelling out: the daemon rotates tokens, and people
              // reasonably assume that is what keeps a login alive.
              ? `${formatDeadline(remaining)} left — run \`cca login ${name}\` before it lapses, rotating tokens will not extend it`
              : `${formatDeadline(remaining)} left`,
      });
    }

    if (options.deep && version !== null) {
      const seen = await claudeSeesAccount(profile.dir, profile.mode);
      const expected = profile.email;
      checks.push({
        label: `profile ${name}: Claude Code agrees`,
        ok: seen !== null && (expected === undefined || seen === expected),
        detail:
          seen === null
            ? "claude auth status reported no login under this profile"
            : expected && seen !== expected
              ? `claude sees ${seen}, profile records ${expected}`
              : `claude sees ${seen}`,
      });
    }
  }

  for (const check of checks) {
    const mark = check.ok ? c.green(symbols.ok) : c.red(symbols.fail);
    process.stdout.write(`${mark} ${check.label}${check.detail ? c.gray(` — ${check.detail}`) : ""}\n`);
  }

  if (!options.deep) {
    process.stdout.write(`\n${c.gray("Run `cca doctor --deep` to verify against Claude Code itself.")}\n`);
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

async function claudeVersion(): Promise<string | null> {
  const result = await capture(claudeBin(), ["--version"], {});
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Ask Claude Code which account it resolves under a profile's environment. */
async function claudeSeesAccount(dir: string, mode: Config["profiles"][string]["mode"]): Promise<string | null> {
  const result = await capture(claudeBin(), ["auth", "status", "--json"], profileEnv(dir, mode));
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; email?: string };
    return parsed.loggedIn ? (parsed.email ?? null) : null;
  } catch {
    return null;
  }
}

function capture(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => resolve({ code: -1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
