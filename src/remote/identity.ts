/**
 * The daemon's identity and pairing material: ~/.ccacc/remote/identity.json.
 *
 * One device id, one relay pair of tokens, one end-to-end key. Every paired
 * app shares the same key — this is a personal tool, and "revoke one phone"
 * is spelled `cca remote pair --rotate`, which re-keys everything.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CCA_HOME } from "../config.ts";
import { randomBytes, toBase64Url } from "./crypto.ts";

export const REMOTE_DIR = join(CCA_HOME, "remote");
const IDENTITY_PATH = join(REMOTE_DIR, "identity.json");

export interface Identity {
  version: 1;
  /** Public-ish: names the relay room. 16 random bytes, hex. */
  deviceId: string;
  /** Presented by the daemon to the relay. */
  daemonToken: string;
  /** Presented by apps to the relay and to a direct daemon socket. */
  clientToken: string;
  /** 32 bytes, base64url. Seals every frame that crosses the relay. */
  e2eKey: string;
  createdAt: string;
  rotatedAt?: string;
}

export interface RemoteSettings {
  /** Loopback port for direct connections. */
  port: number;
  /** Also listen on every interface, for the LAN. */
  lan: boolean;
  /** wss://… of the relay Worker; undefined disables the relay. */
  relayUrl?: string;
  /** Seconds an idle managed session keeps its Claude process alive. */
  idleTimeoutSec: number;
}

const SETTINGS_PATH = join(REMOTE_DIR, "settings.json");

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  port: 48_712,
  lan: false,
  idleTimeoutSec: 20 * 60,
};

function freshIdentity(): Identity {
  return {
    version: 1,
    deviceId: Buffer.from(randomBytes(16)).toString("hex"),
    daemonToken: toBase64Url(randomBytes(32)),
    clientToken: toBase64Url(randomBytes(32)),
    e2eKey: toBase64Url(randomBytes(32)),
    createdAt: new Date().toISOString(),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(REMOTE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function loadIdentity(): Promise<Identity | null> {
  try {
    const parsed = JSON.parse(await readFile(IDENTITY_PATH, "utf8")) as Identity;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Create the identity on first use; `rotate` replaces every secret. */
export async function ensureIdentity(options: { rotate?: boolean } = {}): Promise<Identity> {
  const existing = await loadIdentity();
  if (existing && !options.rotate) return existing;
  const next: Identity = existing
    ? { ...freshIdentity(), deviceId: existing.deviceId, createdAt: existing.createdAt, rotatedAt: new Date().toISOString() }
    : freshIdentity();
  await writeJson(IDENTITY_PATH, next);
  return next;
}

export async function loadRemoteSettings(): Promise<RemoteSettings> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<RemoteSettings>;
    return { ...DEFAULT_REMOTE_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_REMOTE_SETTINGS };
  }
}

export async function saveRemoteSettings(settings: RemoteSettings): Promise<void> {
  await writeJson(SETTINGS_PATH, settings);
}

export interface PairingPayload {
  v: 1;
  deviceId: string;
  clientToken: string;
  e2eKey: string;
  relayUrl?: string;
  /** ws://<lan-ip>:<port> when LAN listening is on. */
  directUrl?: string;
  hostname: string;
}

/** What the QR code carries. Custom scheme so the app can claim it. */
export function pairingUrl(identity: Identity, settings: RemoteSettings, lanIp?: string): string {
  const payload: PairingPayload = {
    v: 1,
    deviceId: identity.deviceId,
    clientToken: identity.clientToken,
    e2eKey: identity.e2eKey,
    relayUrl: settings.relayUrl,
    directUrl: settings.lan && lanIp ? `ws://${lanIp}:${settings.port}` : undefined,
    hostname: hostname(),
  };
  return `ccaremote://pair#${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}
