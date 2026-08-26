/** Talks to the Claude API with a profile's OAuth token. */
import type { ClaudeAiOauth, CredentialBlob } from "./store/index.ts";

/** Claude Code's public OAuth client id, from the v2.1.246 binary. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const API_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

const OAUTH_BETA = "oauth-2025-04-20";

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
    "anthropic-version": "2023-06-01",
  };
}

export interface LimitWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageSnapshot {
  five_hour: LimitWindow | null;
  seven_day: LimitWindow | null;
  seven_day_opus?: LimitWindow | null;
  [key: string]: unknown;
}

export class AuthExpiredError extends Error {
  constructor(message = "access token rejected — the profile needs a refresh or re-login") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export async function fetchUsage(accessToken: string): Promise<UsageSnapshot> {
  const res = await fetch(`${API_BASE}/api/oauth/usage`, {
    headers: oauthHeaders(accessToken),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`usage request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as UsageSnapshot;
}

export interface ProfileInfo {
  email?: string;
  accountUuid?: string;
  organizationName?: string;
  displayName?: string;
  /** "max", "pro" or "free", derived from the account flags. */
  plan?: string;
}

export async function fetchProfile(accessToken: string): Promise<ProfileInfo> {
  const res = await fetch(`${API_BASE}/api/oauth/profile`, {
    headers: oauthHeaders(accessToken),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`profile request failed: ${res.status}`);
  const body = (await res.json()) as {
    account?: {
      email?: string;
      uuid?: string;
      display_name?: string;
      has_claude_pro?: boolean;
      has_claude_max?: boolean;
    };
    organization?: { name?: string };
  };
  const account = body.account;
  return {
    email: account?.email,
    accountUuid: account?.uuid,
    displayName: account?.display_name,
    organizationName: body.organization?.name,
    plan: account?.has_claude_max ? "max" : account?.has_claude_pro ? "pro" : "free",
  };
}

/**
 * Exchange the refresh token for a fresh pair.
 *
 * The server rotates the refresh token, so the caller MUST persist the result
 * — dropping it on the floor logs the profile out.
 */
export async function refreshTokens(oauth: ClaudeAiOauth): Promise<ClaudeAiOauth> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      throw new AuthExpiredError(`refresh token rejected (${res.status}) — re-login required`);
    }
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const now = Date.now();
  return {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? oauth.refreshToken,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
    scopes: body.scope ? body.scope.split(" ") : oauth.scopes,
  };
}

/** Refresh is due once we are inside this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function needsRefresh(oauth: ClaudeAiOauth): boolean {
  return oauth.expiresAt - Date.now() < REFRESH_SKEW_MS;
}

export function refreshTokenExpired(oauth: ClaudeAiOauth): boolean {
  return oauth.refreshTokenExpiresAt !== undefined && oauth.refreshTokenExpiresAt <= Date.now();
}

export interface WarmResult {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Start the 5-hour session window with the smallest possible real request.
 *
 * This is an ordinary API call billed against the account's normal quota — it
 * shifts *when* the window starts, it does not enlarge it.
 */
export async function warmSession(accessToken: string, model: string): Promise<WarmResult> {
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: "POST",
    headers: { ...oauthHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      // The OAuth-scoped endpoint expects the Claude Code system preamble.
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      messages: [{ role: "user", content: "ok" }],
    }),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`warm-up failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    model: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    model: body.model,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}

export function oauthOf(blob: CredentialBlob | null): ClaudeAiOauth | null {
  return blob?.claudeAiOauth ?? null;
}
