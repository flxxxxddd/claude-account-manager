/**
 * `cca doctor` — prove the whole chain works rather than assume it.
 *
 * The important checks are the last two, and they answer different questions.
 * One asks Claude Code itself, running under a profile's environment, whether
 * it resolves a login at all: that is what proves the addressing in
 * `cc-paths.ts` still matches this CC version. The other asks the API who the
 * stored credentials belong to, because Claude Code cannot answer that — see
 * `claudeResolvesLogin` below.
 */
import { spawn } from "node:child_process";
import { fetchProfile } from "../api.ts";
import { credentialServiceName, DEFAULT_CC_CONFIG_DIR } from "../cc-paths.ts";
import { profileEnv } from "../cc-paths.ts";
import type { Config, Profile } from "../config.ts";
import { CONFIG_PATH } from "../config.ts";
import { accessTokenFor } from "../session.ts";
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
      const slot = credentialServiceName(profile.dir);
      const resolution = await claudeResolvesLogin(profile.dir, profile.mode);
      checks.push({
        label: `profile ${name}: Claude Code resolves it`,
        ok: resolution.kind === "logged-in",
        detail:
          resolution.kind === "logged-in"
            ? `claude finds a login at ${slot}`
            : resolution.kind === "logged-out"
              ? `claude finds nothing at ${slot} — run \`cca login ${name}\``
              : resolution.detail,
      });

      const identity = await profileIdentity(name, profile);
      const expected = profile.email;
      checks.push({
        label: `profile ${name}: account identity`,
        ok: identity.email !== undefined && (expected === undefined || identity.email === expected),
        detail:
          identity.error ??
          (expected && identity.email !== expected
            ? `credentials belong to ${identity.email}, profile records ${expected} — run \`cca login ${name}\``
            : `credentials belong to ${identity.email}`),
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

type Resolution =
  | { kind: "logged-in" }
  | { kind: "logged-out" }
  | { kind: "unreadable"; detail: string };

/**
 * Ask Claude Code whether it resolves a login under a profile's environment.
 *
 * `loggedIn` is the only field here worth reading. `email`, `orgId` and
 * `orgName` are served from `<config dir>/.claude.json`'s cached `oauthAccount`
 * rather than from the credential slot CC just resolved — so in `shared` mode,
 * where every profile shares ~/.claude.json, they name whichever account last
 * ran a session, and comparing them against a profile is meaningless.
 *
 * Observed on 2.1.252 and 2.1.258: running `auth status --json` with
 * CLAUDE_SECURESTORAGE_CONFIG_DIR pointed at a profile and CLAUDE_CONFIG_DIR
 * pointed at an empty scratch directory returns all three as null while
 * `loggedIn` stays true and `subscriptionType` still comes from the blob.
 */
async function claudeResolvesLogin(
  dir: string,
  mode: Config["profiles"][string]["mode"],
): Promise<Resolution> {
  const result = await capture(claudeBin(), ["auth", "status", "--json"], profileEnv(dir, mode));
  if (result.code !== 0) {
    const reason = firstLine(result.stderr) ?? firstLine(result.stdout);
    return {
      kind: "unreadable",
      detail: `\`claude auth status\` exited ${result.code}${reason ? `: ${reason}` : ""}`,
    };
  }
  // CC may print a banner ahead of the JSON, so read the object, not the stream.
  const parsed = parseJsonObject(result.stdout);
  if (parsed === null) {
    return { kind: "unreadable", detail: "could not parse `claude auth status --json` output" };
  }
  return parsed.loggedIn === true ? { kind: "logged-in" } : { kind: "logged-out" };
}

/**
 * Who the stored credentials actually belong to.
 *
 * This has to come from the API: Claude Code will confirm that a credential
 * exists in the slot, but never says whose it is.
 */
async function profileIdentity(name: string, profile: Profile): Promise<{ email?: string; error?: string }> {
  try {
    const oauth = await accessTokenFor(name, profile);
    const info = await fetchProfile(oauth.accessToken);
    if (!info.email) return { error: "the profile endpoint returned no email" };
    return { email: info.email };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function parseJsonObject(text: string): { loggedIn?: boolean } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { loggedIn?: boolean };
  } catch {
    return null;
  }
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split("\n")[0]?.trim();
  return line ? line : undefined;
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
