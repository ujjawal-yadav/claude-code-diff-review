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
  /**
   * M9.6 (Wave 4): which sub-agent (Claude Code Task tool) produced each
   * file edit. First-write-wins, like `originals`. `null` means the main
   * agent edited the file directly. Populated by `captureOriginal` and
   * `recordTouched` when the caller passes a non-null subagentId.
   */
  subagentIdByPath: Map<AbsPath, string | null>;
  /**
   * Bug C fix (post-Wave-4): the subset of `touched` that was actually
   * touched in the CURRENT turn (since the last `freshlyMinted` mint by
   * `beginTurnIfNeeded`). Resets on each new turn. Used by
   * `recordTurnStoppedEvent` to emit a turn-stopped event whose `files[]`
   * is scoped to JUST this turn, not the cumulative session — without
   * this, reconstruction sees later turn-stoppeds REPLACE earlier turns'
   * file state and silently drops prior `hunk-decided` decisions.
   */
  currentTurnTouched: Set<AbsPath>;
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
/**
 * v0.4 (A4): `'edited'` is a third terminal-ish state for hunks that the user
 * tweaked in place before accepting. Disk content reflects the user's edited
 * `+` block, not Claude's original. Counts as "decided" for completion logic
 * but a file with any edited hunk renders as `partial` at the file level so
 * the user can see at a glance that a turn was not pure-Claude.
 */
export type HunkStatus  = 'pending' | 'accepted' | 'rejected' | 'edited';
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

/**
 * v0.5 (build signal) — terminal-or-transient state of the workspace's
 * TypeScript compiler against a single FileReview after a turn closes.
 *
 *  - 'unknown' : initial state before the runner fires, OR after a
 *                timeout / crash / user-cancel.
 *  - 'running' : tsc spawn is in flight; partial results may still update
 *                the field as parsing completes.
 *  - 'pass'    : tsc completed cleanly (exit 0) and produced no error-
 *                category diagnostics for this file.
 *  - 'fail'    : at least one error-category diagnostic was emitted whose
 *                file path matches this FileReview.
 */
export type BuildStatus = 'unknown' | 'running' | 'pass' | 'fail';

/**
 * v0.5 (build signal) — a single tsc diagnostic, normalised to the
 * extension's view of the workspace. Project-level diagnostics (no file
 * anchor) carry an empty `relPath` and live on `SessionReview.buildSignal
 * .projectDiagnostics` instead of any per-file list.
 */
export interface BuildErrorRef {
  /** Workspace-relative, forward-slash. Empty for project-level diagnostics. */
  relPath: string;
  /** 1-based, from tsc output. 0 for project-level (no file location). */
  line: number;
  col: number;
  /** tsc diagnostic code, e.g. 2322. */
  code: number;
  severity: 'error' | 'warning';
  message: string;
  /**
   * v0.5.1 (LH7): explicit flag for diagnostics emitted without a file
   * anchor (e.g. `error TS5023: Unknown compiler option 'foo'`). Prior
   * to v0.5.1, readers had to check `relPath === ''` + `line === 0` as
   * sentinels — error-prone. Now the flag is the source of truth; the
   * empty `relPath` / zero `line` remain for backward compat with any
   * (host-only, never persisted) consumer that still reads them.
   */
  isProjectLevel?: true;
}

/**
 * v0.5 (build signal) — session-level aggregate. The orchestrator's
 * BuildSignalManager owns this and pushes updates via the `build-signal`
 * HostToWebview message. The per-file `FileReview.buildStatus` field and
 * per-hunk `HunkReview.buildErrors` field carry the projection used by
 * the dot indicator and inline badges respectively.
 */
