import Anthropic from '@anthropic-ai/sdk';

import { ConversationEntry, TokenUsage } from './types.js';
import type { ResolvedCredential } from './credentialResolver.js';

/**
 * Anthropic streaming client wrapper (TRD §5.8).
 *
 * Trust boundary
 * --------------
 * The Anthropic API key MUST NEVER cross the host → webview boundary
 * (TRD §14.2). It is fetched per-call from `SecretManager`, used to
 * construct/refresh the SDK client, and cleared from the instance in
 * `finally` so it is garbage-collectable as soon as the stream ends.
 *
 * Error classification
 * --------------------
 * Anthropic SDK errors expose a `status` number. We map to a small set of
 * canonical kinds so the webview can render an actionable retry UX without
 * leaking implementation detail.
 *
 * Cancellation
 * ------------
 * Each call accepts an `AbortSignal`. Closing the overlay or sending
 * `chat-cancel` triggers `controller.abort()`; the stream is unwound
 * cleanly and `onError` fires with `kind: 'cancelled'`.
 */

export const HUNK_REVIEW_PROMPT_VERSION = 'v2';

export const HUNK_REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer helping a developer decide whether to accept or reject a single diff hunk produced by Claude Code.

Rules:
- Be concise, technical, and decisive.
- Focus on the hunk shown; do not speculate about code outside it.
- When asked, give a clear recommendation ("Accept", "Reject", or "Investigate further") with one short justification.
- Flag any obvious correctness, security, or performance regressions.

When transcript context is provided (the user's original prompt for this turn and Claude's surrounding tool calls), cite it specifically when answering "why did Claude do this?" questions. If no transcript is provided, answer from the hunk alone — never invent reasoning Claude didn't produce. If the transcript context is empty and the user's question would benefit from it, say so briefly.`;

export interface StreamRequest {
  hunkDiff: string;
  history: ConversationEntry[];
  userMessage: string;
  /** Override the default model. */
  model?: string;
  maxTokens?: number;
}

export interface StreamHandlers {
  onDelta(text: string): void;
  onDone(usage: TokenUsage): void;
  onError(err: ChatError): void;
}

export type ChatErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'model-overload'
  | 'network'
  | 'cancelled'
  | 'no-key'
  | 'unknown';

export interface ChatError {
  kind: ChatErrorKind;
  message: string;
  retriable: boolean;
}

export interface AnthropicClientDeps {
  /**
   * Resolves a credential per call. Returns either an OAuth token
   * (`{ kind: 'oauth' }`) for Claude Pro/Max users or an API key
   * (`{ kind: 'api' }`). `null` ⇒ chat fails with `no-key`.
   */
  resolveCredential: () => Promise<ResolvedCredential | null>;
  /** Default model id; can be overridden per-call. */
  model: string;
  /** Default max output tokens. */
  maxTokens: number;
  /**
   * Injection point for tests: builds an SDK-shaped client given the
   * resolved credential. Production wraps `new Anthropic({ ... })`.
   */
  clientFactory?: (credential: ResolvedCredential) => Pick<Anthropic, 'messages'>;
}

const TOKEN_CHARS_PER = 4; // very rough heuristic, good enough for trim decisions

export class AnthropicClient {
  constructor(private readonly deps: AnthropicClientDeps) {}

  async streamChat(req: StreamRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      handlers.onError({ kind: 'cancelled', message: 'Cancelled before start.', retriable: true });
      return;
    }

    const credential = await this.deps.resolveCredential();
    if (!credential) {
      handlers.onError({
        kind: 'no-key',
        message: 'No Claude credential found. Run `claude login` for Max-plan auth, or set an API key.',
        retriable: false,
      });
      return;
    }

    const factory = this.deps.clientFactory ?? defaultFactory;
    let client: Pick<Anthropic, 'messages'> | null = factory(credential);

    const trimmedHistory = trimHistory(req.history);

    const userText = `Here is the diff hunk under review:\n\n\`\`\`diff\n${req.hunkDiff}\n\`\`\`\n\n${req.userMessage}`;

    const messages = [
      ...trimmedHistory.map((e) => ({ role: e.role, content: e.content })),
      { role: 'user' as const, content: userText },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    const onAbort = () => {
      // The SDK wires AbortSignal through; this listener exists so we can
      // emit a deterministic 'cancelled' onError in addition to whatever
      // the underlying stream throws.
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const stream = client.messages.stream(
        {
          model: req.model ?? this.deps.model,
          max_tokens: req.maxTokens ?? this.deps.maxTokens,
          system: HUNK_REVIEW_SYSTEM_PROMPT,
          messages,
        },
        { signal },
      );

      for await (const event of stream) {
        if (signal.aborted) break;
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          handlers.onDelta(event.delta.text ?? '');
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? outputTokens;
        } else if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? inputTokens;
        }
      }

      if (signal.aborted) {
        handlers.onError({ kind: 'cancelled', message: 'Cancelled.', retriable: true });
        return;
      }

      handlers.onDone({ inputTokens, outputTokens });
    } catch (err: unknown) {
      handlers.onError(classify(err, signal.aborted));
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Drop the reference so the API key is GC-eligible promptly.
      client = null;
      void client;
    }
  }
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function defaultFactory(credential: ResolvedCredential): Pick<Anthropic, 'messages'> {
  // OAuth tokens flow through `authToken` (Bearer); API keys via `apiKey`
  // (x-api-key). The SDK accepts either; selecting the wrong one yields a
  // 401 from the API.
  if (credential.kind === 'oauth') {
    return new Anthropic({ authToken: credential.token });
  }
  return new Anthropic({ apiKey: credential.token });
}

const MAX_HISTORY_MESSAGES = 20;

export function trimHistory(history: ConversationEntry[]): ConversationEntry[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history.slice();
  // Keep the *most recent* N — front-trim to preserve current context.
  return history.slice(history.length - MAX_HISTORY_MESSAGES);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER);
}

function classify(err: unknown, aborted: boolean): ChatError {
  if (aborted) return { kind: 'cancelled', message: 'Cancelled.', retriable: true };

  if (err && typeof err === 'object') {
    const e = err as { status?: number; message?: string; name?: string; code?: string };
    if (e.name === 'AbortError') return { kind: 'cancelled', message: 'Cancelled.', retriable: true };

    const status = e.status;
    if (status === 401 || status === 403) {
      return { kind: 'auth', message: 'Authentication failed. Re-enter your API key.', retriable: false };
    }
    if (status === 429) {
      return { kind: 'rate-limit', message: 'Rate-limited. Wait a moment, then retry.', retriable: true };
    }
    if (status === 529) {
      return { kind: 'model-overload', message: 'Model overloaded. Try again shortly.', retriable: true };
    }
    if (typeof e.code === 'string' && /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(e.code)) {
      return { kind: 'network', message: 'Network error. Check your connection.', retriable: true };
    }
    return { kind: 'unknown', message: e.message ?? 'Unknown error.', retriable: true };
  }
  return { kind: 'unknown', message: String(err), retriable: true };
}

/** Exported for tests. */
export const __test = { classify, trimHistory, estimateTokens };
