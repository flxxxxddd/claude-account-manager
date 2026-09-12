/**
 * `cca remote` — the daemon behind the CCA Remote iOS/macOS app.
 *
 *   cca remote serve            run in the foreground
 *   cca remote pair [--rotate]  show the QR code the app scans
 *   cca remote install          keep it running via launchd
 *   cca remote status | uninstall | config
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { CCA_HOME } from "../config.ts";
import { c, symbols } from "../ui.ts";
import { Hub } from "../remote/hub.ts";
import {
  DEFAULT_REMOTE_SETTINGS,
  ensureIdentity,
  loadIdentity,
  loadRemoteSettings,
  pairingUrl,
  saveRemoteSettings,
  type RemoteSettings,
} from "../remote/identity.ts";
import { startRelayClient } from "../remote/relay-client.ts";
import { startDirectServer } from "../remote/server.ts";
import { selfArgs } from "./statusline.ts";

const LAUNCHD_LABEL = "com.claude-account-manager.remote";

export interface RemoteArgs {
  sub?: string;
  version: string;
  flags: {
    rotate?: boolean;
    json?: boolean;
    port?: string;
    lan?: boolean;
    noLan?: boolean;
    relay?: string;
    noRelay?: boolean;
    idle?: string;
  };
}

export async function remoteCommand(args: RemoteArgs): Promise<number> {
  switch (args.sub) {
    case "serve":
      return serve(args);
    case "pair":
      return pair(args);
    case "config":
      return configure(args);
    case "install":
      return install(args);
    case "uninstall":
      return uninstall();
    case "status":
    case undefined:
      return status();
    default:
      process.stderr.write(`Usage: ${c.bold("cca remote <serve|pair|config|install|uninstall|status>")}\n`);
      return 1;
  }
}

/** Flags given to `serve`/`config` override the stored settings. */
async function settingsFrom(args: RemoteArgs, persist: boolean): Promise<RemoteSettings> {
  const settings = await loadRemoteSettings();
  const f = args.flags;
  if (f.port) settings.port = Number(f.port) || settings.port;
  if (f.lan) settings.lan = true;
  if (f.noLan) settings.lan = false;
  if (f.relay) settings.relayUrl = f.relay;
  if (f.noRelay) settings.relayUrl = undefined;
  if (f.idle) settings.idleTimeoutSec = Math.max(60, Number(f.idle) * 60 || settings.idleTimeoutSec);
  if (persist) await saveRemoteSettings(settings);
  return settings;
}

function log(line: string): void {
  process.stderr.write(`${c.gray(new Date().toISOString().slice(11, 19))} ${line}\n`);
}

async function serve(args: RemoteArgs): Promise<number> {
  // A long-running daemon must not die on one stray rejection.
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
  process.on("uncaughtException", (err) => log(`uncaught exception: ${err.stack ?? err.message}`));
  const identity = await ensureIdentity();
  const settings = await settingsFrom(args, false);
  const directUrl = `ws://${settings.lan ? lanAddress() ?? "127.0.0.1" : "127.0.0.1"}:${settings.port}/ws`;

  const hub = new Hub({
    identity,
    daemonVersion: args.version,
    idleTimeoutSec: settings.idleTimeoutSec,
    directUrl,
    log,
  });

  let direct: Awaited<ReturnType<typeof startDirectServer>> | undefined;
  try {
    direct = await startDirectServer(hub, { port: settings.port, lan: settings.lan, log });
  } catch (err) {
    process.stderr.write(
      `${c.red(symbols.fail)} Could not listen on port ${settings.port}: ${(err as Error).message}\n` +
        `  Another daemon running? Try ${c.bold("cca remote status")} or ${c.bold("--port <n>")}.\n`,
    );
    return 1;
  }
  const relay = settings.relayUrl ? await startRelayClient(hub, identity, settings.relayUrl, log) : undefined;
  if (!relay) log("relay: off (set one with `cca remote config --relay wss://…`)");

  log(`device ${identity.deviceId} · pair with \`cca remote pair\``);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      log("shutting down");
      relay?.stop();
      direct?.stop();
      void hub.shutdown().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function pair(args: RemoteArgs): Promise<number> {
  const identity = await ensureIdentity({ rotate: args.flags.rotate });
  const settings = await loadRemoteSettings();
  const url = pairingUrl(identity, settings, lanAddress());

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ url, deviceId: identity.deviceId, relayUrl: settings.relayUrl })}\n`);
    return 0;
  }

  if (args.flags.rotate) {
    process.stdout.write(`${c.yellow(symbols.warn)} Keys rotated: every paired device must scan again.\n`);
  }
  if (!settings.relayUrl && !settings.lan) {
    process.stdout.write(
      `${c.yellow(symbols.warn)} No relay and LAN listening is off — only this Mac can connect.\n` +
        `  ${c.gray("cca remote config --relay wss://<worker>.workers.dev   or   --lan")}\n\n`,
    );
  }
  const qr = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  process.stdout.write(`${qr}\n`);
  process.stdout.write(
    `Scan with CCA Remote, or paste this link:\n${c.gray(url)}\n\n` +
      `  device   ${identity.deviceId}\n` +
      `  relay    ${settings.relayUrl ?? c.gray("off")}\n` +
      `  direct   ${settings.lan ? `ws://${lanAddress() ?? "?"}:${settings.port}/ws` : c.gray("loopback only")}\n`,
  );
  return 0;
}

async function configure(args: RemoteArgs): Promise<number> {
  const settings = await settingsFrom(args, true);
  process.stdout.write(
    `${c.green(symbols.ok)} Saved.\n` +
      `  port   ${settings.port}\n` +
      `  lan    ${settings.lan ? "on" : "off"}\n` +
      `  relay  ${settings.relayUrl ?? "off"}\n` +
      `  idle   ${settings.idleTimeoutSec / 60}m before an idle session's process is closed\n` +
      `${c.gray("Restart the daemon (cca remote install, or re-run serve) to apply.")}\n`,
  );
  return 0;
}

