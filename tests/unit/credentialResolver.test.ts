import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveCredential,
  defaultCredentialsPath,
  __test,
} from '../../src/credentialResolver.js';

const VALID_OAUTH = 'sk-ant-oat01-' + 'A'.repeat(80);
const VALID_API   = 'sk-ant-api03-' + 'B'.repeat(80);

interface FakeSecrets {
  oauth?: string;
  api?: string;
}

function makeAccessor(s: FakeSecrets) {
  return {
    getOAuthToken: async () => s.oauth,
    getApiKey:     async () => s.api,
  };
}

let tmpDir: string;
let tmpFile: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-cred-'));
  tmpFile = path.join(tmpDir, '.credentials.json');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_REVIEW_OAUTH_TOKEN;
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('credentialResolver — pure helpers', () => {
  it('extractOAuthToken finds claudeAiOauth.accessToken', () => {
    const v = __test.extractOAuthToken({
      claudeAiOauth: { accessToken: VALID_OAUTH, refreshToken: 'sk-ant-ort01-...' },
    });
    expect(v).toBe(VALID_OAUTH);
  });

  it('extractOAuthToken finds an oauth.access_token shape', () => {
    const v = __test.extractOAuthToken({ oauth: { access_token: VALID_OAUTH } });
    expect(v).toBe(VALID_OAUTH);
  });

  it('extractOAuthToken finds top-level accessToken', () => {
    const v = __test.extractOAuthToken({ accessToken: VALID_OAUTH });
    expect(v).toBe(VALID_OAUTH);
  });

  it('extractOAuthToken returns null when no oauth-shaped string exists', () => {
    expect(__test.extractOAuthToken({ apiKey: VALID_API })).toBeNull();
    expect(__test.extractOAuthToken({})).toBeNull();
    expect(__test.extractOAuthToken('plain')).toBeNull();
  });

  it('extractOAuthToken does not match an api-key-shaped string', () => {
    expect(__test.extractOAuthToken({ x: VALID_API })).toBeNull();
  });

  it('extractOAuthToken bounds depth (no DoS via deep nesting)', () => {
    let nested: Record<string, unknown> = { token: VALID_OAUTH };
    for (let i = 0; i < 20; i++) nested = { wrap: nested };
    expect(__test.extractOAuthToken(nested)).toBeNull();
  });

  it('OAUTH_RX accepts well-shaped oauth tokens, rejects api keys', () => {
    expect(__test.OAUTH_RX.test(VALID_OAUTH)).toBe(true);
    expect(__test.OAUTH_RX.test(VALID_API)).toBe(false);
    expect(__test.OAUTH_RX.test('')).toBe(false);
  });

  it('defaultCredentialsPath ends with .claude/.credentials.json', () => {
    const p = defaultCredentialsPath();
    expect(p.endsWith(path.join('.claude', '.credentials.json'))).toBe(true);
  });
});

describe('credentialResolver — resolution order', () => {
  it('CLAUDE_CODE_OAUTH_TOKEN env var wins over everything else', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = VALID_OAUTH;
    await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-OTHER' + 'A'.repeat(70) } }));
    const out = await resolveCredential(makeAccessor({ api: VALID_API }), () => {}, tmpFile);
    expect(out?.kind).toBe('oauth');
    expect(out?.source).toBe('env-claude-code');
    expect(out?.token).toBe(VALID_OAUTH);
  });

  it('CLAUDE_REVIEW_OAUTH_TOKEN wins over secrets and file', async () => {
    process.env.CLAUDE_REVIEW_OAUTH_TOKEN = VALID_OAUTH;
    const out = await resolveCredential(makeAccessor({ oauth: 'sk-ant-oat01-' + 'Z'.repeat(80) }), () => {}, tmpFile);
    expect(out?.source).toBe('env-claude-review');
  });

  it('SecretStorage OAuth wins over file when env unset', async () => {
    const out = await resolveCredential(makeAccessor({ oauth: VALID_OAUTH }), () => {}, tmpFile);
    expect(out?.source).toBe('secrets-oauth');
    expect(out?.kind).toBe('oauth');
  });

  it('falls back to credentials file when no env / no secret', async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: VALID_OAUTH } }));
    const out = await resolveCredential(makeAccessor({}), () => {}, tmpFile);
    expect(out?.source).toBe('claude-code-file');
    expect(out?.kind).toBe('oauth');
    expect(out?.token).toBe(VALID_OAUTH);
  });

  it('falls back to api key when no oauth source present', async () => {
    const out = await resolveCredential(makeAccessor({ api: VALID_API }), () => {}, tmpFile);
    expect(out?.kind).toBe('api');
    expect(out?.source).toBe('secrets-api-key');
  });

  it('returns null when no credential is found', async () => {
    const out = await resolveCredential(makeAccessor({}), () => {}, tmpFile);
    expect(out).toBeNull();
  });
});

describe('credentialResolver — defensive against malformed sources', () => {
  it('ignores env vars that do not match oauth shape', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'totally-not-an-oauth-token';
    await fs.writeFile(tmpFile, JSON.stringify({ accessToken: VALID_OAUTH }));
    const out = await resolveCredential(makeAccessor({}), () => {}, tmpFile);
    expect(out?.source).toBe('claude-code-file'); // env was rejected, file used
  });

  it('continues past a malformed credentials file', async () => {
    await fs.writeFile(tmpFile, '{ this is not json');
    const warnings: string[] = [];
    const out = await resolveCredential(
      makeAccessor({ api: VALID_API }),
      (k, m) => warnings.push(`${k}:${m}`),
      tmpFile,
    );
    expect(out?.kind).toBe('api'); // fell through to api key
    expect(warnings.some((w) => w.startsWith('credentials.parse-failed'))).toBe(true);
  });

  it('continues past a missing credentials file silently', async () => {
    const warnings: string[] = [];
    const out = await resolveCredential(
      makeAccessor({ api: VALID_API }),
      (k, m) => warnings.push(`${k}:${m}`),
      path.join(tmpDir, 'does-not-exist.json'),
    );
    expect(out?.kind).toBe('api');
    expect(warnings.length).toBe(0); // ENOENT must not warn
  });

  it('ignores a file whose JSON contains no oauth-shaped string', async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ unrelated: 'data', apiKey: VALID_API }));
    const out = await resolveCredential(makeAccessor({}), () => {}, tmpFile);
    expect(out).toBeNull();
  });
});