export interface BuildSignal {
  status: BuildStatus;
  /** ms-epoch when the current run started; null when status === 'unknown'. */
  startedAt: number | null;
  /** ms-epoch when the run finished; null while running or unknown. */
  finishedAt: number | null;
  totalErrors: number;
  totalWarnings: number;
  /** Diagnostics with no file anchor (compiler config errors, etc.). */
  projectDiagnostics: BuildErrorRef[];
  /** Whatever stderr produced when exit code was 2 or 3. */
  fatalStderr: string | null;
  /**
   * `true` when tsc -b reported the build was incremental-cached
   * (sub-second exit with no diagnostics). Surfaces as a tooltip hint
   * so the user understands a 0.1s "tsc: passed" run is genuine.
   */
  cached?: boolean;
}

/**
 * v0.3 — heuristic risk flags surfaced on files and hunks to help the user
 * prioritise which hunks to review most carefully. File-level flags apply to
 * the file as a whole (sensitive-path, lockfile, test-file). Hunk-level
 * flags apply to a single hunk (deletion, large-hunk, removed-error-handling,
 * removed-null-check). Heuristic implementation lives in `src/riskFlagger.ts`.
 */
export type RiskFlag =
  | 'sensitive-path'
  | 'deletion'
  | 'removed-error-handling'
  | 'removed-null-check'
  | 'large-hunk'
  | 'lockfile'
  | 'test-file';

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
  /**
   * v0.3 — heuristic risk flags (deletion, large-hunk, removed-error-handling,
   * removed-null-check). Computed by `flagHunk` in `src/riskFlagger.ts` at
   * `openReview` time. Surfaced as inline badges on the hunk header.
   */
  flags?: RiskFlag[];
  /**
   * v0.4 (A8 cheap — rename grouping). When a hunk participates in a
   * detected single-identifier rename across ≥3 hunks, its `groupId` is
   * set to `${oldToken}->${newToken}`. The webview renders a chip on the
   * hunk header that, when clicked, expands a panel listing all members
   * with "Accept all / Reject all" actions. Undefined when no group
   * applies.
   */
  renameGroupId?: string;
  /**
   * v0.5 (build signal). Per-hunk projection of the typecheck result:
   * tsc diagnostics whose line falls within this hunk's post-edit range
   * `[newStart, newStart + newLines - 1]`. Undefined / empty array ⇒
   * the hunk's lines weren't flagged (but the FILE may still be `'fail'`
   * if errors landed on unchanged context — see FileReview.buildStatus).
   *
   * Surfaced as the `🚨 N tsc errors` inline badge with hover tooltip
   * carrying each error's message.
   */
  buildErrors?: BuildErrorRef[];
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
  /**
   * M9.6 (Wave 4): identifier of the sub-agent (Claude Code Task tool)
   * that produced this file's edit. `undefined` when no sub-agent was
   * involved (main agent edited directly). Surfaced in the file-list
   * chip and hunk header tooltip. File-level only — not on HunkReview
   * (Task tool boundary is at the tool-call level, one Task → one file
   * edit). Propagates through the event log so reconstructed sessions
   * preserve attribution.
   */
  subagentId?: string;
  /**
   * v0.3 — heuristic risk flags applied to the file as a whole
   * (sensitive-path, lockfile, test-file). Computed by `flagFile` in
   * `src/riskFlagger.ts`. Surfaced as a single chip on the file-list row
   * (most-severe flag wins; tooltip lists all).
   */
  flags?: RiskFlag[];
  /**
   * v0.5 (build signal). Result of running the workspace's typecheck
   * against this file. Starts as undefined (or 'unknown' once the runner
   * has been told to spawn); transitions to 'running' on spawn-start;
   * settles on 'pass' / 'fail' on completion; falls back to 'unknown' on
   * timeout / crash / cancel.
   *
   * The runner mutates this field in-place on the live FileReview and
   * calls `panel.postFileUpdated` so the webview's `applyFileUpdate`
   * picks it up. User hunk decisions are preserved because the runner
   * never touches `hunk.status`.
   */
  buildStatus?: BuildStatus;
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
  /**
   * v0.4 (A8 cheap — rename grouping). Keyed by `${oldToken}->${newToken}`;
   * value is the list of hunk-membership entries that share that rename.
   * Populated by `groupRenames` at openReview-time alongside risk flags.
   * Only groups with size ≥3 are surfaced (small groups likely false
   * positives). Undefined when no groups were detected for this session.
   */
  renameGroups?: Record<string, Array<{ filePath: string; hunkIndex: number }>>;
  /**
   * v0.5 (build signal). Session-level aggregate of the typecheck result.
   * Owned by `BuildSignalManager`; updated via the `build-signal`
   * HostToWebview message. Undefined when the feature is disabled or
   * before the first run fires.
   */
  buildSignal?: BuildSignal;
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
  /**
   * v0.4 (A4 — edit-before-accept). Per-hunk substitution layer: when an
   * index is present in this map AND in `acceptedSet`, `renderFileFromHunkSet`
   * uses the substituted hunk's `lines`/`newLines` instead of `allHunks[idx]`.
   * Preserves `oldStart`/`oldLines` (the pre-edit anchor) so the multi-hunk
   * patch still locates correctly against `originalSnapshot`.
   *
   * Determinism invariant becomes:
   *   `originalSnapshot + acceptedSet + editedHunks → content` is total.
   */
  editedHunks: Map<number, StructuredHunk>;
}

