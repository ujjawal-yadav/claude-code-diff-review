/**
 * Branded types and shared interfaces (TRD §6.1).
 *
 * Branded primitives prevent accidental cross-wiring of structurally identical
 * strings (e.g. an absolute path passed where a session id is expected).
 */

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type AbsPath   = Brand<string, 'AbsPath'>;

export const asSessionId = (s: string): SessionId => s as SessionId;
export const asAbsPath   = (s: string): AbsPath   => s as AbsPath;

/**
 * Identifier for the coding agent that produced a session. Forward-
 * declared here to keep `SessionData` / `SessionReview` agnostic to
 * adapter wiring. Concrete adapter implementations live under
 * `src/adapters/`. (M9.4a — multi-agent groundwork.)
 */
export type AgentId = 'claude-code' | 'opencode';

export interface SessionData {
  /** Which adapter produced the events for this session. */
  agentId: AgentId;
  sessionId: SessionId;
  cwd: string;
  startedAt: number;
  /** First-edit-only original contents, keyed by absolute path. */
  originals: Map<AbsPath, string>;
  /** Every path that received a successful PostToolUse. */
  touched: Set<AbsPath>;
  lastEventAt: number;
  /** Set when the per-session byte/file budget was exhausted. */
  overBudget: boolean;
  /**
   * Identifier for the active turn (Phase α Track 1/6 — Memory Design §2).
   * A "turn" is the window between two `Stop` events. Minted lazily by
   * `SnapshotStore.beginTurnIfNeeded` on first `PreToolUse` after the last
   * `Stop`. Reset to null on Stop. Used by the event log to group events
   * and by future Phase β surfaces (Revisit timeline, Bisect scope).
   */
  currentTurnId: string | null;
  turnStartedAt: number | null;
  /**
   * Phase β.0 (FR-B0.7): the most recently closed turn id, retained after
   * `endTurn` clears `currentTurnId`. Some history events (notably per-hunk
   * ↶ Undo) fire AFTER Stop has closed the active turn — they still need
   * a valid turnId to attach the audit record to. Resolution order is
   * `currentTurnId ?? lastTurnId ?? sessionId` (synthetic fallback).
   */
  lastTurnId: string | null;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RevertResult =
  | { ok: true; newContent: string }
  | { ok: false; reason: 'fuzz-failed' | 'hunk-not-found' | 'unknown'; details?: string };

export interface StructuredHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

export interface ComputedDiff {
  filePath: AbsPath;
  before: string;
  after: string;
  hunks: StructuredHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

export interface SessionMetrics {
  totalHunks: number;
  acceptedHunks: number;
  rejectedHunks: number;
  bytesSnapshotted: number;
}

// --------------------------------------------------------------------------
// Review state (consumed by ReviewPanel + webview)
// --------------------------------------------------------------------------

export type FileStatus  = 'pending' | 'accepted' | 'rejected' | 'partial';
export type HunkStatus  = 'pending' | 'accepted' | 'rejected';
export type SessionState = 'opening' | 'open' | 'completed' | 'dismissed';

export type FileWarning =
  | 'snapshot-truncated'
  | 'fuzz-failed-revert'
  | 'external-edit'
  | 'binary-file'
  | 'write-failed'
  | 'read-failed'
  /**
   * Phase β.0 (10.1.4): file existed at reconstruction time per the history
   * log but is absent on disk. Posted by `ReviewOrchestrator.adoptReconstructed`.
   */
  | 'vanished';

export interface HunkReview {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
  status: HunkStatus;
  decidedAt?: number;
}

export interface FileReview {
  filePath: AbsPath;
  /** Path relative to session cwd, for display. */
  relPath: string;
  before: string;
  after: string;
  hunks: HunkReview[];
  status: FileStatus;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  warnings: FileWarning[];
}

export interface SessionReview {
  /** Which adapter produced this session. (M9.4a.) */
  agentId: AgentId;
  sessionId: SessionId;
  cwd: string;
  startedAt: number;
  openedAt: number;
  lastAssistantMessage: string | null;
  files: FileReview[];
  state: SessionState;
  metrics: SessionMetrics;
}

// --------------------------------------------------------------------------
// Set-based reversibility (Phase α Track 6 — see PHASE-ALPHA-IMMEDIATE.md §8)
// --------------------------------------------------------------------------
//
// The file's true state is defined as `originalSnapshot + applied_hunk_set`.
// Every Accept/Reject is a set-membership update; the file is re-rendered
// from `originalSnapshot`, NOT patched on top of the previous disk state.
// This eliminates drift (toggle Accept→Reject→Accept N times → identical
// bytes each time) and is the foundation for Phase β Investigate primitives
// (C/D/E/F all depend on B).
//
// `acceptedSet` lives host-side only (Sets do not survive structured-clone
// across the webview postMessage boundary). The webview consumes the
// derived `HunkReview.status` field instead.

export interface HunkSetState {
  filePath: AbsPath;
  /** Captured pre-edit content. The render target — never mutated. */
  originalSnapshot: string;
  /** Every hunk Claude produced for this file in this session. Stable order. */
  allHunks: StructuredHunk[];
  /** Indices into `allHunks` that are currently considered applied. */
  acceptedSet: Set<number>;
}

export type RenderResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'set-conflict'; conflictingHunks: number[] }
  | { ok: false; reason: 'snapshot-binary' };
