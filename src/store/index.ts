/** Picks the backend Claude Code itself would use on this platform. */
import { credentialAccountName, credentialFilePath, credentialServiceName } from "../cc-paths.ts";
import { credmanAvailable, credmanStore } from "./credman.ts";
import { darwinStore } from "./darwin.ts";
import { fileStore } from "./file.ts";
import type { CredentialBlob, CredentialSlot, CredentialStore } from "./types.ts";

export type { ClaudeAiOauth, CredentialBlob, CredentialSlot } from "./types.ts";

let cached: CredentialStore | null = null;

export async function getStore(): Promise<CredentialStore> {
  if (cached) return cached;
  if (process.platform === "darwin") {
    cached = darwinStore;
  } else if (process.platform === "win32") {
    cached = (await credmanAvailable()) ? credmanStore : fileStore;
  } else {
    cached = fileStore;
  }
  return cached;
}

/**
 * Address the credential slot for a storage directory.
 * `undefined` means the default slot — where a plain `claude` login lands.
 */
export function slotFor(storageDir?: string): CredentialSlot {
  return {
    service: credentialServiceName(storageDir),
    account: credentialAccountName(),
    filePath: credentialFilePath(storageDir),
  };
}

export async function readSlot(storageDir?: string): Promise<CredentialBlob | null> {
  const store = await getStore();
  return store.read(slotFor(storageDir));
}

export async function writeSlot(storageDir: string | undefined, blob: CredentialBlob): Promise<void> {
  const store = await getStore();
  return store.write(slotFor(storageDir), blob);
}

export async function removeSlot(storageDir?: string): Promise<void> {
  const store = await getStore();
  return store.remove(slotFor(storageDir));
}
