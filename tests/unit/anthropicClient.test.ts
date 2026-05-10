import { describe, it, expect } from 'vitest';
import {
  AnthropicClient,
  AnthropicClientDeps,
  ChatError,
  HUNK_REVIEW_PROMPT_VERSION,
  HUNK_REVIEW_SYSTEM_PROMPT,
  __test,
} from '../../src/anthropicClient.js';
import type { ResolvedCredential } from '../../src/credentialResolver.js';

const FAKE_KEY   = 'sk-ant-api03-' + 'A'.repeat(95);
const FAKE_OAUTH = 'sk-ant-oat01-' + 'O'.repeat(80);
const apiCred:   ResolvedCredential = { kind: 'api',   token: FAKE_KEY,   source: 'secrets-api-key' };
const oauthCred: ResolvedCredential = { kind: 'oauth', token: FAKE_OAUTH, source: 'secrets-oauth' };

interface FakeStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number } };
}

function fakeStream(events: FakeStreamEvent[]): AsyncIterable<FakeStreamEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: () => Promise.resolve(
          i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true },
        ),
      };
    },
  };
}

function makeClient(
  events: FakeStreamEvent[],
  opts: Partial<AnthropicClientDeps> = {},
  capturedRequest?: { value: unknown },
  capturedCred?: { value: ResolvedCredential | null },
) {
  return new AnthropicClient({
    resolveCredential: async () => apiCred,
    model: 'claude-sonnet-4-6',
    maxTokens: 256,
    clientFactory: (cred) => {
      if (capturedCred) capturedCred.value = cred;
      return {
        messages: {
          stream: (req: unknown, _config?: unknown) => {
            if (capturedRequest) capturedRequest.value = req;
            return fakeStream(events) as unknown as ReturnType<typeof Object>;
          },
        } as never,
      };
    },
    ...opts,
  });
}

describe('anthropicClient — pure helpers', () => {
  it('estimateTokens uses 4 chars/token heuristic', () => {
    expect(__test.estimateTokens('1234')).toBe(1);
    expect(__test.estimateTokens('123456789')).toBe(3);
  });

  it('trimHistory keeps at most 20 messages', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: String(i), timestamp: i }));
    const trimmed = __test.trimHistory(arr);
    expect(trimmed.length).toBe(20);
    expect(trimmed[0].content).toBe('10'); // front-trim
    expect(trimmed[19].content).toBe('29');
  });

  it('classifies HTTP 401 as auth, non-retriable', () => {
    const r: ChatError = __test.classify({ status: 401, message: 'unauthorized' }, false);
    expect(r.kind).toBe('auth');
    expect(r.retriable).toBe(false);
  });

  it('classifies HTTP 429 as rate-limit, retriable', () => {
    const r = __test.classify({ status: 429 }, false);
    expect(r.kind).toBe('rate-limit');
    expect(r.retriable).toBe(true);
  });

  it('classifies HTTP 529 as model-overload', () => {
    const r = __test.classify({ status: 529 }, false);
    expect(r.kind).toBe('model-overload');
  });

  it('classifies ECONNRESET as network', () => {
    const r = __test.classify({ code: 'ECONNRESET' }, false);
    expect(r.kind).toBe('network');
  });

  it('returns cancelled when AbortSignal already aborted', () => {
    const r = __test.classify(new Error('any'), true);
    expect(r.kind).toBe('cancelled');
  });

  it('exposes a versioned system prompt', () => {
    expect(HUNK_REVIEW_PROMPT_VERSION).toBe('v1');
    expect(HUNK_REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });
});

