import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, ServerHandle, __test as serverTest } from '../../src/server.js';
import { Logger } from '../../src/logger.js';
import type { PreToolUsePayload, PostToolUsePayload, StopPayload } from '../../src/messages.js';

const TOKEN = 'a'.repeat(64); // 32-byte hex equivalent length

interface RecordedCalls {
  pre:  PreToolUsePayload[];
  post: PostToolUsePayload[];
  stop: StopPayload[];
}

async function bootServer(): Promise<{ handle: ServerHandle; calls: RecordedCalls; baseUrl: string }> {
  const calls: RecordedCalls = { pre: [], post: [], stop: [] };
  const logger = new Logger('Test', 'error'); // suppress noise
  const handle = await startServer({
    preferredPort: 0,
    bearerToken: TOKEN,
    logger,
    onPreToolUse:  (p) => { calls.pre.push(p); },
    onPostToolUse: (p) => { calls.post.push(p); },
    onStop:        (p) => { calls.stop.push(p); },
  });
  return { handle, calls, baseUrl: `http://127.0.0.1:${handle.port}` };
}

let booted: { handle: ServerHandle; calls: RecordedCalls; baseUrl: string };

beforeEach(async () => {
  booted = await bootServer();
});

afterEach(async () => {
  await booted.handle.dispose();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${booted.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('server — auth', () => {
  it('returns 401 when Authorization header missing', async () => {
    const res = await post('/pre-tool-use', {});
    expect(res.status).toBe(401);
  });

  it('returns 401 on wrong token', async () => {
    const res = await post('/pre-tool-use', {}, { Authorization: 'Bearer ' + 'b'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is shorter than expected', async () => {
    const res = await post('/pre-tool-use', {}, { Authorization: 'Bearer short' });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const res = await post(
      '/pre-tool-use',
      { session_id: 'a', tool_name: 'Edit', tool_input: { file_path: '/x' }, cwd: '/work' },
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
  });
});

describe('server — auth.failed observability (2026-05-19)', () => {
  it('logs auth.failed at warn level and invokes onAuthFailure on 401', async () => {
    // Boot a separate server so we can spy on logger + capture callback fires.
    const logger = new Logger('test', 'warn');
    const warnSpy = ((): { calls: Array<[string, string, Record<string, unknown> | undefined]> } => {
      const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
      const original = logger.warn.bind(logger);
      logger.warn = ((src: string, evt: string, props?: Record<string, unknown>) => {
        calls.push([src, evt, props]);
        return original(src, evt, props);
      }) as typeof logger.warn;
      return { calls };
    })();
    let authFailureFires = 0;
    const handle = await startServer({
      preferredPort: 0,
      bearerToken: TOKEN,
      logger,
      onPreToolUse: () => {},
      onPostToolUse: () => {},
      onStop: () => {},
      onAuthFailure: () => { authFailureFires++; },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      // 1. No header
      await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // 2. Malformed header (no "Bearer " prefix)
      await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'bogus' },
        body: '{}',
      });
      // 3. Wrong token (correct Bearer prefix)
      await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + 'b'.repeat(64) },
        body: '{}',
      });

      // Three failures → three warn calls + three callback invocations.
      const authLogs = warnSpy.calls.filter(([src, evt]) => src === 'server' && evt === 'auth.failed');
      expect(authLogs.length).toBe(3);
      expect(authFailureFires).toBe(3);

      // Schema of the log payload — length-only, never the bytes.
      const [src1, evt1, props1] = authLogs[0]!;
      expect(src1).toBe('server');
      expect(evt1).toBe('auth.failed');
      expect(props1).toMatchObject({
        route: '/pre-tool-use',
        hadHeader: false,
        headerLooksLikeBearer: false,
        headerPrefix: null,
        suppliedLen: 0,
        expectedLen: TOKEN.length,
      });

      // Second call: header present but not a bearer (literal "bogus").
      expect(authLogs[1]![2]).toMatchObject({
        hadHeader: true,
        headerLooksLikeBearer: false,
        headerPrefix: 'bogus',
        suppliedLen: 0,
      });

      // Third call: bearer prefix present, supplied len matches the 64-char token.
      const third = authLogs[2]![2] as Record<string, unknown>;
      expect(third).toMatchObject({
        hadHeader: true,
        headerLooksLikeBearer: true,
        suppliedLen: 64,
        expectedLen: 64,
      });
      // First 13 chars = "Bearer " + 6 token bytes. Verify shape, not exact bytes.
      expect(third.headerPrefix).toMatch(/^Bearer [a-z]{6}$/);
    } finally {
      await handle.dispose();
    }
  });

  it('truncates headerPrefix correctly when header is shorter than 13 chars', async () => {
    const logger = new Logger('test', 'warn');
    const warnCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const original = logger.warn.bind(logger);
    logger.warn = ((src: string, evt: string, props?: Record<string, unknown>) => {
      warnCalls.push([src, evt, props]);
      return original(src, evt, props);
    }) as typeof logger.warn;

    const handle = await startServer({
      preferredPort: 0, bearerToken: TOKEN, logger,
      onPreToolUse: () => {}, onPostToolUse: () => {}, onStop: () => {},
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      // Header "Bearer x" — 8 chars, DOES start with "Bearer ", token portion
      // is 1 char. slice(0, 13) on 8-char string returns the full 8 chars.
      await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer x' },
        body: '{}',
      });
      // Single-char header.
      await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'a' },
        body: '{}',
      });

      const authLogs = warnCalls.filter(([s, e]) => s === 'server' && e === 'auth.failed');
      expect(authLogs.length).toBe(2);

      // "Bearer x" (8 chars) — bearer prefix present, supplied token is 1 char.
      // slice(0,13) on an 8-char string returns the full string.
      expect(authLogs[0]![2]).toMatchObject({
        hadHeader: true,
        headerLooksLikeBearer: true,
        headerPrefix: 'Bearer x',
        suppliedLen: 1,
        expectedLen: TOKEN.length,
      });
      // "a" (1 char) — headerLooksLikeBearer=false (no Bearer prefix).
      expect(authLogs[1]![2]).toMatchObject({
        hadHeader: true,
        headerLooksLikeBearer: false,
        headerPrefix: 'a',
        suppliedLen: 0,
      });
    } finally {
      await handle.dispose();
    }
  });

  it('does NOT invoke onAuthFailure on a successful (200) request', async () => {
    const logger = new Logger('test', 'error');
    let authFailureFires = 0;
    const handle = await startServer({
      preferredPort: 0,
      bearerToken: TOKEN,
      logger,
      onPreToolUse: () => {},
      onPostToolUse: () => {},
      onStop: () => {},
      onAuthFailure: () => { authFailureFires++; },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const res = await fetch(`${base}/pre-tool-use`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          session_id: 'sx', tool_name: 'Edit',
          tool_input: { file_path: '/x' }, cwd: '/work',
        }),
      });
      expect(res.status).toBe(200);
      expect(authFailureFires).toBe(0);
    } finally {
      await handle.dispose();
    }
  });

  it('does not throw 500 if onAuthFailure callback itself throws', async () => {
    const logger = new Logger('test', 'error');
    const handle = await startServer({
      preferredPort: 0,
      bearerToken: TOKEN,
      logger,
      onPreToolUse: () => {},
      onPostToolUse: () => {},
      onStop: () => {},
      onAuthFailure: () => { throw new Error('detector exploded'); },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // The auth path still returns 401 even though the callback threw.
      expect(res.status).toBe(401);
    } finally {
      await handle.dispose();
    }
  });
});