export type RenderResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'set-conflict'; conflictingHunks: number[] }
  | { ok: false; reason: 'snapshot-binary' };

// --------------------------------------------------------------------------
// v0.6 (A9 — Insights): cross-session analytics mined from the event log.
//
// Host-computed, webview-rendered. The aggregator (src/insights/) produces
// an `InsightsReport`; the History panel's Insights tab renders it. These
// shapes live in `src/types.ts` (not `src/history/*`) because the webview
// can only `import type` from `src/types` / `src/messages`.
//
// exactOptionalPropertyTypes-clean: no optional field carries `| undefined`.
// --------------------------------------------------------------------------

/** Per-file accept/reject tally (final-decision state, undo-aware). */
export interface FileRate {
  /** Workspace-relative, forward-slash. */
  path: string;
  accepted: number;
  rejected: number;
  /** v0.4 (A4) edited hunks — excluded from `acceptRate` denominator. */
  edited: number;
  /** accepted / (accepted + rejected); 0 when the denominator is 0. */
  acceptRate: number;
}

/** Per-sub-agent acceptance tally. */
export interface SubagentRate {
  /** `"__main__"` sentinel for unattributed / main-agent decisions. */
  subagentId: string;
  /** Display label — "Main agent" for the sentinel, else the Task description. */
  label: string;
  accepted: number;
  rejected: number;
  edited: number;
  acceptRate: number;
}

/** One day in the rejection-rate trend. Counts decision *events* (activity). */
export interface TrendBucket {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** accepted + rejected decision events that day. */
  decided: number;
  rejected: number;
  /** rejected / decided; 0 when decided is 0. */
  rejectionRate: number;
}

/** A cluster of identical rejection reasons. */
export interface RejectionReasonGroup {
  /** Normalised reason text (trimmed; grouping key). */
  reason: string;
  count: number;
  /** Up to `reasonSampleSize` example file paths. */
  samplePaths: string[];
}

/** The complete analytics payload posted to the Insights tab. */
export interface InsightsReport {
  /** Epoch ms the report was computed (drives "as of" / staleness). */
  computedAt: number;
  /** Scan window in ms (default 30 days). */
  windowMs: number;
  /** Number of sessions scanned within the window. */
  sessionsScanned: number;
  /** Sorted desc by (accepted + rejected); denominator-0 files excluded. */
  fileRates: FileRate[];
  /** Includes the `"__main__"` bucket when present. */
  subagentRates: SubagentRate[];
  /** Exactly `trendDays` buckets, oldest→newest, zero-filled. */
  trend: TrendBucket[];
  reasons: {
    total: number;
    groups: RejectionReasonGroup[];
  };
  /** True when the entire scan produced zero decisions. */
  empty: boolean;
}
