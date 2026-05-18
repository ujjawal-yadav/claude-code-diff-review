/**
 * Pure-types file for the history subsystem. Zero Node imports so the
 * webview tsconfig can pull these in without dragging `node:fs` etc.
 *
 * The runtime modules (`historyIndex.ts`, `historyService.ts`, ...) re-export
 * from here for callers that need a unified import surface.
 */

import type { AgentId } from './historyEvents.js';

export interface SessionIndexEntry {
  sessionId: string;
  status: 'open' | 'closed' | 'aborted';
  agentId: AgentId;
  startedAt: number;
  lastEventAt: number;
  /** Stop-hook message captured on the last turn-stopped (truncated). */
  lastMessage: string | null;
  /** Total turns observed so far. */
  turnCount: number;
  /**
   * Phase β.0 (10.1.2): true when the most recent turn-started has no
   * matching turn-stopped or turn-aborted. Maintained by HistoryService
   * write paths so findResumeCandidates / getPendingReviewsSummary do not
   * have to scan every session's events on every call.
   */
  hasOpenTurn?: boolean;
  /**
   * Phase β.0 (10.1.2): cached count of hunks in the most recent turn-stopped
   * that have NOT yet been decided (hunk-decided or undone-to-pending).
   * Lazy-computed on first read; null ⇒ "not computed yet, recompute on next
   * read." Reset to null on every turn-stopped / hunk-decided / undo event so
   * the cache stays correct without active invalidation everywhere.
   */
  pendingHunkCount?: number | null;
}

export interface HistoryIndex {
  v: 1;
  sessions: SessionIndexEntry[];
}

// --------------------------------------------------------------------------
// Phase β.0 — Actionable History (10.1.1)
// --------------------------------------------------------------------------

/**
 * Aggregate "what's unfinished?" view across every session in the index.
 *
 * Drives the status bar pending-count indicator and the `Open Review Panel`
 * prompt. Read at activation, on every `hunk-decided`, and on session
 * dismissal — backed by a 1-second TTL cache to absorb concurrent reads.
 */
export interface PendingReviewsSummary {
  totalSessions: number;
  totalPendingHunks: number;
  /**
   * Sorted most-recent-first. Status bar tooltip shows the top 5; the
   * History panel shows the full list.
   */
  sessions: Array<{
    sessionId: string;
    agentId: AgentId;
    pendingCount: number;
    totalCount: number;
    lastEventAt: number;
    status: 'open' | 'closed' | 'aborted';
  }>;
}

/**
 * Disk-vs-reconstructed file state classification (used by `adoptReconstructed`
 * to decide whether to surface an external-edit warning, treat the file as
 * vanished, or render normally).
 *
 *  - 'clean':   on-disk SHA-256 matches the reconstructed `after` content
 *  - 'drifted': on-disk content exists but its hash diverged (external edit)
 *  - 'missing': file no longer exists on disk
 */
export type FileDriftStatus = 'clean' | 'drifted' | 'missing';

/**
 * Pure-shape mirror of `FileReview` that the history reconstruction emits.
 *
 * No Node imports — webview safety. Diverges from `FileReview` (src/types.ts)
 * only in that it is allocated by the reader and carries no `FileWarning[]`
 * yet (warnings are surfaced by `adoptReconstructed` based on drift).
 */
export interface ReconstructedFileReview {
  /** Absolute path (Node-host context — webview displays `relPath` instead). */
  filePath: string;
  /** Workspace-relative, forward-slash. */
  relPath: string;
  before: string;
  after: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  /**
   * M9.6 (Wave 4): sub-agent attribution preserved across replay. `undefined`
   * for files edited directly by the main agent OR for events written before
   * Wave 4 (forward-compat).
   */
  subagentId?: string;
  /** Hunks the original turn produced — index-stable. */
  hunks: Array<{
    index: number;
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    header: string;
    lines: string[];
    status: 'pending' | 'accepted' | 'rejected';
    decidedAt?: number;
  }>;
}

/**
 * Output of `HistoryService.reconstructSessionReview(sessionId)`.
 *
 * The orchestrator consumes this via `adoptReconstructed(reconstructed)`
 * to seed every per-session map (sessions, byPath, globalByPath, hunkSets,
 * snapshotStore) so a closed/aborted session can be re-opened.
 */
export interface ReconstructedSessionReview {
  sessionId: string;
  agentId: AgentId;
  /** Absolute path captured from the most recent `turn-started.cwd` (encoded). */
  cwd: string;
  /** Most recent turn id — Resume re-opens this turn, not a synthetic one. */
  turnId: string;
  /** Greatest eventId seen during replay. Helps detect drift across replays. */
  lastEventId: number;
  /** Reconstructed files keyed by stable iteration order. */
  files: ReconstructedFileReview[];
  /**
   * Per-file hunk-set state — mirrors `HunkSetState` from src/types.ts but
   * carries only the indices (no Set object — webview can't structured-clone Set).
   */
  hunkSets: Array<{
    filePath: string;
    originalSnapshot: string;
    allHunks: Array<{
      index: number;
      oldStart: number; oldLines: number;
      newStart: number; newLines: number;
      header: string;
      lines: string[];
    }>;
    acceptedSet: number[];
  }>;
  /** Per-file drift classification by relPath. */
  driftPerFile: Record<string, FileDriftStatus>;
  /** Source-of-truth: timestamp of the most recent event in the log. */
  lastEventAt: number;
}
