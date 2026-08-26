/**
 * Reproduces Claude Code's own credential-storage addressing.
 *
 * Derived from the CC binary (v2.1.246). The relevant code is:
 *
 *   function v(n = "") {
 *     let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *         t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
 *         r = e !== undefined ? e.normalize("NFC") : configDir(),
 *         s = t ? "" : `-${sha256(r).digest("hex").substring(0, 8)}`;
 *     return `Claude Code${OAUTH_FILE_SUFFIX}${n}${s}`;
 *   }
 *
 * In other words: the storage key is namespaced by a hash of the *effective*
 * config directory. Point CC at a different directory and it transparently
 * uses a different credential slot — which is exactly the multi-account
 * primitive this tool is built on.
 */
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** Empty for production builds of Claude Code; kept for fidelity. */
const OAUTH_FILE_SUFFIX = "";

const CREDENTIALS_SUFFIX = "-credentials";

/** CC sanitises the keychain account name against this. */
const ACCOUNT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export const DEFAULT_CC_CONFIG_DIR = join(homedir(), ".claude");

/** Normalise the way CC does before hashing — NFC, so unicode paths agree. */
export function normalizeDir(dir: string): string {
  return dir.normalize("NFC");
}

/**
 * The keychain service / credential-manager target / file namespace that CC
 * will use for a given storage directory.
 *
 * Passing `undefined` yields the *default* slot — the one a plain `claude`
 * login writes to, and the one we import the user's existing session from.
 */
export function credentialServiceName(storageDir?: string): string {
  if (storageDir === undefined) {
    return `Claude Code${OAUTH_FILE_SUFFIX}${CREDENTIALS_SUFFIX}`;
  }
  const hash = createHash("sha256")
    .update(normalizeDir(storageDir))
    .digest("hex")
    .substring(0, 8);
  return `Claude Code${OAUTH_FILE_SUFFIX}${CREDENTIALS_SUFFIX}-${hash}`;
}

/** CC's account-name derivation, including its fallback. */
export function credentialAccountName(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return ACCOUNT_NAME_RE.test(name) ? name : "claude-code-user";
}

/** Where the flat-file backend keeps credentials for a storage directory. */
export function credentialFilePath(storageDir?: string): string {
  return join(storageDir ?? DEFAULT_CC_CONFIG_DIR, ".credentials.json");
}

export type IsolationMode = "shared" | "isolated";

/**
 * The environment that pins Claude Code to a profile.
 *
 * - `shared`   — only credentials are separated. History, projects,
 *                settings.json, plugins and MCP servers stay in ~/.claude.
 * - `isolated` — a completely separate CC config directory.
 */
export function profileEnv(
  storageDir: string,
  mode: IsolationMode,
): Record<string, string> {
  return mode === "shared"
    ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: storageDir }
    : { CLAUDE_CONFIG_DIR: storageDir };
}
