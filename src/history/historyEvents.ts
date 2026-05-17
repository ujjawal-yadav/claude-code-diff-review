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

export type AgentId = 'claude-code' | 'opencode';

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

export type HistoryEvent =
  | TurnStartedEvent
  | TurnStoppedEvent
  | HunkDecidedEvent
  | FileSnapshotRevertedEvent
  | UndoEvent
  | TurnAbortedEvent;

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

export const HistoryEventZ = z.discriminatedUnion('kind', [
  TurnStartedEventZ,
  TurnStoppedEventZ,
  HunkDecidedEventZ,
  FileSnapshotRevertedEventZ,
  UndoEventZ,
  TurnAbortedEventZ,
]);

/** Tolerant decode — returns null on schema failure (caller logs at debug). */
export function decodeEvent(raw: unknown): HistoryEvent | null {
  const r = HistoryEventZ.safeParse(raw);
  return r.success ? (r.data as HistoryEvent) : null;
}
