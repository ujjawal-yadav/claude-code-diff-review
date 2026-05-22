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
  z.object({
    /** Phase α M9.2.9: undo the most recent decision on a hunk (within
     *  the current panel session). The orchestrator inverse-toggles the
     *  hunk's set membership and flips its status back to `pending`. */
    type: z.literal('undo-hunk-decision'),
    filePath: z.string(),
    hunkIndex: z.number().int().nonnegative(),
  }),
  z.object({
    /** Option A: session-level undo. Pops the most recent action snapshot
     *  off the orchestrator's stack and restores every affected file's
     *  acceptedSet, hunk statuses, and on-disk content. Editor-style Ctrl+Z. */
    type: z.literal('undo-last-action'),
  }),
  z.object({ type: z.literal('log'), level: z.enum(['debug', 'info', 'warn']), msg: z.string() }),
  /** v0.2.1: open the history panel from the review-panel header button.
   *  Host dispatches `claudeReview.openHistory` so a single source of truth
   *  governs panel lifecycle (matches command-palette entry behaviour). */
  z.object({ type: z.literal('open-history') }),
  /**
   * v0.4 (A4 — edit-before-accept). User saved an in-place edit of a hunk's
   * after view. `editedAfter` is the raw text of the new `+` block (no
   * diff prefixes). Capped at 256 KB to prevent runaway clipboard pastes;
   * the host validates again before persisting.
   */
  z.object({
    type: z.literal('save-hunk-edit'),
    filePath: z.string(),
    hunkIndex: z.number().int().nonnegative(),
    editedAfter: z.string().max(256 * 1024),
  }),
  /**
   * v0.4 (A5 — reject-with-feedback). User typed a reason for a previously
   * rejected hunk. Reason text capped at 4 KB at the wire layer (matches
   * the transcript user-prompt budget). The host enforces that the hunk
   * is currently in `rejected` status; mismatches are dropped with a debug
   * log.
   */
  z.object({
    type: z.literal('add-rejection-reason'),
    filePath: z.string(),
    hunkIndex: z.number().int().nonnegative(),
    reason: z.string().min(1).max(4 * 1024),
  }),
  /**
   * v0.4 (A5): user clicked "Send all to Claude" in the ChatOverlay drafts
   * panel. Drafts are bundled into one consolidated chat-message via
   * ChatService.startBatchFeedback. ChatId is webview-minted so the
   * existing delta/done plumbing works unchanged.
   */
  z.object({
    type: z.literal('send-rejection-feedback'),
    chatId: z.string().uuid(),
    filePath: z.string(),
    hunkIndex: z.number().int().nonnegative(),
  }),
  /**
   * v0.4 (A8 cheap — rename grouping). Bulk decide every hunk in a
   * rename-detection group. `groupId` is the heuristic key `${old}->${new}`.
   * Host iterates the group's (filePath, hunkIndex) members and calls
   * `handleHunkAction` per entry through the same per-file mutex.
   */
  z.object({
    type: z.literal('decide-rename-group'),
    groupId: z.string(),
    action: z.enum(['accept', 'reject']),
  }),
]);
export type WebviewToHost = z.infer<typeof WebviewToHost>;

// --------------------------------------------------------------------------
// History webview ↔ Host (Phase α M9.2.8)
//
// A separate small protocol for the History panel. The history webview is
// read-mostly: list sessions, load events for a clicked session. No mutation
// in v0.2 (per-hunk undo lives on the review panel).
// --------------------------------------------------------------------------

export const HistoryWebviewToHost = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('load-session'), sessionId: z.string() }),
  z.object({ type: z.literal('log'), level: z.enum(['debug', 'info', 'warn']), msg: z.string() }),
  // β.0 (10.1.8): destructive + resume actions from the History panel.
  z.object({ type: z.literal('resume-session'), sessionId: z.string() }),
  z.object({ type: z.literal('rollback-turn'), sessionId: z.string() }),
  z.object({ type: z.literal('delete-session'), sessionId: z.string() }),
]);
export type HistoryWebviewToHost = z.infer<typeof HistoryWebviewToHost>;

export function parseHistoryWebviewMessage(raw: unknown): HistoryWebviewToHost | null {
  const r = HistoryWebviewToHost.safeParse(raw);
  return r.success ? r.data : null;
}

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
import type { HistoryEvent } from './history/historyEvents.js';
import type { SessionIndexEntry } from './history/historyTypes.js';

export type HistoryHostToWebview =
  | { type: 'init'; sessions: SessionIndexEntry[]; root: string }
  | { type: 'session-loaded'; sessionId: string; events: HistoryEvent[] }
  | { type: 'error'; message: string }
  // β.0 (10.1.8): host → webview acknowledgement so the UI can clear the
  // disabled-while-inflight state and refresh after an action lands.
  | {
      type: 'session-action-result';
      sessionId: string;
      action: 'resume' | 'rollback' | 'delete';
      ok: boolean;
      error?: string;
    };

export type HostToWebview =
  | { type: 'init'; session: SessionReview; viewType: 'split' | 'unified' }
  | { type: 'hunk-applied'; filePath: string; hunkIndex: number; action: 'accept' | 'reject' | HunkStatus }
  | { type: 'file-updated'; filePath: string; file: FileReview }
  | { type: 'session-completed'; sessionId: string; metrics: SessionMetrics }
  | { type: 'chat-delta'; chatId: string; text: string }
  | { type: 'chat-done'; chatId: string; usage: TokenUsage }
  | { type: 'chat-error'; chatId: string; error: { kind: string; message: string; retriable: boolean } }
  | { type: 'warning'; filePath?: string; kind: string; message: string }
  | { type: 'view-type'; viewType: 'split' | 'unified' }
  | {
      /**
       * Set-based reversibility (Phase α Track 6) surfaced a conflict: the
       * requested combination of accepted hunks cannot be rendered against
       * the original snapshot. The orchestrator has reverted the set change.
       * The webview should surface a banner offering "Re-accept coupled
       * hunks" (which auto-adds `coupledHunks` back to the set).
       */
      type: 'set-conflict-warning';
      filePath: string;
      attemptedHunkIndex: number;
      conflictingHunks: number[];
    }
  | {
      /** Option A: orchestrator emits this after every push/pop on the
       *  undo stack so the webview can enable/disable the ↶ Undo button. */
      type: 'undo-stack-changed';
      depth: number;
    }
  | {
      /**
       * v0.4 (A5): the orchestrator's drafts queue changed. Webview replaces
       * its local mirror with this list (full replacement is cheaper than
       * diffing for a queue with realistic max ~50 entries). Fires after
       * add, send-bundle (clear), and adoptReconstructed.
       */
      type: 'rejection-drafts';
      drafts: Array<{
        filePath: string;
        relPath: string;
        hunkIdx: number;
        reason: string;
        ts: number;
      }>;
    };

// --------------------------------------------------------------------------
// Validation helpers
// --------------------------------------------------------------------------

/** Validate a webview-originating message; returns null on schema failure. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | null {
  const result = WebviewToHost.safeParse(raw);
  return result.success ? result.data : null;
}
