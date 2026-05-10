import { AnthropicClient, ChatError } from './anthropicClient.js';
import { Logger } from './logger.js';
import { ReviewOrchestrator } from './reviewOrchestrator.js';
import { ConversationEntry, SessionId, TokenUsage } from './types.js';

/**
 * Owns chat state for the review panels (TRD §11).
 *
 *  - Conversation history per `(sessionId, filePath, hunkIndex)`
 *  - In-flight `AbortController` per `chatId`
 *  - Coalesced delta forwarding via `setImmediate` to avoid IPC saturation
 *
 * The service has no DOM / VS Code surface; it talks to a `ChatGateway`
 * (implemented by `ReviewPanelManager`) for posting deltas back to the
 * webview, and to the orchestrator for resolving the hunk diff.
 *
 * Cancellation
 * ------------
 * `chat-cancel` aborts the controller. Closing the webview also aborts
 * (the panel hooks `onDidDispose`). The Anthropic stream throws / unwinds
 * cleanly and a `chat-error { kind: 'cancelled' }` is posted.
 */

export interface ChatGateway {
  postChatDelta(sessionId: SessionId, chatId: string, text: string): void;
  postChatDone(sessionId: SessionId, chatId: string, usage: TokenUsage): void;
  postChatError(sessionId: SessionId, chatId: string, error: ChatError): void;
}

export interface ChatServiceDeps {
  client: AnthropicClient;
  logger: Logger;
  orchestrator: ReviewOrchestrator;
  panel: ChatGateway;
}

export interface ChatStartArgs {
  sessionId: SessionId;
  filePath: string;
  hunkIndex: number;
  message: string;
  chatId: string;
}

interface ConvKey {
  sessionId: string;
  filePath: string;
  hunkIndex: number;
}

const FLUSH_TICK_MS = 16; // ~60 fps

export class ChatService {
  private readonly conversations = new Map<string, ConversationEntry[]>();
  private readonly inflight = new Map<string, AbortController>();
  /** Buffered deltas per chatId, flushed on next setImmediate tick. */
  private readonly buffers = new Map<string, { text: string; flushScheduled: boolean }>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** Begin a streaming chat. Returns a promise resolving once the stream finishes. */
  async start(args: ChatStartArgs): Promise<void> {
    const review = this.deps.orchestrator.getSession(args.sessionId);
    if (!review) {
      this.deps.panel.postChatError(args.sessionId, args.chatId, {
        kind: 'unknown', message: 'Session no longer active.', retriable: false,
      });
      return;
    }
    // O(1) lookup via the orchestrator's denormalised file index.
    const located = this.deps.orchestrator.findFile(args.filePath);
    const file = located && located.session.sessionId === args.sessionId ? located.file : undefined;
    const hunk = file?.hunks[args.hunkIndex];
    if (!file || !hunk) {
      this.deps.panel.postChatError(args.sessionId, args.chatId, {
        kind: 'unknown', message: 'Hunk no longer available.', retriable: false,
      });
      return;
    }

    const key = convKey({ sessionId: args.sessionId, filePath: args.filePath, hunkIndex: args.hunkIndex });
    const history = this.conversations.get(key) ?? [];

    const controller = new AbortController();
    this.inflight.set(args.chatId, controller);

    const hunkDiff = renderHunkDiff(file.relPath, hunk.header, hunk.lines);

    const sessionId = args.sessionId; // typed
    const chatId = args.chatId;

    let assistantText = '';
    const onDelta = (text: string) => {
      assistantText += text;
      this.bufferDelta(sessionId, chatId, text);
    };
    const onDone = (usage: TokenUsage) => {
      this.flushBuffer(sessionId, chatId);
      const updated: ConversationEntry[] = [
        ...history,
        { role: 'user',      content: args.message,  timestamp: Date.now() },
        { role: 'assistant', content: assistantText, timestamp: Date.now() },
      ];
      this.conversations.set(key, updated);
      this.inflight.delete(chatId);
      this.deps.panel.postChatDone(sessionId, chatId, usage);
      this.deps.logger.debug('chat', 'done', {
        sid: sessionId,
        chatId,
        in: usage.inputTokens,
        out: usage.outputTokens,
      });
    };
    const onError = (err: ChatError) => {
      this.flushBuffer(sessionId, chatId);
      this.inflight.delete(chatId);
      this.deps.panel.postChatError(sessionId, chatId, err);
      this.deps.logger.warn('chat', 'error', { sid: sessionId, chatId, kind: err.kind });
    };

    await this.deps.client.streamChat(
      { hunkDiff, history, userMessage: args.message },
      { onDelta, onDone, onError },
      controller.signal,
    );
  }

  cancel(chatId: string): void {
    const c = this.inflight.get(chatId);
    if (!c) return;
    c.abort();
    this.inflight.delete(chatId);
  }

  /** Cancel every stream associated with a session (panel close). */
  cancelSession(sessionId: SessionId): void {
    void sessionId;
    // We don't index streams by session today; the AbortControllers all live in
    // `inflight`. Cancel them all — only one panel runs chats per session.
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  /** Test/inspection helper. */
  getConversation(sessionId: string, filePath: string, hunkIndex: number): ConversationEntry[] {
    return this.conversations.get(convKey({ sessionId, filePath, hunkIndex })) ?? [];
  }

  // -- internals ---------------------------------------------------------------

  private bufferDelta(sessionId: SessionId, chatId: string, text: string): void {
    const buf = this.buffers.get(chatId) ?? { text: '', flushScheduled: false };
    buf.text += text;
    this.buffers.set(chatId, buf);
    if (buf.flushScheduled) return;
    buf.flushScheduled = true;
    setTimeout(() => this.flushBuffer(sessionId, chatId), FLUSH_TICK_MS);
  }

  private flushBuffer(sessionId: SessionId, chatId: string): void {
    const buf = this.buffers.get(chatId);
    if (!buf) return;
    if (buf.text.length === 0) {
      this.buffers.delete(chatId);
      return;
    }
    const text = buf.text;
    buf.text = '';
    buf.flushScheduled = false;
    this.deps.panel.postChatDelta(sessionId, chatId, text);
  }
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function convKey(k: ConvKey): string {
  return `${k.sessionId}::${k.filePath}::${k.hunkIndex}`;
}

function renderHunkDiff(relPath: string, header: string, lines: string[]): string {
  return [`--- a/${relPath}`, `+++ b/${relPath}`, header, ...lines].join('\n');
}

/** Exported for tests. */
export const __test = { convKey, renderHunkDiff };
