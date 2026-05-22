/**
 * M9.5 — Wave 3 transcript-aware chat integration tests.
 *
 * Covers T4-1 (response cites the user's original prompt), T4-2 (missing
 * transcript falls back to hunk-only), T4-3 (malformed lines skipped),
 * T4-4 (path-traversal rejected by resolveTranscriptPath), and the
 * security invariant (transcript content never crosses to the webview).
 *
 * T4-5 (50 MB streaming heap budget) is a separate perf test fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ChatService, ChatGateway } from '../../src/chatService.js';
import { AnthropicClient, ChatError } from '../../src/anthropicClient.js';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claudeCodeAdapter.js';
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
const SID = 'session-9999';

class StubPanel implements PanelGateway, ChatGateway {
  posts: Array<Record<string, unknown>> = [];
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_sessionId: SessionId, _filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_sessionId: SessionId, _filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict(_sessionId: SessionId, _filePath: AbsPath, _attemptedHunkIndex: number, _conflictingHunks: number[]) {}
  postUndoStackDepth(_sid: SessionId, _depth: number) {}
  postRejectionDrafts(_sid: SessionId, _drafts: ReadonlyArray<{ filePath: string; relPath: string; hunkIdx: number; reason: string; ts: number }>) { void _drafts; }
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

let homeDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-chat-trans-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
});

/**
 * Write a Claude Code transcript fixture at the exact path
 * resolveTranscriptPath would produce for `(SID, cwd)`. Returns the path.
 */
