import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Secret management (TRD §5.9, §14.1).
 *
 * Two secrets live here:
 *   - Bearer token: 32 random bytes (hex). Rotated at every activation. Used
 *     by the loopback HTTP server to authenticate Claude Code hook calls.
 *   - Anthropic API key: long-lived; user-supplied. Validated with a regex
 *     that matches public Anthropic key shape; never written to disk.
 *
 * Both live in `context.secrets`, which is OS-keychain-backed on every
 * supported platform.
 */

const BEARER_KEY    = 'claudeReview.bearerToken';
const API_KEY_KEY   = 'claudeReview.anthropicApiKey';
const OAUTH_KEY     = 'claudeReview.anthropicOAuthToken';
const API_KEY_RX    = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const OAUTH_TOKEN_RX = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

export class SecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Returns existing token, or generates and stores one if absent. */
  async getOrCreateBearerToken(): Promise<string> {
    const existing = await this.secrets.get(BEARER_KEY);
    if (existing && existing.length === 64) return existing; // 32 bytes hex
    return this.rotateBearerToken();
  }

  /** Always generates a new token. Used at activation per TRD §14.2. */
  async rotateBearerToken(): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.secrets.store(BEARER_KEY, token);
    return token;
  }

  /** Removes the bearer token; called from `deactivate()` if configured. */
  async clearBearerToken(): Promise<void> {
    await this.secrets.delete(BEARER_KEY);
  }

  async getApiKey(): Promise<string | undefined> {
    const v = await this.secrets.get(API_KEY_KEY);
    return v && v.length > 0 ? v : undefined;
  }

  async setApiKey(rawKey: string): Promise<void> {
    const key = rawKey.trim();
    if (!API_KEY_RX.test(key)) {
      throw new Error('Invalid Anthropic API key format. Expected `sk-ant-…`.');
    }
    await this.secrets.store(API_KEY_KEY, key);
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(API_KEY_KEY);
  }

  // -- OAuth token (Claude Pro / Max) ----------------------------------------

  async getOAuthToken(): Promise<string | undefined> {
    const v = await this.secrets.get(OAUTH_KEY);
    return v && v.length > 0 ? v : undefined;
  }

  async setOAuthToken(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!OAUTH_TOKEN_RX.test(token)) {
      throw new Error('Invalid Claude OAuth token. Expected `sk-ant-oat01-…`.');
    }
    await this.secrets.store(OAUTH_KEY, token);
  }

  async clearOAuthToken(): Promise<void> {
    await this.secrets.delete(OAUTH_KEY);
  }
}

/** Exported for unit tests. */
export const __test = { API_KEY_RX, OAUTH_TOKEN_RX };