async function status(): Promise<number> {
  const identity = await loadIdentity();
  const settings = await loadRemoteSettings();
  if (!identity) {
    process.stdout.write(`${c.yellow("Not set up.")} Run ${c.bold("cca remote pair")} to create an identity.\n`);
    return 0;
  }
  interface Health {
    relayConnected?: boolean;
    claudeVersion?: string;
  }
  let health: Health | null = null;
  try {
    const response = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(1_500) });
    if (response.ok) health = (await response.json()) as Health;
  } catch {
    /* not running */
  }
  process.stdout.write(
    `${health ? c.green(symbols.ok) : c.gray(symbols.fail)} daemon ${health ? "running" : "not running"} on port ${settings.port}\n` +
      `  device   ${identity.deviceId}\n` +
      `  relay    ${settings.relayUrl ?? c.gray("off")}${health ? (health.relayConnected ? c.green(" · connected") : c.yellow(" · disconnected")) : ""}\n` +
      `  lan      ${settings.lan ? "on" : "off"}\n` +
      (health?.claudeVersion ? `  claude   ${health.claudeVersion}\n` : "") +
      (health ? "" : `  ${c.gray("start it with `cca remote serve` or `cca remote install`")}\n`),
  );
  return 0;
}

function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

async function install(args: RemoteArgs): Promise<number> {
  if (process.platform !== "darwin") {
    process.stderr.write(`${c.yellow(symbols.warn)} Auto-start is macOS-only for now; run ${c.bold("cca remote serve")} under your own supervisor.\n`);
    return 1;
  }
  await settingsFrom(args, true);
  await ensureIdentity();
  const program = [process.execPath, ...selfArgs(process.argv[1]), "remote", "serve"];
  const path = launchdPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((p) => `    <string>${escapeXml(p)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
    <key>HOME</key><string>${escapeXml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${join(CCA_HOME, "logs", "remote.log")}</string>
  <key>StandardErrorPath</key><string>${join(CCA_HOME, "logs", "remote.log")}</string>
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
    process.stderr.write(`${c.yellow(symbols.warn)} Wrote ${path} but launchctl bootstrap failed: ${stderr.trim()}\n`);
    return 1;
  }
  process.stdout.write(
    `${c.green(symbols.ok)} Installed launch agent; the daemon now starts at login and restarts if it dies.\n` +
      `  log: ${join(CCA_HOME, "logs", "remote.log")}\n  next: ${c.bold("cca remote pair")}\n`,
  );
  return 0;
}

async function uninstall(): Promise<number> {
  const uid = process.getuid?.() ?? 501;
  await runQuiet("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  await rm(launchdPath(), { force: true });
  process.stdout.write(`${c.green(symbols.ok)} Removed the launch agent. Pairing keys stay in ${join(CCA_HOME, "remote")}.\n`);
  return 0;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** First non-loopback IPv4; good enough for a QR code hint. */
export function lanAddress(): string | undefined {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(utun|bridge|awdl|llw|vmnet)/.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

function runQuiet(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", () => resolve({ code: 1, stdout, stderr }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  });
}

export { DEFAULT_REMOTE_SETTINGS };
