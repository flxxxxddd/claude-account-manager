/** Profile-level operations: read creds, keep them fresh, report limits. */
import {
  AuthExpiredError,
  RateLimitedError,
  fetchProfile,
  fetchUsage,
  needsRefresh,
  oauthOf,
  refreshTokenExpired,
  refreshTokens,
  type ProfileInfo,
  type UsageSnapshot,
} from "./api.ts";
import type { Config, Profile } from "./config.ts";
import { saveConfig } from "./config.ts";
import { withLock } from "./lock.ts";
import { readSlot, writeSlot, type ClaudeAiOauth } from "./store/index.ts";

export class NotLoggedInError extends Error {
  constructor(public profileName: string) {
    super(`profile "${profileName}" has no credentials — run \`cca login ${profileName}\``);
    this.name = "NotLoggedInError";
  }
}

/**
 * Return a usable access token for a profile, refreshing and persisting the
 * rotated pair when the current one is close to expiry.
 */
export async function accessTokenFor(
  name: string,
  profile: Profile,
  options: { allowRefresh?: boolean } = {},
): Promise<ClaudeAiOauth> {
  const allowRefresh = options.allowRefresh ?? true;
  const blob = await readSlot(profile.dir);
  const oauth = oauthOf(blob);
  if (!oauth) throw new NotLoggedInError(name);

  if (!allowRefresh || !needsRefresh(oauth)) return oauth;

  if (refreshTokenExpired(oauth)) {
    throw new AuthExpiredError(
      `profile "${name}" refresh token expired — run \`cca login ${name}\``,
    );
  }

  // Re-read inside the lock: another process may have rotated it already.
  return withLock(`token-${name}`, async () => {
    const current = oauthOf(await readSlot(profile.dir));
    if (current && !needsRefresh(current)) return current;

    const rotated = await refreshTokens(current ?? oauth);
    const latest = (await readSlot(profile.dir)) ?? {};
    await writeSlot(profile.dir, { ...latest, claudeAiOauth: rotated });
    return rotated;
  });
}

export interface ProfileStatus {
  name: string;
  profile: Profile;
  active: boolean;
  loggedIn: boolean;
  usage?: UsageSnapshot;
  /** When the refresh token dies and a browser login is required. */
  loginExpiresAt?: number;
  /** The credentials are fine; the usage endpoint just would not answer. */
  throttled?: boolean;
  error?: string;
}

export async function statusOf(
  name: string,
  profile: Profile,
  active: boolean,
  options: { usage?: boolean } = {},
): Promise<ProfileStatus> {
  const base: ProfileStatus = { name, profile, active, loggedIn: false };
  try {
    const oauth = await accessTokenFor(name, profile);
    base.loggedIn = true;
    base.loginExpiresAt = oauth.refreshTokenExpiresAt;
    if (options.usage !== false) base.usage = await fetchUsage(oauth.accessToken);
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    if (err instanceof NotLoggedInError) base.loggedIn = false;
    if (err instanceof RateLimitedError) base.throttled = true;
  }
  return base;
}

export async function statusAll(
  config: Config,
  options: { usage?: boolean } = {},
): Promise<ProfileStatus[]> {
  const entries = Object.entries(config.profiles);
  return Promise.all(
    entries.map(([name, profile]) =>
      statusOf(name, profile, name === config.activeProfile, options),
    ),
  );
}

/** Refresh the identity fields we cache for display. */
export async function syncProfileIdentity(
  config: Config,
  name: string,
  profile: Profile,
  accessToken: string,
): Promise<ProfileInfo> {
  const info = await fetchProfile(accessToken);
  const next: Profile = {
    ...profile,
    email: info.email ?? profile.email,
    accountUuid: info.accountUuid ?? profile.accountUuid,
    organizationName: info.organizationName ?? profile.organizationName,
  };
  config.profiles[name] = next;
  await saveConfig(config);
  return info;
}