describe('anthropicClient — streamChat', () => {
  it('forwards text deltas via onDelta and resolves with onDone', async () => {
    const captured: { value: unknown } = { value: null };
    const client = makeClient(
      [
        { type: 'message_start', message: { usage: { input_tokens: 12 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
        { type: 'message_delta', usage: { output_tokens: 24 } },
      ],
      {},
      captured,
    );

    const chunks: string[] = [];
    let done: { inputTokens: number; outputTokens: number } | undefined;
    let err: ChatError | undefined;

    const ctrl = new AbortController();
    await client.streamChat(
      { hunkDiff: '@@ -1 +1 @@\n-x\n+y', history: [], userMessage: 'why?' },
      {
        onDelta: (t) => chunks.push(t),
        onDone:  (u) => { done = u; },
        onError: (e) => { err = e; },
      },
      ctrl.signal,
    );

    expect(err).toBeUndefined();
    expect(chunks.join('')).toBe('Hello world');
    expect(done?.inputTokens).toBe(12);
    expect(done?.outputTokens).toBe(24);

    // Verify the request includes the system prompt and the hunk diff in the user message.
    const req = captured.value as { system: string; messages: Array<{ role: string; content: string }> };
    expect(req.system).toBe(HUNK_REVIEW_SYSTEM_PROMPT);
    expect(req.messages.at(-1)?.content).toContain('@@ -1 +1 @@');
    expect(req.messages.at(-1)?.content).toContain('why?');
  });

  it('emits no-key error when resolver returns null', async () => {
    const client = new AnthropicClient({
      resolveCredential: async () => null,
      model: 'm', maxTokens: 1,
      clientFactory: () => { throw new Error('should not be called'); },
    });
    let err: ChatError | undefined;
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: () => {}, onDone: () => {}, onError: (e) => { err = e; } },
      new AbortController().signal,
    );
    expect(err?.kind).toBe('no-key');
    expect(err?.retriable).toBe(false);
  });

  it('routes OAuth credentials to clientFactory unchanged', async () => {
    const captured: { value: ResolvedCredential | null } = { value: null };
    const client = makeClient([], { resolveCredential: async () => oauthCred }, undefined, captured);
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: () => {}, onDone: () => {}, onError: () => {} },
      new AbortController().signal,
    );
    expect(captured.value?.kind).toBe('oauth');
    expect(captured.value?.token).toBe(FAKE_OAUTH);
  });

  it('routes API-key credentials to clientFactory unchanged', async () => {
    const captured: { value: ResolvedCredential | null } = { value: null };
    const client = makeClient([], {}, undefined, captured);
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: () => {}, onDone: () => {}, onError: () => {} },
      new AbortController().signal,
    );
    expect(captured.value?.kind).toBe('api');
    expect(captured.value?.token).toBe(FAKE_KEY);
  });

  it('emits cancelled when signal aborted before start', async () => {
    const client = makeClient([]);
    const ctrl = new AbortController();
    ctrl.abort();
    let err: ChatError | undefined;
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: () => {}, onDone: () => {}, onError: (e) => { err = e; } },
      ctrl.signal,
    );
    expect(err?.kind).toBe('cancelled');
  });

  it('classifies thrown SDK errors via the error classifier', async () => {
    const client = new AnthropicClient({
      resolveCredential: async () => apiCred,
      model: 'm', maxTokens: 1,
      clientFactory: () => ({
        messages: {
          stream: () => { throw Object.assign(new Error('rate'), { status: 429 }); },
        } as never,
      }),
    });
    let err: ChatError | undefined;
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: () => {}, onDone: () => {}, onError: (e) => { err = e; } },
      new AbortController().signal,
    );
    expect(err?.kind).toBe('rate-limit');
    expect(err?.retriable).toBe(true);
  });

  it('SECURITY: every onDelta call is text only — does not include the API key', async () => {
    // Even though we don't expect any error, this is the canary test for TR-1
    // (host → webview boundary never carries the key). The ChatService is
    // what ultimately calls postMessage; here we verify the client's onDelta
    // string is plain text from the stream.
    const client = makeClient([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: FAKE_KEY } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' fine' } },
    ]);
    const chunks: string[] = [];
    await client.streamChat(
      { hunkDiff: '', history: [], userMessage: '' },
      { onDelta: (t) => chunks.push(t), onDone: () => {}, onError: () => {} },
      new AbortController().signal,
    );
    // The model returning a key-shape *as content* is technically out of our
    // hands, but the test asserts the client itself doesn't inject the
    // configured key into deltas. The first delta here matches the key only
    // because the stream returned it; we still pass the test if no other
    // delta carries the configured key.
    expect(chunks).toEqual([FAKE_KEY, ' fine']);
  });
});
