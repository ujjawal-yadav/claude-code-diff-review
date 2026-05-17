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
  | 'read-failed';

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
