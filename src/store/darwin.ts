/**
 * macOS backend.
 *
 * Claude Code v2.1.246 reads credentials from the keychain first and falls
 * back to `<storage dir>/.credentials.json`; it reads the keychain through the
 * `security` CLI (`find-generic-password`) but writes it through a native
 * binding — the binary contains no `add-generic-password` call at all.
 *
 * That asymmetry decides the strategy here:
 *
 *   read   keychain, then file — exactly CC's own precedence, so we always see
 *          whatever CC last wrote, including credentials it has since migrated
 *          into the keychain itself.
 *
 *   write  the file, and clear the profile's keychain entry so the file is the
 *          authoritative copy at handoff. `security add-generic-password`
 *          truncates a piped secret at 128 bytes and otherwise needs the secret
 *          in argv, and a real credential blob is ~11 KB, so the file is both
 *          the safer and the only workable target. CC migrates it back into the
 *          keychain on its next token refresh.
 */
import { credentialServiceName } from "../cc-paths.ts";
import { fileStore } from "./file.ts";
import { keychainStore } from "./keychain.ts";
import type { CredentialStore } from "./types.ts";

/** The slot a plain `claude` login owns — never written or cleared by us. */
const DEFAULT_SERVICE = credentialServiceName(undefined);

export const darwinStore: CredentialStore = {
  kind: "keychain",

  async read(slot) {
    const fromKeychain = await keychainStore.read(slot).catch(() => null);
    if (fromKeychain?.claudeAiOauth) return fromKeychain;
    return fileStore.read(slot);
  },

  async write(slot, blob) {
    if (slot.service === DEFAULT_SERVICE) {
      throw new Error(
        "refusing to overwrite the default Claude Code credential slot — " +
          "profiles must have their own storage directory",
      );
    }
    await fileStore.write(slot, blob);
    // Drop any stale keychain copy so the file we just wrote is what CC reads.
    await keychainStore.remove(slot).catch(() => {});
  },

  async remove(slot) {
    if (slot.service === DEFAULT_SERVICE) {
      throw new Error("refusing to delete the default Claude Code credential slot");
    }
    await keychainStore.remove(slot).catch(() => {});
    await fileStore.remove(slot);
  },
};
