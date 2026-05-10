import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolves credentials for the Anthropic chat client (Max-plan support).
 *
 * Two credential shapes are supported:
 *
 *   - OAuth access token (`sk-ant-oat01-…`) — issued to Claude Pro/Max users
 *     via `claude login`. Used by the SDK as `authToken` (Bearer).
 *   - API key (`sk-ant-api03-…`) — issued through the Anthropic console.
 *     Used by the SDK as `apiKey` (`x-api-key`).
 *
 * Resolution order
 * ----------------
 *   1. `CLAUDE_CODE_OAUTH_TOKEN`       (env override; never written to disk by us)
 *   2. `CLAUDE_REVIEW_OAUTH_TOKEN`     (extension-specific override)
 *   3. SecretStorage-backed OAuth token (set via `claudeReview.setOAuthToken`)
 *   4. `~/.claude/.credentials.json`   (Claude Code's own credentials store)
 *   5. SecretStorage-backed API key    (set via `claudeReview.setApiKey`)
 *
 * The resolver returns `null` when nothing is found; the chat subsystem
 * surfaces a `no-key` error to the webview so the user can act.
 *
 * Privacy
 * -------
 * This module never logs token values. It only reports the *kind* of
 * credential discovered (`oauth` / `api`) and, for telemetry, the source
 * (`env` / `secrets` / `claude-code-file`).
 */

export type CredentialKind = 'oauth' | 'api';

export type CredentialSource =
  | 'env-claude-code'
  | 'env-claude-review'
  | 'secrets-oauth'
  | 'claude-code-file'
  | 'secrets-api-key';

export interface ResolvedCredential {
  kind: CredentialKind;
  token: string;
  source: CredentialSource;
}

export interface SecretsAccessor {
  getOAuthToken(): Promise<string | undefined>;
  getApiKey():     Promise<string | undefined>;
}

const OAUTH_RX = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;
const API_KEY_RX = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** Default credentials file location used by the Claude Code CLI. */
export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Locate a usable credential. The function never throws; on any read or
 * parse failure it logs through the supplied warn callback and continues
 * to the next source.
 */
export async function resolveCredential(
  secrets: SecretsAccessor,
  warn: (kind: string, msg: string) => void = () => {},
  credentialsPath: string = defaultCredentialsPath(),
): Promise<ResolvedCredential | null> {
  // 1. CLAUDE_CODE_OAUTH_TOKEN — well-known env var used by Anthropic tooling.
  const envClaudeCode = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envClaudeCode && OAUTH_RX.test(envClaudeCode)) {
    return { kind: 'oauth', token: envClaudeCode, source: 'env-claude-code' };
  }

  // 2. CLAUDE_REVIEW_OAUTH_TOKEN — our own escape hatch.
  const envOurs = process.env.CLAUDE_REVIEW_OAUTH_TOKEN?.trim();
  if (envOurs && OAUTH_RX.test(envOurs)) {
    return { kind: 'oauth', token: envOurs, source: 'env-claude-review' };
  }

  // 3. SecretStorage OAuth token (user pasted via setOAuthToken command).
  const stored = await safeAwait(secrets.getOAuthToken(), warn);
  if (stored && OAUTH_RX.test(stored)) {
    return { kind: 'oauth', token: stored, source: 'secrets-oauth' };
  }

  // 4. Claude Code's credentials file. Best-effort: if absent or malformed,
  //    fall through to the API-key path. Never block on schema drift.
  const fromFile = await readCredentialsFile(credentialsPath, warn);
  if (fromFile) {
    return { kind: 'oauth', token: fromFile, source: 'claude-code-file' };
  }

  // 5. SecretStorage API key (legacy / explicit path).
  const apiKey = await safeAwait(secrets.getApiKey(), warn);
  if (apiKey && API_KEY_RX.test(apiKey)) {
    return { kind: 'api', token: apiKey, source: 'secrets-api-key' };
  }

  return null;
}

async function readCredentialsFile(
  filePath: string,
  warn: (kind: string, msg: string) => void,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn('credentials.read-failed', `Could not read ${filePath}: ${(err as Error).message}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn('credentials.parse-failed', `Could not parse ${filePath}: ${(err as Error).message}`);
    return null;
  }

  return extractOAuthToken(parsed);
}

/**
 * Walks a parsed credentials object looking for an OAuth-shaped string.
 *
 * Claude Code's credentials file shape has shifted across versions
 * (`claudeAiOauth.accessToken`, `oauth.access_token`, plain top-level
 * `accessToken`, …). Rather than encode a brittle path, we walk the tree
 * and return the first value matching `OAUTH_RX`. If multiple candidates
 * exist, the first one wins (typically the most-recent / refreshed token).
 *
 * Bounded depth: 8 levels. Adversarial inputs cannot DoS this resolver.
 */
export function extractOAuthToken(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    return OAUTH_RX.test(value) ? value : null;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = extractOAuthToken(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = extractOAuthToken(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function safeAwait<T>(p: Promise<T>, warn: (kind: string, msg: string) => void): Promise<T | undefined> {
  try { return await p; }
  catch (err) {
    warn('credential.lookup-failed', (err as Error).message);
    return undefined;
  }
}

/** Exported for tests. */
export const __test = { OAUTH_RX, API_KEY_RX, readCredentialsFile, extractOAuthToken };
