import type { AgentAdapter } from './adapters/agentAdapter.js';
import { AnthropicClient, ChatError } from './anthropicClient.js';
import { Logger } from './logger.js';
import { ReviewOrchestrator } from './reviewOrchestrator.js';
import {
  readTranscriptWindow,
  type TranscriptWindow,
  type ToolCallSummary,
} from './transcript/transcriptReader.js';
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
  /**
   * M9.5 — adapter for resolving the agent's session transcript path.
   * Optional so existing tests can construct ChatService without wiring it;
   * when absent, transcript injection is silently skipped.
   */
  adapter?: AgentAdapter;
  /**
   * M9.5 — gate for transcript context injection (config:
   * `claudeReview.chat.transcriptContext`). Defaults to false when absent
   * so test harnesses without an adapter never attempt transcript reads.
   */
  transcriptContextEnabled?: boolean;
}

export interface ChatStartArgs {
  sessionId: SessionId;
  filePath: string;
  hunkIndex: number;
  message: string;
  chatId: string;
}

export interface ChatBatchFeedbackArgs {
  sessionId: SessionId;
  /** Anchor hunk (typically the most recently rejected). */
  filePath: string;
  hunkIndex: number;
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

    // M9.5: prepend transcript context to the user message when the config
    // is enabled, an adapter is wired, and the transcript resolves. Any
    // failure silently falls back to hunk-only — never blocks the chat.
    let userMessage = args.message;
    if (this.deps.transcriptContextEnabled && this.deps.adapter) {
      try {
        const transcriptPath = this.deps.adapter.resolveTranscriptPath(args.sessionId, review.cwd);
        if (transcriptPath) {
          const window = await readTranscriptWindow(transcriptPath, {
            filePath: args.filePath,
            logger: this.deps.logger,
          });
          userMessage = composeUserMessageWithTranscript(window, args.message);
        }
      } catch (err) {
        this.deps.logger.debug('chat', 'transcript.read.failed', { err: String(err) });
        // fall through with original args.message
      }
    }

