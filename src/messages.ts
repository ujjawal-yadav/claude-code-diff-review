import { z } from 'zod';

/**
 * Wire schemas (TRD §7).
 *
 * Two distinct surfaces are validated here:
 *   1. Hook payloads from Claude Code (untrusted, schema-tolerant via .passthrough()).
 *   2. Webview ↔ Extension Host messages (untrusted in both directions; strict).
 *
 * Both webview and extension import from this module — keep it free of
 * Node- or DOM-only references.
 */

// --------------------------------------------------------------------------
// Hook payloads (Claude Code → extension host)
// --------------------------------------------------------------------------

export const PreToolUsePayload = z
  .object({
    session_id: z.string().min(1),
    tool_name: z.string(),
    tool_input: z
      .object({
        file_path: z.string().min(1),
        content: z.string().optional(),
      })
      .passthrough(),
    cwd: z.string().min(1),
  })
  .passthrough();
export type PreToolUsePayload = z.infer<typeof PreToolUsePayload>;

export const PostToolUsePayload = z
  .object({
    session_id: z.string().min(1),
    tool_name: z.string(),
    tool_input: z
      .object({
        file_path: z.string().min(1),
      })
      .passthrough(),
    tool_result: z.object({ success: z.boolean() }).passthrough().optional(),
    cwd: z.string().min(1),
  })
  .passthrough();
export type PostToolUsePayload = z.infer<typeof PostToolUsePayload>;

export const StopPayload = z
  .object({
    session_id: z.string().min(1),
    stop_hook_active: z.boolean().optional().default(false),
    last_assistant_message: z.string().nullable().optional(),
  })
  .passthrough();
export type StopPayload = z.infer<typeof StopPayload>;

// --------------------------------------------------------------------------
// Webview ↔ Host (TRD §7.3)
// --------------------------------------------------------------------------

export const WebviewToHost = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('accept-hunk'), filePath: z.string(), hunkIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal('reject-hunk'), filePath: z.string(), hunkIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal('accept-file'), filePath: z.string() }),
  z.object({ type: z.literal('reject-file'), filePath: z.string() }),
  z.object({ type: z.literal('accept-all') }),
  z.object({ type: z.literal('reject-all') }),
  z.object({
    type: z.literal('chat-message'),
    filePath: z.string(),
    hunkIndex: z.number().int().nonnegative(),
    message: z.string(),
    chatId: z.string().uuid(),
  }),
  z.object({ type: z.literal('chat-cancel'), chatId: z.string().uuid() }),
  z.object({ type: z.literal('set-view-type'), viewType: z.enum(['split', 'unified']) }),
  z.object({ type: z.literal('set-api-key') }),
  z.object({ type: z.literal('set-oauth-token') }),
  z.object({ type: z.literal('use-claude-code-auth') }),
  z.object({ type: z.literal('revert-file-to-snapshot'), filePath: z.string() }),
  z.object({ type: z.literal('log'), level: z.enum(['debug', 'info', 'warn']), msg: z.string() }),
]);
export type WebviewToHost = z.infer<typeof WebviewToHost>;

// --------------------------------------------------------------------------
// Host → Webview messages
// --------------------------------------------------------------------------
//
// These are NOT validated at runtime by the webview (we trust our own host),
// but the TS types here are the authoritative shape and must be kept in
// sync between the two bundles.

import type {
  SessionReview,
  FileReview,
  HunkStatus,
  TokenUsage,
  SessionMetrics,
} from './types.js';

export type HostToWebview =
  | { type: 'init'; session: SessionReview; viewType: 'split' | 'unified' }
  | { type: 'hunk-applied'; filePath: string; hunkIndex: number; action: 'accept' | 'reject' | HunkStatus }
  | { type: 'file-updated'; filePath: string; file: FileReview }
  | { type: 'session-completed'; sessionId: string; metrics: SessionMetrics }
  | { type: 'chat-delta'; chatId: string; text: string }
  | { type: 'chat-done'; chatId: string; usage: TokenUsage }
  | { type: 'chat-error'; chatId: string; error: { kind: string; message: string; retriable: boolean } }
  | { type: 'warning'; filePath?: string; kind: string; message: string }
  | { type: 'view-type'; viewType: 'split' | 'unified' };

// --------------------------------------------------------------------------
// Validation helpers
// --------------------------------------------------------------------------

/** Validate a webview-originating message; returns null on schema failure. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | null {
  const result = WebviewToHost.safeParse(raw);
  return result.success ? result.data : null;
}