describe('server — auth helper (unit)', () => {
  it('rejects non-bearer header', () => {
    const expected = Buffer.from(TOKEN, 'utf8');
    const dummy = Buffer.alloc(expected.length, 0);
    expect(serverTest.authorize('Basic abc', expected, dummy)).toBe(false);
  });

  it('rejects undefined header', () => {
    const expected = Buffer.from(TOKEN, 'utf8');
    const dummy = Buffer.alloc(expected.length, 0);
    expect(serverTest.authorize(undefined, expected, dummy)).toBe(false);
  });

  it('accepts identical token', () => {
    const expected = Buffer.from(TOKEN, 'utf8');
    const dummy = Buffer.alloc(expected.length, 0);
    expect(serverTest.authorize(`Bearer ${TOKEN}`, expected, dummy)).toBe(true);
  });
});

describe('server — schema', () => {
  it('schema mismatch returns 200 {} (does not block Claude Code)', async () => {
    const res = await post('/pre-tool-use', { totally: 'wrong' }, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(booted.calls.pre.length).toBe(0);
  });

  it('non-Edit tool names are skipped silently', async () => {
    const res = await post(
      '/pre-tool-use',
      { session_id: 'a', tool_name: 'Bash', tool_input: { file_path: '/x' }, cwd: '/work' },
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    expect(booted.calls.pre.length).toBe(0);
  });

  it('valid Edit invokes the handler', async () => {
    await post(
      '/pre-tool-use',
      { session_id: 'a', tool_name: 'Edit', tool_input: { file_path: '/x' }, cwd: '/work' },
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(booted.calls.pre.length).toBe(1);
    expect(booted.calls.pre[0].session_id).toBe('a');
  });

  it('Stop with stop_hook_active=true still invokes orchestrator (orchestrator gates internally)', async () => {
    // Orchestrator handles the gate; the server itself must always pass the payload.
    await post(
      '/stop',
      { session_id: 'a', stop_hook_active: true },
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(booted.calls.stop.length).toBe(1);
    expect(booted.calls.stop[0].stop_hook_active).toBe(true);
  });
});

describe('server — body limit', () => {
  it('rejects payloads exceeding 10MB', async () => {
    // Fastify's bodyLimit may close the connection (ECONNRESET) or respond 413 depending
    // on when the limit is detected; either is acceptable as long as the handler is NOT invoked.
    const huge = {
      session_id: 'a',
      tool_name: 'Edit',
      tool_input: { file_path: '/x', content: 'x'.repeat(11 * 1024 * 1024) },
      cwd: '/work',
    };
    let rejected = false;
    try {
      const res = await post('/pre-tool-use', huge, { Authorization: `Bearer ${TOKEN}` });
      rejected = [413, 400, 500].includes(res.status);
    } catch {
      rejected = true; // ECONNRESET / fetch-failed both count
    }
    expect(rejected).toBe(true);
    expect(booted.calls.pre.length).toBe(0);
  });
});

describe('server — fuzz', () => {
  it('survives 200 random payloads without crashing', async () => {
    const samples = Array.from({ length: 200 }, () => ({
      [Math.random().toString(36).slice(2)]: Math.random(),
      ['nested_' + Math.random().toString(36).slice(2)]: { x: Math.random() > 0.5 },
    }));
    const results = await Promise.all(
      samples.map((s) => post('/post-tool-use', s, { Authorization: `Bearer ${TOKEN}` })),
    );
    for (const r of results) {
      expect([200, 401]).toContain(r.status);
    }
  });
});

describe('server — health', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${booted.baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('rejects /health without token', async () => {
    const res = await fetch(`${booted.baseUrl}/health`);
    expect(res.status).toBe(401);
  });
});

describe('server — 404', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await post('/nope', {}, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
  });
});
