/**
 * Warm-up scheduling.
 *
 * Rather than keeping a long-lived process alive, the OS scheduler fires
 * `cca daemon tick` on an interval and the tick decides what is due. A missed
 * tick therefore costs nothing beyond a late warm-up, and there is no daemon
 * to crash, leak, or supervise.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CCA_HOME, loadConfig, type Config, type Profile } from "../config.ts";
import { c, symbols } from "../ui.ts";
import { refreshProfile, warmProfile, type WarmOutcome } from "./warm.ts";

const STATE_DIR = join(CCA_HOME, "state");
const STATE_PATH = join(STATE_DIR, "daemon.json");

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface DaemonState {
  /** ISO timestamp of the last successful warm-up, per profile. */
  lastWarm: Record<string, string>;
  /** Schedule slots already fired today, as "YYYY-MM-DD HH:MM". */
  firedSlots: string[];
  lastRefreshAt?: string;
}

const EMPTY_STATE: DaemonState = { lastWarm: {}, firedSlots: [] };

async function readState(): Promise<DaemonState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<DaemonState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

async function writeState(state: DaemonState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_PATH);
}

export interface TickOptions {
  /** Report what would happen without sending anything. */
  dryRun?: boolean;
  json?: boolean;
}

export async function tickCommand(config: Config, options: TickOptions = {}): Promise<number> {
  const { warmup } = config;
  const state = await readState();
  const actions: string[] = [];
  const outcomes: WarmOutcome[] = [];

  if (!warmup.enabled) {
    if (!options.json) process.stdout.write(`${c.gray("Warm-up is disabled.")}\n`);
    return 0;
  }

  const targets = selectProfiles(config, warmup.profiles);

  if (warmup.mode === "schedule") {
    const due = dueSlots(warmup.at, state.firedSlots, new Date());
    if (due.length > 0) {
      actions.push(`schedule slot ${due.join(", ")}`);
      if (!options.dryRun) {
        for (const [name, profile] of targets) {
          outcomes.push(await warmProfile(name, profile, warmup.model, false));
          state.lastWarm[name] = new Date().toISOString();
        }
        state.firedSlots = pruneSlots([...state.firedSlots, ...due]);
      }
    }
  } else if (warmup.mode === "smart") {
    // Warm only accounts whose 5-hour window has lapsed, so a fresh window
    // opens the moment the previous one resets.
    actions.push("smart check");
    if (!options.dryRun) {
      for (const [name, profile] of targets) {
        const outcome = await warmProfile(name, profile, warmup.model, true);
        outcomes.push(outcome);
        if (outcome.status === "warmed") state.lastWarm[name] = new Date().toISOString();
      }
    }
  }

  if (warmup.refreshTokens && refreshDue(state)) {
    actions.push("token refresh");
    if (!options.dryRun) {
      for (const [name, profile] of targets) {
        await refreshProfile(name, profile, true);
      }
      state.lastRefreshAt = new Date().toISOString();
    }
  }

  if (!options.dryRun) await writeState(state);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ actions, results: outcomes }, null, 2)}\n`);
    return 0;
  }

  if (actions.length === 0) {
    process.stdout.write(`${c.gray("Nothing due.")}\n`);
    return 0;
  }
  process.stdout.write(`${c.gray(`Due: ${actions.join(", ")}`)}\n`);
  for (const outcome of outcomes) {
    const mark =
      outcome.status === "warmed"
        ? c.green(symbols.ok)
        : outcome.status === "failed"
          ? c.red(symbols.fail)
          : c.gray(symbols.ok);
    process.stdout.write(`${mark} ${outcome.name} ${c.gray(outcome.status)}\n`);
  }
  return 0;
}

function selectProfiles(config: Config, wanted: string[]): Array<[string, Profile]> {
  const entries = Object.entries(config.profiles);
  if (wanted.length === 0) return entries;
  return entries.filter(([name]) => wanted.includes(name));
}

/** A slot is due once its wall-clock time has passed today and it has not fired. */
export function dueSlots(slots: string[], fired: string[], now: Date): string[] {
  const day = toDayKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const due: string[] = [];
  for (const slot of slots) {
    const parsed = parseSlot(slot);
    if (parsed === null) continue;
    if (parsed > nowMinutes) continue;
    const key = `${day} ${slot}`;
    if (!fired.includes(key)) due.push(key);
  }
  return due;
}

function parseSlot(slot: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Keep a few days of history so a slot never re-fires after a clock change. */
function pruneSlots(slots: string[]): string[] {
  return [...new Set(slots)].slice(-32);
}

function refreshDue(state: DaemonState): boolean {
  if (!state.lastRefreshAt) return true;
  const last = new Date(state.lastRefreshAt).getTime();
  return Number.isNaN(last) || Date.now() - last > REFRESH_INTERVAL_MS;
}

/* ------------------------------------------------------------------ */
/* Scheduler installation                                              */
/* ------------------------------------------------------------------ */

const LAUNCHD_LABEL = "com.claude-account-manager.warmup";

export interface InstallOptions {
  binaryPath: string;
  intervalMinutes: number;
}

export async function installScheduler(options: InstallOptions): Promise<number> {
  switch (process.platform) {
    case "darwin":
      return installLaunchd(options);
    case "linux":
      return installSystemd(options);
    case "win32":
      return printWindowsInstructions(options);
    default:
      process.stderr.write(`${c.red(symbols.fail)} Unsupported platform: ${process.platform}\n`);
      return 1;
  }
}

export async function uninstallScheduler(): Promise<number> {
  switch (process.platform) {
    case "darwin": {
      const path = launchdPath();
      await runQuiet("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
      await rm(path, { force: true });
      process.stdout.write(`${c.green(symbols.ok)} Removed ${path}\n`);
      return 0;
    }
    case "linux": {
      await runQuiet("systemctl", ["--user", "disable", "--now", "cca-warmup.timer"]);
      await rm(join(systemdDir(), "cca-warmup.timer"), { force: true });
      await rm(join(systemdDir(), "cca-warmup.service"), { force: true });
      process.stdout.write(`${c.green(symbols.ok)} Removed systemd user units\n`);
      return 0;
    }
    case "win32": {
      await runQuiet("schtasks", ["/Delete", "/TN", "ClaudeAccountManagerWarmup", "/F"]);
      process.stdout.write(`${c.green(symbols.ok)} Removed scheduled task\n`);
      return 0;
    }
    default:
      return 1;
  }
}

function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

async function installLaunchd(options: InstallOptions): Promise<number> {
  const path = launchdPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${options.binaryPath}</string>
    <string>daemon</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>${options.intervalMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(CCA_HOME, "logs", "warmup.log")}</string>
  <key>StandardErrorPath</key><string>${join(CCA_HOME, "logs", "warmup.err.log")}</string>
</dict>
</plist>
`;
  await mkdir(join(CCA_HOME, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(path, plist);

  const uid = process.getuid?.() ?? 501;
  await runQuiet("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  const { code, stderr } = await runQuiet("launchctl", ["bootstrap", `gui/${uid}`, path]);
  if (code !== 0) {
    process.stderr.write(
      `${c.yellow(symbols.warn)} Wrote ${path} but launchctl bootstrap failed: ${stderr.trim()}\n` +
        `  Load it manually with: launchctl bootstrap gui/${uid} ${path}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${c.green(symbols.ok)} Installed launch agent (every ${options.intervalMinutes}m)\n` +
      `  ${c.gray(path)}\n`,
  );
  return 0;
}

function systemdDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
}

async function installSystemd(options: InstallOptions): Promise<number> {
  const dir = systemdDir();
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, "cca-warmup.service"),
    `[Unit]
Description=Claude account manager warm-up tick

[Service]
Type=oneshot
ExecStart=${options.binaryPath} daemon tick
`,
  );
  await writeFile(
    join(dir, "cca-warmup.timer"),
    `[Unit]
Description=Run Claude account warm-up every ${options.intervalMinutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${options.intervalMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`,
  );

  await runQuiet("systemctl", ["--user", "daemon-reload"]);
  const { code, stderr } = await runQuiet("systemctl", ["--user", "enable", "--now", "cca-warmup.timer"]);
  if (code !== 0) {
    process.stderr.write(
      `${c.yellow(symbols.warn)} Wrote units to ${dir} but enabling failed: ${stderr.trim()}\n` +
        `  Enable manually with: systemctl --user enable --now cca-warmup.timer\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${c.green(symbols.ok)} Installed systemd user timer (every ${options.intervalMinutes}m)\n`,
  );
  return 0;
}

async function printWindowsInstructions(options: InstallOptions): Promise<number> {
  const { code, stderr } = await runQuiet("schtasks", [
    "/Create",
    "/SC", "MINUTE",
    "/MO", String(options.intervalMinutes),
    "/TN", "ClaudeAccountManagerWarmup",
    "/TR", `"${options.binaryPath}" daemon tick`,
    "/F",
  ]);
  if (code !== 0) {
    process.stderr.write(
      `${c.yellow(symbols.warn)} Could not create the scheduled task: ${stderr.trim()}\n` +
        `  Run this in an elevated prompt:\n` +
        `  schtasks /Create /SC MINUTE /MO ${options.intervalMinutes} /TN ClaudeAccountManagerWarmup /TR "\\"${options.binaryPath}\\" daemon tick" /F\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${c.green(symbols.ok)} Installed scheduled task (every ${options.intervalMinutes}m)\n`,
  );
  return 0;
}

export async function schedulerStatus(): Promise<number> {
  const config = await loadConfig();
  const state = await readState();
  process.stdout.write(
    `${c.bold("Warm-up")}\n` +
      `  enabled   ${config.warmup.enabled ? c.green("yes") : c.gray("no")}\n` +
      `  mode      ${config.warmup.mode}\n` +
      `  times     ${config.warmup.at.join(", ")}\n` +
      `  poll      every ${config.warmup.pollMinutes}m\n` +
      `  model     ${c.gray(config.warmup.model)}\n` +
      `  refresh   ${config.warmup.refreshTokens ? "on" : "off"}` +
      `${state.lastRefreshAt ? c.gray(` (last ${new Date(state.lastRefreshAt).toLocaleString()})`) : ""}\n`,
  );

  const warmed = Object.entries(state.lastWarm);
  if (warmed.length > 0) {
    process.stdout.write(`  last warm\n`);
    for (const [name, at] of warmed) {
      process.stdout.write(`    ${name} ${c.gray(new Date(at).toLocaleString())}\n`);
    }
  }
  return 0;
}

function runQuiet(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  });
}
