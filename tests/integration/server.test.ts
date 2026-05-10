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