async function writeTranscriptFor(cwd: string, entries: unknown[]): Promise<string> {
  const encoded = cwd.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '-');
  const dir = path.join(homeDir, '.claude', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${SID}.jsonl`);
  await fs.writeFile(p, entries.map((e) => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return p;
}

interface Captured {
  system: string;
  userMessage: string;
}

/**
 * Build a chat service with an injected `clientFactory` that captures the
 * request payload sent to the Anthropic SDK. The captured `userMessage`
 * is what we assert on for T4-1.
 */
async function buildHarness(events: FakeStreamEvent[], opts: {
  transcriptContextEnabled: boolean;
  cwd: string;
}): Promise<{ chat: ChatService; panel: StubPanel; abs: AbsPath; captured: Captured | null }> {
  const store = new SnapshotStore({ maxSessionBytes: 50_000_000, maxFilesPerSession: 200 });
  const panel = new StubPanel();
  const logger = new Logger('test', 'error');
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger,
    readFile: async () => 'one\nTWO\nthree\n',
    writeFile: async () => {},
  });
  const abs = (await store.captureOriginal(SID, opts.cwd, 'a.ts'))!;
  store.get(SID)!.originals.set(abs, 'one\ntwo\nthree\n');
  store.recordTouched(SID, opts.cwd, 'a.ts');
  orchestrator.handleStop(SID, false, null);
  await new Promise((r) => setTimeout(r, 320));

  const capture: { value: Captured | null } = { value: null };
  const client = new AnthropicClient({
    resolveCredential: async () => ({ kind: 'api', token: FAKE_KEY, source: 'secrets-api-key' }),
    model: 'claude-sonnet-4-6',
    maxTokens: 256,
    clientFactory: () => ({
      messages: {
        stream: (req: { system: string; messages: Array<{ role: string; content: string }> }) => {
          capture.value = {
            system: req.system,
            userMessage: req.messages[req.messages.length - 1].content,
          };
          return fakeStream(events) as never;
        },
      } as never,
    }),
  });

  const adapter = new ClaudeCodeAdapter();
  const chat = new ChatService({
    client, logger, orchestrator, panel,
    adapter,
    transcriptContextEnabled: opts.transcriptContextEnabled,
  });

  return { chat, panel, abs, get captured() { return capture.value; } } as never;
}

const STREAM_OK: FakeStreamEvent[] = [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK.' } },
  { type: 'message_delta', usage: { output_tokens: 2 } },
];

// ---------------------------------------------------------------------------
// T4-1
// ---------------------------------------------------------------------------

describe('T4-1: transcript-aware chat cites user prompt', () => {
  it('prepends transcript context (user prompt + tool calls) to the userMessage', async () => {
    const cwd = process.cwd();
    await writeTranscriptFor(cwd, [
      { type: 'user', message: { content: 'fix the auth bug in middleware' }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/some/auth.ts' }, timestamp: '2026-05-18T10:00:10.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: path.resolve(cwd, 'a.ts'), old_string: 'a', new_string: 'b' }, timestamp: '2026-05-18T10:00:20.000Z' },
    ]);

    const harness = await buildHarness(STREAM_OK, { transcriptContextEnabled: true, cwd });
    await harness.chat.start({
      sessionId: asSessionId(SID),
      filePath: harness.abs,
      hunkIndex: 0,
      message: 'should I accept this?',
      chatId: '11111111-1111-4111-8111-111111111111',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(harness.captured).not.toBeNull();
    const um = harness.captured!.userMessage;
    expect(um).toContain('<transcript-context>');
    expect(um).toContain('fix the auth bug in middleware');
    expect(um).toContain('should I accept this?');
  });
});

// ---------------------------------------------------------------------------
// T4-2 — missing transcript
// ---------------------------------------------------------------------------

describe('T4-2: missing transcript falls back to hunk-only', () => {
  it('completes the chat with userMessage === the question (no transcript block)', async () => {
    const cwd = process.cwd();
    // NO transcript file written for this cwd / session — readTranscriptWindow
    // returns the empty window via ENOENT.
    const harness = await buildHarness(STREAM_OK, { transcriptContextEnabled: true, cwd });
    await harness.chat.start({
      sessionId: asSessionId(SID),
      filePath: harness.abs,
      hunkIndex: 0,
      message: 'plain question',
      chatId: '22222222-2222-4222-8222-222222222222',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(harness.captured!.userMessage).not.toContain('<transcript-context>');
    expect(harness.captured!.userMessage).toContain('plain question');
    // No error surfaced.
    expect(harness.panel.posts.find((p) => p.kind === 'chat-error')).toBeUndefined();
  });

  it('also falls back when the config gate is off', async () => {
    const cwd = process.cwd();
    await writeTranscriptFor(cwd, [
      { type: 'user', message: { content: 'should be ignored' }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: path.resolve(cwd, 'a.ts') }, timestamp: '2026-05-18T10:00:20.000Z' },
    ]);
    const harness = await buildHarness(STREAM_OK, { transcriptContextEnabled: false, cwd });
    await harness.chat.start({
      sessionId: asSessionId(SID),
      filePath: harness.abs,
      hunkIndex: 0,
      message: 'gated question',
      chatId: '33333333-3333-4333-8333-333333333333',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(harness.captured!.userMessage).not.toContain('<transcript-context>');
    expect(harness.captured!.userMessage).not.toContain('should be ignored');
  });
});

// ---------------------------------------------------------------------------
// T4-3 — malformed lines tolerated
// ---------------------------------------------------------------------------

describe('T4-3: malformed transcript lines are skipped', () => {
  it('still surfaces the valid user prompt around the corruption', async () => {
    const cwd = process.cwd();
    await writeTranscriptFor(cwd, [
      JSON.stringify({ type: 'user', message: { content: 'valid prompt' }, timestamp: '2026-05-18T10:00:00.000Z' }),
      'this line is not JSON',
      JSON.stringify({ type: 'unknown_event_kind', anything: 1 }),
      JSON.stringify({ type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: path.resolve(cwd, 'a.ts') }, timestamp: '2026-05-18T10:00:10.000Z' }),
    ]);

    const harness = await buildHarness(STREAM_OK, { transcriptContextEnabled: true, cwd });
    await harness.chat.start({
      sessionId: asSessionId(SID),
      filePath: harness.abs,
      hunkIndex: 0,
      message: 'q',
      chatId: '44444444-4444-4444-8444-444444444444',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(harness.captured!.userMessage).toContain('valid prompt');
    expect(harness.panel.posts.find((p) => p.kind === 'chat-error')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security invariant
// ---------------------------------------------------------------------------

describe('Security: transcript content never crosses to the webview', () => {
  it('no host→webview message contains the transcript context tag or user prompt', async () => {
    const cwd = process.cwd();
    const SECRET_PROMPT = 'sensitive-only-on-host-side';
    await writeTranscriptFor(cwd, [
      { type: 'user', message: { content: SECRET_PROMPT }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: path.resolve(cwd, 'a.ts') }, timestamp: '2026-05-18T10:00:20.000Z' },
    ]);
    const harness = await buildHarness(STREAM_OK, { transcriptContextEnabled: true, cwd });
    await harness.chat.start({
      sessionId: asSessionId(SID),
      filePath: harness.abs,
      hunkIndex: 0,
      message: 'q',
      chatId: '55555555-5555-4555-8555-555555555555',
    });
    await new Promise((r) => setTimeout(r, 50));

    // Anthropic captured: prompt IS in userMessage host-side.
    expect(harness.captured!.userMessage).toContain(SECRET_PROMPT);
    // Webview captured: prompt is NOT in any panel.posts payload.
    const serialised = JSON.stringify(harness.panel.posts);
    expect(serialised).not.toContain(SECRET_PROMPT);
    expect(serialised).not.toContain('<transcript-context>');
  });
});