    await this.deps.client.streamChat(
      { hunkDiff, history, userMessage },
      { onDelta, onDone, onError },
      controller.signal,
    );
  }

  /**
   * v0.4 (A5 — reject-with-feedback). Bundle every pending rejection draft
   * into one consolidated chat message + send. Reuses the streaming
   * infrastructure of `start()` so deltas reach the webview via the same
   * channel. Drafts are cleared on the orchestrator side AFTER the prompt
   * is composed (so a race with another add doesn't lose entries).
   *
   * Anchor: the chat is associated with `(filePath, hunkIndex)` from args
   * — typically the hunk the user is parked on. This is just for
   * conversation-history bucketing; the prompt content covers all drafts.
   */
  async startBatchFeedback(args: ChatBatchFeedbackArgs): Promise<void> {
    const review = this.deps.orchestrator.getSession(args.sessionId);
    if (!review) {
      this.deps.panel.postChatError(args.sessionId, args.chatId, {
        kind: 'unknown', message: 'Session no longer active.', retriable: false,
      });
      return;
    }
    const drafts = this.deps.orchestrator.getRejectionDrafts(args.sessionId);
    if (drafts.length === 0) {
      this.deps.panel.postChatError(args.sessionId, args.chatId, {
        kind: 'unknown', message: 'No drafts to send.', retriable: false,
      });
      return;
    }
    const located = this.deps.orchestrator.findFile(args.filePath);
    const file = located && located.session.sessionId === args.sessionId ? located.file : undefined;
    const hunk = file?.hunks[args.hunkIndex];
    if (!file || !hunk) {
      this.deps.panel.postChatError(args.sessionId, args.chatId, {
        kind: 'unknown', message: 'Anchor hunk no longer available.', retriable: false,
      });
      return;
    }

    const key = convKey({ sessionId: args.sessionId, filePath: args.filePath, hunkIndex: args.hunkIndex });
    const history = this.conversations.get(key) ?? [];

    const controller = new AbortController();
    this.inflight.set(args.chatId, controller);

    const hunkDiff = renderHunkDiff(file.relPath, hunk.header, hunk.lines);
    const userMessage = composeBatchFeedbackMessage(drafts);

    const sessionId = args.sessionId;
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
        { role: 'user',      content: userMessage,    timestamp: Date.now() },
        { role: 'assistant', content: assistantText, timestamp: Date.now() },
      ];
      this.conversations.set(key, updated);
      this.inflight.delete(chatId);
      this.deps.panel.postChatDone(sessionId, chatId, usage);
      // Clear drafts AFTER successful send. Failures leave the queue intact
      // so the user can retry.
      this.deps.orchestrator.clearRejectionDrafts(sessionId);
      this.deps.logger.debug('chat', 'batch-feedback.done', {
        sid: sessionId, chatId, drafts: drafts.length,
      });
    };
    const onError = (err: ChatError) => {
      this.flushBuffer(sessionId, chatId);
      this.inflight.delete(chatId);
      this.deps.panel.postChatError(sessionId, chatId, err);
      this.deps.logger.warn('chat', 'batch-feedback.error', {
        sid: sessionId, chatId, kind: err.kind,
      });
    };

    await this.deps.client.streamChat(
      { hunkDiff, history, userMessage },
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

/**
 * M9.5: compose the chat user message with a transcript context block.
 * Pure function — no I/O. Returns the original question unchanged when the
 * window carries no useful context (no user prompt, no surrounding tool
 * calls, no assistant thinking) — keeps the prompt clean for hunk-only
 * sessions where the transcript exists but doesn't reference this file.
 */
export function composeUserMessageWithTranscript(
  window: TranscriptWindow,
  userQuestion: string,
): string {
  const hasContext =
    window.userPrompt !== null ||
    window.precedingToolCalls.length > 0 ||
    window.followingToolCalls.length > 0 ||
    window.assistantThinking !== null;
  if (!hasContext) return userQuestion;

  const sections: string[] = [];
  sections.push('<transcript-context>');
  if (window.userPrompt) {
    sections.push('User\'s original prompt for this turn:');
    sections.push('"""');
    sections.push(window.userPrompt);
    sections.push('"""');
    sections.push('');
  }
  if (window.precedingToolCalls.length > 0) {
    sections.push('Claude\'s tool calls before this hunk:');
    sections.push(renderToolCallList(window.precedingToolCalls));
    sections.push('');
  }
  if (window.followingToolCalls.length > 0) {
    sections.push('Claude\'s tool calls after this hunk:');
    sections.push(renderToolCallList(window.followingToolCalls));
    sections.push('');
  }
  if (window.assistantThinking) {
    sections.push('Claude\'s thinking (if any):');
    sections.push('"""');
    sections.push(window.assistantThinking);
    sections.push('"""');
    sections.push('');
  }
  sections.push('</transcript-context>');
  sections.push('');
  sections.push(userQuestion);
  return sections.join('\n');
}

function renderToolCallList(calls: ToolCallSummary[]): string {
  return calls.map((c) => `- ${c.toolName}: ${c.inputSummary}`).join('\n');
}

/**
 * v0.4 (A5): compose the consolidated drafts-send prompt. Plain enumeration
 * for v0.4 (L109 in plan); LLM-driven clustering deferred to v1.x.
 */
export function composeBatchFeedbackMessage(
  drafts: ReadonlyArray<{ relPath: string; hunkIdx: number; reason: string }>,
): string {
  const lines: string[] = [];
  lines.push(`I rejected ${drafts.length} hunk${drafts.length === 1 ? '' : 's'} in this turn. Please rework with these in mind:`);
  lines.push('');
  for (const d of drafts) {
    // Single-line quoting; embedded newlines collapse to spaces so the bullet
    // remains scannable. Multi-line reasons are uncommon in practice.
    const oneLine = d.reason.replace(/\s+/g, ' ').trim();
    lines.push(`• ${d.relPath} hunk ${d.hunkIdx + 1}: "${oneLine}"`);
  }
  return lines.join('\n');
}

/** Exported for tests. */
export const __test = { convKey, renderHunkDiff };
