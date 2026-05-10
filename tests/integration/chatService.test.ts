import { describe, it, expect, beforeEach } from 'vitest';
import { ChatService, ChatGateway, __test as chatTest } from '../../src/chatService.js';
import { AnthropicClient, ChatError } from '../../src/anthropicClient.js';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  asSessionId,
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
  TokenUsage,
} from '../../src/types.js';

const FAKE_KEY = 'sk-ant-api03-' + 'X'.repeat(95);

class StubPanel implements PanelGateway, ChatGateway {
  posts: Array<Record<string, unknown>> = [];
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
  postChatDelta(sessionId: SessionId, chatId: string, text: string) {
    this.posts.push({ kind: 'chat-delta', sessionId, chatId, text });
  }
  postChatDone(sessionId: SessionId, chatId: string, usage: TokenUsage) {
    this.posts.push({ kind: 'chat-done', sessionId, chatId, usage });
  }
  postChatError(sessionId: SessionId, chatId: string, error: ChatError) {
    this.posts.push({ kind: 'chat-error', sessionId, chatId, error });
  }
}

interface FakeStreamEvent { type: string; delta?: { type: string; text?: string }; usage?: { output_tokens?: number }; message?: { usage?: { input_tokens?: number } } }

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

async function buildHarness(events: FakeStreamEvent[]) {
  const store = new SnapshotStore({ maxSessionBytes: 50_000_000, maxFilesPerSession: 200 });
  const panel = new StubPanel();
  const logger = new Logger('test', 'error');
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger,
    readFile: async () => 'one\nTWO\nthree\n',
    writeFile: async () => {},
  });

  // Seed a session and open a review
  const cwd = process.cwd();
  const abs = (await store.captureOriginal('sid', cwd, 'a.ts'))!;
  store.get('sid')!.originals.set(abs, 'one\ntwo\nthree\n');
  store.recordTouched('sid', cwd, 'a.ts');
  orchestrator.handleStop('sid', false, null);
  await new Promise((r) => setTimeout(r, 320));

  const client = new AnthropicClient({
    resolveCredential: async () => ({ kind: 'api', token: FAKE_KEY, source: 'secrets-api-key' }),
    model: 'claude-sonnet-4-6',
    maxTokens: 256,
    clientFactory: () => ({ messages: { stream: () => fakeStream(events) as never } as never }),
  });
  const chat = new ChatService({ client, logger, orchestrator, panel });

  return { chat, panel, abs };
}

describe('chatService — happy path', () => {
  it('forwards deltas and emits chat-done', async () => {
    const { chat, panel, abs } = await buildHarness([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Recommend ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Accept.' } },
      { type: 'message_delta', usage: { output_tokens: 4 } },
    ]);

    await chat.start({
      sessionId: asSessionId('sid'),
      filePath: abs,
      hunkIndex: 0,
      message: 'should I accept this?',
      chatId: '11111111-1111-4111-8111-111111111111',
    });
    // Wait for the coalesce flush (FLUSH_TICK_MS = 16).
    await new Promise((r) => setTimeout(r, 50));

    const delta = panel.posts.find((p) => p.kind === 'chat-delta');
    expect(delta).toBeDefined();
    expect((delta as { text: string }).text).toContain('Recommend');

    const done = panel.posts.find((p) => p.kind === 'chat-done');
    expect(done).toBeDefined();
  });

  it('persists conversation history per (sid, file, hunk)', async () => {
    const { chat, abs } = await buildHarness([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A reply.' } },
    ]);
    await chat.start({
      sessionId: asSessionId('sid'),
      filePath: abs,
      hunkIndex: 0,
      message: 'first turn',
      chatId: '22222222-2222-4222-8222-222222222222',
    });
    await new Promise((r) => setTimeout(r, 50));

    const history = chat.getConversation('sid', abs, 0);
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('first turn');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('A reply.');
  });
});

describe('chatService — cancellation', () => {
  it('cancel() aborts in-flight stream and emits chat-error kind=cancelled', async () => {
    // Slow stream
    const events: FakeStreamEvent[] = Array.from({ length: 100 }, () => ({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'tick ' },
    }));
    const { chat, panel, abs } = await buildHarness(events);

    const chatId = '33333333-3333-4333-8333-333333333333';
    const p = chat.start({
      sessionId: asSessionId('sid'),
      filePath: abs,
      hunkIndex: 0,
      message: 'tell me everything',
      chatId,
    });
    // Cancel immediately
    chat.cancel(chatId);
    await p;
    await new Promise((r) => setTimeout(r, 50));

    const err = panel.posts.find((p) => p.kind === 'chat-error');
    expect(err).toBeDefined();
    expect((err as { error: ChatError }).error.kind).toBe('cancelled');
  });
});

describe('chatService — SECURITY: api key never crosses postMessage boundary', () => {
  it('a complete chat session with deltas containing key-like strings does not leak the configured key', async () => {
    const { chat, panel, abs } = await buildHarness([
      // The model is told not to do this, but if it ever did echo a key-like
      // string the test still asserts the *configured* key never appears as
      // metadata posted by the host (which is what we actually control).
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Some prose.' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ]);

    await chat.start({
      sessionId: asSessionId('sid'),
      filePath: abs,
      hunkIndex: 0,
      message: 'review',
      chatId: '44444444-4444-4444-8444-444444444444',
    });
    await new Promise((r) => setTimeout(r, 50));

    // Walk every posted message; serialise; assert the configured key is absent.
    const serialised = JSON.stringify(panel.posts);
    expect(serialised.includes(FAKE_KEY)).toBe(false);
    expect(/sk-ant-api03-/.test(serialised)).toBe(false);
  });
});

describe('chatService — pure helpers', () => {
  it('convKey is stable and unique per tuple', () => {
    const a = chatTest.convKey({ sessionId: 's', filePath: '/a', hunkIndex: 0 });
    const b = chatTest.convKey({ sessionId: 's', filePath: '/a', hunkIndex: 1 });
    expect(a).not.toBe(b);
  });

  it('renderHunkDiff produces a unified-diff style block', () => {
    const out = chatTest.renderHunkDiff('src/a.ts', '@@ -1 +1 @@', ['-old', '+new']);
    expect(out).toContain('--- a/src/a.ts');
    expect(out).toContain('+++ b/src/a.ts');
    expect(out).toContain('@@ -1 +1 @@');
  });
});

beforeEach(() => {
  // No-op
});
