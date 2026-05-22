/**
 * Content-addressed event log schema (MEMORY-DESIGN.md §4 + Phase α §3.3).
 *
 * Tolerant by design
 * ------------------
 * Readers MUST skip unknown event kinds with a debug log rather than throw.
 * That keeps the on-disk log forward-compatible across schema bumps.
 *
 * Phase α additions
 * -----------------
 * Every event carries `agentId` so a multi-agent session (Claude Code +
 * OpenCode) can be reconstructed from a single log. Optional `subagentId`
 * lets us attribute hunk decisions to sub-agents (Task tool sub-agents
 * share the parent `session_id` in Claude Code's hook payload, so we
 * recover the attribution from the JSONL transcript in Track 4/5).
 */

import { z } from 'zod';

export const EVENT_SCHEMA_VERSION = 1 as const;

// Single source of truth lives in `src/types.ts`. Re-exported here for
// back-compat with existing imports (e.g., `historyTypes.ts`).
import type { AgentId } from '../types.js';
export type { AgentId };

export interface BaseEvent {
  v: typeof EVENT_SCHEMA_VERSION;
  ts: number;          // ms epoch, monotonic per session
  eventId: number;     // 0-indexed, monotonic, equals line index
  turnId: string;      // UUID v4, groups events by turn
  agentId: AgentId;
  /** Sub-agent attribution (Track 5) — null when none/unknown. */
  subagentId?: string;
}

export interface TurnStartedEvent extends BaseEvent {
  kind: 'turn-started';
  files: Array<{
    /** Workspace-relative, forward-slash. */
    path: string;
    /** SHA-256 of the captured pre-edit content. Null ⇒ file did not exist. */
    beforeBlob: string | null;
    mtimeBeforeMs: number | null;
  }>;
}

export interface TurnStoppedEvent extends BaseEvent {
  kind: 'turn-stopped';
  /** Truncated to 4 KB before write. */
  lastAssistantMessage: string | null;
  files: Array<{
    path: string;
    /** Null ⇒ Claude deleted the file. */
    afterBlob: string | null;
    isNew: boolean;
    isDeleted: boolean;
    isBinary: boolean;
    /**
     * M9.6 (Wave 4): which sub-agent (Claude Code Task tool) produced
     * THIS file's edit. `undefined` for main-agent edits or for events
     * written before Wave 4 landed (forward-compat). The base event's
     * `subagentId` is per-event; this per-file field is needed because
     * a single turn can span multiple sub-agents.
     */
    subagentId?: string;
    hunks: Array<{
      idx: number;
      oldStart: number; oldLines: number;
      newStart: number; newLines: number;
      lines: string[];
    }>;
  }>;
}

export interface HunkDecidedEvent extends BaseEvent {
  kind: 'hunk-decided';
  path: string;
  hunkIdx: number;
  decision: 'accepted' | 'rejected';
  /** Set only when the disk content diverged from snapshot+full-set, e.g.
   *  the user-after content following the decision. SHA-256. */
  postBlob: string | null;
  /** Fuzz factor that produced the applied content. Debug-only. */
  drift: { fuzz: 0 | 2 | null };
}

export interface FileSnapshotRevertedEvent extends BaseEvent {
  kind: 'file-snapshot-reverted';
  path: string;
  /** SHA-256 of the on-disk content immediately after the revert. */
  postBlob: string;
}

export interface UndoEvent extends BaseEvent {
  kind: 'undo';
  scope: 'hunk' | 'file' | 'turn';
  target: { srcTurnId: string; srcEventId: number; path?: string; hunkIdx?: number };
  /** SHA-256s of each path's content after the undo. */
  postBlobs: Record<string, string>;
  cascaded: Array<{ turnId: string; path: string; hunkIdx: number }>;
}

export interface TurnAbortedEvent extends BaseEvent {
  kind: 'turn-aborted';
  reason: 'window-closed' | 'extension-deactivated' | 'circuit-breaker' | 'timeout';
}

/**
 * v0.4 (A4 — edit-before-accept). Captures the user's in-place modification
 * of a hunk's `+` block. `oldHunk` is Claude's original; `newHunk` is the
 * post-edit version (same `oldStart`/`oldLines`; potentially different
 * `newLines` + `lines`). `editedAfterBlob` SHA-256s just the edited `+`
 * block content (raw text) so the Insights panel can later mine the
 * difference between Claude's suggestion and the user's correction.
 * `postBlob` SHA-256s disk content after the edit landed.
 */
export interface HunkEditedEvent extends BaseEvent {
  kind: 'hunk-edited';
  path: string;
  hunkIdx: number;
  /** SHA-256 of the user-edited `+` block content (no diff prefixes). */
  editedAfterBlob: string;
  /** SHA-256 of disk content after the edit landed. */
  postBlob: string;
  /** Claude's original hunk (oldStart/oldLines/newStart/newLines/lines). */
  oldHunk: {
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];
  };
  /** Post-edit substituted hunk; oldStart/oldLines preserved. */
  newHunk: {
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];
  };
}

