/** add / import / login / use / remove / rename */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fetchProfile, oauthOf } from "../api.ts";
import { profileEnv, type IsolationMode } from "../cc-paths.ts";
import {
  ensureProfileDir,
  requireProfile,
  saveConfig,
  validateProfileName,
  type Config,
  type Profile,
} from "../config.ts";
import { accessTokenFor } from "../session.ts";
import { readSlot, removeSlot, writeSlot } from "../store/index.ts";
import { c, symbols } from "../ui.ts";

/**
 * Adopt the session the user is already logged into.
 *
 * Reads the default credential slot — the one a plain `claude` login writes —
 * and copies it into a profile slot. Nothing is moved or deleted, so bare
 * `claude` keeps working exactly as before.
 */
export async function importCommand(
  config: Config,
  name: string | undefined,
  options: { mode?: IsolationMode } = {},
): Promise<number> {
  const blob = await readSlot(undefined);
  const oauth = oauthOf(blob);
  if (!oauth) {
    process.stderr.write(
      `${c.red(symbols.fail)} No Claude Code session found to import.\n` +
        `  Log in with ${c.bold("claude")} first, then run ${c.bold("cca import")} again.\n`,
    );
    return 1;
  }

  let email: string | undefined;
  let accountUuid: string | undefined;
  let organizationName: string | undefined;
  let plan: string | undefined;
  try {
    const info = await fetchProfile(oauth.accessToken);
    email = info.email;
    accountUuid = info.accountUuid;
    organizationName = info.organizationName;
    plan = info.plan;
  } catch {
    // Identity is a nicety; the credentials are the point.
  }

  const resolved = name ?? deriveName(email, config);
  validateProfileName(resolved);
  if (config.profiles[resolved]) {
    process.stderr.write(`${c.red(symbols.fail)} Profile "${resolved}" already exists.\n`);
    return 1;
  }

  const mode = options.mode ?? "shared";
  const dir = await ensureProfileDir(resolved);
  await writeSlot(dir, blob!);

  config.profiles[resolved] = {
    mode,
    dir,
    email,
    accountUuid,
    organizationName,
    subscriptionType: plan ?? oauth.subscriptionType,
    createdAt: new Date().toISOString(),
  };
  config.activeProfile ??= resolved;
  await saveConfig(config);

  process.stdout.write(
    `${c.green(symbols.ok)} Imported current session as ${c.bold(resolved)}` +
      `${email ? c.gray(` (${email})`) : ""}\n` +
      `  ${c.gray(`mode: ${mode} · storage: ${dir}`)}\n`,
  );
  return 0;
}

/** Create a profile and hand off to `claude auth login` inside it. */
export async function loginCommand(
  config: Config,
  name: string,
  options: { mode?: IsolationMode } = {},
): Promise<number> {
  validateProfileName(name);
  const existing = config.profiles[name];
  const mode = options.mode ?? existing?.mode ?? "shared";
  const dir = existing?.dir ?? (await ensureProfileDir(name));

  process.stdout.write(
    `${c.cyan("→")} Opening Claude login for profile ${c.bold(name)}…\n` +
      `  ${c.gray("Sign in with the account you want this profile to hold.")}\n\n`,
  );

  const code = await runClaude(["auth", "login"], { ...profileEnv(dir, mode) });
  if (code !== 0) {
    process.stderr.write(`${c.red(symbols.fail)} Login did not complete (exit ${code}).\n`);
    return code;
  }

  const blob = await readSlot(dir);
  const oauth = oauthOf(blob);
  if (!oauth) {
    process.stderr.write(
      `${c.red(symbols.fail)} Login reported success but no credentials landed in ${dir}.\n`,
    );
    return 1;
  }

  let email: string | undefined;
  let accountUuid: string | undefined;
  let organizationName: string | undefined;
  try {
    const info = await fetchProfile(oauth.accessToken);
    email = info.email;
    accountUuid = info.accountUuid;
    organizationName = info.organizationName;
  } catch {
    /* non-fatal */
  }

  const profile: Profile = {
    mode,
    dir,
    email,
    accountUuid,
    organizationName,
    subscriptionType: oauth.subscriptionType,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastUsedAt: existing?.lastUsedAt,
    label: existing?.label,
  };
  config.profiles[name] = profile;
  config.activeProfile ??= name;
  await saveConfig(config);

  process.stdout.write(
    `${c.green(symbols.ok)} Profile ${c.bold(name)} is logged in` +
      `${email ? c.gray(` as ${email}`) : ""}.\n`,
  );
  return 0;
}

export async function useCommand(config: Config, name: string): Promise<number> {
  const profile = requireProfile(config, name);
  config.activeProfile = name;
  config.profiles[name] = { ...profile, lastUsedAt: new Date().toISOString() };
  await saveConfig(config);
  process.stdout.write(
    `${c.green(symbols.ok)} Active profile → ${c.bold(name)}` +
      `${profile.email ? c.gray(` (${profile.email})`) : ""}\n`,
  );
  return 0;
}

export async function removeCommand(
  config: Config,
  name: string,
  options: { purge?: boolean } = {},
): Promise<number> {
  const profile = requireProfile(config, name);
  await removeSlot(profile.dir);
  if (options.purge) await rm(profile.dir, { recursive: true, force: true });

  delete config.profiles[name];
  if (config.activeProfile === name) {
    config.activeProfile = Object.keys(config.profiles)[0];
  }
  await saveConfig(config);

  process.stdout.write(
    `${c.green(symbols.ok)} Removed profile ${c.bold(name)}` +
      `${options.purge ? c.gray(" and its storage directory") : ""}.\n`,
  );
  return 0;
}

export async function renameCommand(config: Config, from: string, to: string): Promise<number> {
  const profile = requireProfile(config, from);
  validateProfileName(to);
  if (config.profiles[to]) {
    process.stderr.write(`${c.red(symbols.fail)} Profile "${to}" already exists.\n`);
    return 1;
  }

  // The storage directory is baked into the credential address, so moving it
  // would orphan the credentials. Keep the directory, rename only the label.
  config.profiles[to] = profile;
  delete config.profiles[from];
  if (config.activeProfile === from) config.activeProfile = to;
  await saveConfig(config);

  process.stdout.write(`${c.green(symbols.ok)} Renamed ${c.bold(from)} → ${c.bold(to)}\n`);
  return 0;
}

/** Refresh cached identity for one profile (used by `cca status --sync`). */
export async function syncCommand(config: Config, name: string): Promise<number> {
  const profile = requireProfile(config, name);
  const oauth = await accessTokenFor(name, profile);
  const info = await fetchProfile(oauth.accessToken);
  config.profiles[name] = {
    ...profile,
    email: info.email ?? profile.email,
    accountUuid: info.accountUuid ?? profile.accountUuid,
    organizationName: info.organizationName ?? profile.organizationName,
  };
  await saveConfig(config);
  process.stdout.write(`${c.green(symbols.ok)} Synced ${c.bold(name)} (${info.email ?? "unknown"})\n`);
  return 0;
}

function deriveName(email: string | undefined, config: Config): string {
  const base = (email?.split("@")[0] ?? "default").replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!config.profiles[base]) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!config.profiles[candidate]) return candidate;
  }
}

export function runClaude(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(signal ? 128 + 1 : (code ?? 0));
    });
  });
}

export function claudeBin(): string {
  return process.env.CCA_CLAUDE_BIN || "claude";
}
