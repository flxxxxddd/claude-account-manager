/** The credential blob Claude Code stores, as observed in v2.1.246. */
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  /** epoch ms — refresh tokens live ~27 days, so idle profiles can rot. */
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialBlob {
  claudeAiOauth?: ClaudeAiOauth;
  /** Per-MCP-server OAuth tokens; carried through untouched. */
  mcpOAuth?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * One logical credential, addressed the way each backend needs it:
 * keychain and credential-manager key off `service`/`account`, the flat-file
 * backend keys off `filePath`.
 */
export interface CredentialSlot {
  service: string;
  account: string;
  filePath: string;
}

export interface CredentialStore {
  readonly kind: "keychain" | "file" | "credman";
  read(slot: CredentialSlot): Promise<CredentialBlob | null>;
  write(slot: CredentialSlot, blob: CredentialBlob): Promise<void>;
  remove(slot: CredentialSlot): Promise<void>;
}