/**
 * v0.4 (A5 — reject-with-feedback). User-typed reason attached to a previously
 * rejected hunk. The reason text lives in the blob store (size discipline);
 * the event references it via SHA-256.
 */
export interface RejectionReasonEvent extends BaseEvent {
  kind: 'rejection-reason';
  path: string;
  hunkIdx: number;
  /** SHA-256 of the reason text. */
  reasonBlob: string;
}

export type HistoryEvent =
  | TurnStartedEvent
  | TurnStoppedEvent
  | HunkDecidedEvent
  | FileSnapshotRevertedEvent
  | UndoEvent
  | TurnAbortedEvent
  | HunkEditedEvent
  | RejectionReasonEvent;

// --------------------------------------------------------------------------
// Zod validators — used by the reader to tolerantly decode JSONL lines.
// --------------------------------------------------------------------------

const Sha256Like = z.string().regex(/^[a-f0-9]{64}$/);

const FileBeforeRef = z.object({
  path: z.string(),
  beforeBlob: Sha256Like.nullable(),
  mtimeBeforeMs: z.number().nullable(),
});

const FileAfterRef = z.object({
  path: z.string(),
  afterBlob: Sha256Like.nullable(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  isBinary: z.boolean(),
  // M9.6: optional for forward-compat with pre-Wave-4 events on disk.
  subagentId: z.string().optional(),
  hunks: z.array(z.object({
    idx: z.number().int().nonnegative(),
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  })),
});

const BaseFields = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  ts: z.number(),
  eventId: z.number().int().nonnegative(),
  turnId: z.string().uuid(),
  agentId: z.enum(['claude-code', 'opencode']),
  subagentId: z.string().optional(),
};

export const TurnStartedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('turn-started'),
  files: z.array(FileBeforeRef),
});

export const TurnStoppedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('turn-stopped'),
  lastAssistantMessage: z.string().nullable(),
  files: z.array(FileAfterRef),
});

export const HunkDecidedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('hunk-decided'),
  path: z.string(),
  hunkIdx: z.number().int().nonnegative(),
  decision: z.enum(['accepted', 'rejected']),
  postBlob: Sha256Like.nullable(),
  drift: z.object({ fuzz: z.union([z.literal(0), z.literal(2), z.null()]) }),
});

export const FileSnapshotRevertedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('file-snapshot-reverted'),
  path: z.string(),
  postBlob: Sha256Like,
});

export const UndoEventZ = z.object({
  ...BaseFields,
  kind: z.literal('undo'),
  scope: z.enum(['hunk', 'file', 'turn']),
  target: z.object({
    srcTurnId: z.string().uuid(),
    // Allow -1 sentinel: "walk back from the undo event's own eventId" — used
    // for in-session undo of an action that has no recorded srcEventId yet
    // (e.g., the action was applied via the set-pipeline without an explicit
    // pointer back to the originating hunk-decided event). The reader treats
    // negative srcEventId as "infer from chronological replay".
    srcEventId: z.number().int(),
    path: z.string().optional(),
    hunkIdx: z.number().int().nonnegative().optional(),
  }),
  postBlobs: z.record(z.string(), Sha256Like),
  cascaded: z.array(z.object({
    turnId: z.string().uuid(),
    path: z.string(),
    hunkIdx: z.number().int().nonnegative(),
  })),
});

export const TurnAbortedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('turn-aborted'),
  reason: z.enum(['window-closed', 'extension-deactivated', 'circuit-breaker', 'timeout']),
});

const HunkShapeZ = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

export const HunkEditedEventZ = z.object({
  ...BaseFields,
  kind: z.literal('hunk-edited'),
  path: z.string(),
  hunkIdx: z.number().int().nonnegative(),
  editedAfterBlob: Sha256Like,
  postBlob: Sha256Like,
  oldHunk: HunkShapeZ,
  newHunk: HunkShapeZ,
});

export const RejectionReasonEventZ = z.object({
  ...BaseFields,
  kind: z.literal('rejection-reason'),
  path: z.string(),
  hunkIdx: z.number().int().nonnegative(),
  reasonBlob: Sha256Like,
});

export const HistoryEventZ = z.discriminatedUnion('kind', [
  TurnStartedEventZ,
  TurnStoppedEventZ,
  HunkDecidedEventZ,
  FileSnapshotRevertedEventZ,
  UndoEventZ,
  TurnAbortedEventZ,
  HunkEditedEventZ,
  RejectionReasonEventZ,
]);

/** Tolerant decode — returns null on schema failure (caller logs at debug). */
export function decodeEvent(raw: unknown): HistoryEvent | null {
  const r = HistoryEventZ.safeParse(raw);
  return r.success ? (r.data as HistoryEvent) : null;
}
