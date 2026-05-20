/**
 * History orchestrator (MEMORY-DESIGN.md §6 + Phase α §3.5 T1-A1..A8).
 *
 * Composes writer + reader + blobs + index. All Phase α tracks 1-2-4-5
 * funnel through this single service so the orchestrator and extension
 * code never reach across into the underlying primitives directly.
 *
 * Path scheme (Q6 resolved in planning)
 * --------------------------------------
 * - When install scope is 'user':
 *     ~/.claude/review-history/<sha256(absolute workspace path)[:16]>/
 *   keeps workspaces isolated even though the parent .claude directory
 *   is shared across all projects.
 *
 * - When install scope is 'workspace':
 *     <workspace>/.claude/review-history/
 *   stays local — events follow the project.
 *
 * The service constructs once per workspace at activation; rebuild if
 * scope is switched at runtime via `claudeReview.switchInstallScope`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { BlobStore, sha256Hex } from './historyBlobs.js';
import type {
  FileDriftStatus,
  PendingReviewsSummary,
  ReconstructedFileReview,
  ReconstructedSessionReview,
} from './historyTypes.js';
import {
  AgentId,
  HistoryEvent,
  TurnAbortedEvent,
  TurnStartedEvent,
  TurnStoppedEvent,
  UndoEvent,
} from './historyEvents.js';
import { HistoryIndexFile, SessionIndexEntry } from './historyIndex.js';
import { HistoryReader, ResumeCandidate } from './historyReader.js';
import { HistoryWriter } from './historyWriter.js';

import type { Logger } from '../logger.js';
import type { InstallScope } from '../hookConfigurator.js';

const LAST_MESSAGE_CAP_BYTES = 4096;

/**
 * Live-update channel (2026-05-19). Fires after every successful event-log
 * write. Subscribers (HistoryPanelManager, PendingStatusBar) react to keep
 * their UI in sync with on-disk state. Multiple subscribers supported — a
 * Set is used rather than `ReviewOrchestrator`'s single-callback pattern.
 *
 * Failures in a listener are caught and logged; they never propagate into
 * the write path. Listeners are expected to be cheap (e.g. schedule a
 * debounced refresh) — never do I/O synchronously inside one.
 */
export type HistoryChangeKind =
  | 'turn-started'
  | 'turn-stopped'
  | 'hunk-decided'
  | 'snapshot-reverted'
  | 'undo'
  | 'turn-aborted'
  | 'session-deleted';

export interface HistoryChangeInfo {
  sessionId: string;
  kind: HistoryChangeKind;
}

export type HistoryChangeListener = (info: HistoryChangeInfo) => void;

export interface HistoryServiceOptions {
  scope: InstallScope;
  /** Workspace root (absolute). Required even for user-scope to derive the hash. */
  workspaceRoot: string;
  logger: Logger;
  /** Toggle. Off ⇒ all calls are no-ops; the orchestrator can call freely. */
  enabled: boolean;
}

export interface RecordTurnStartedInput {
  sessionId: string;
  turnId: string;
  agentId: AgentId;
  subagentId?: string;
  files: Array<{ relPath: string; beforeContent: string | null; mtimeMs: number | null }>;
}

export interface RecordTurnStoppedInput {
  sessionId: string;
  turnId: string;
  agentId: AgentId;
  subagentId?: string;
  lastAssistantMessage: string | null;
  files: Array<{
    relPath: string;
    afterContent: string | null;
    isNew: boolean;
    isDeleted: boolean;
    isBinary: boolean;
    /** M9.6: per-file sub-agent attribution. */
    subagentId?: string;
    hunks: Array<{
      idx: number;
      oldStart: number; oldLines: number;
      newStart: number; newLines: number;
      lines: string[];
    }>;
  }>;
}

export interface RecordHunkDecidedInput {
  sessionId: string;
  turnId: string;
  agentId: AgentId;
  subagentId?: string;
  relPath: string;
  hunkIdx: number;
  decision: 'accepted' | 'rejected';
  postContent: string | null;
  drift: { fuzz: 0 | 2 | null };
}

export interface RecordFileSnapshotRevertedInput {
  sessionId: string;
  turnId: string;
  agentId: AgentId;
  subagentId?: string;
  relPath: string;
  postContent: string;
}

/**
 * Phase β.0 (FR-B0.7): a single user undo action against one or more files.
 *
 * `postContents` maps each affected path to the file's content AFTER the
 * undo applied. `recordUndo` writes each content to the blob store and
 * captures the SHA-256 map as `postBlobs` on the resulting event so a
 * future `reconstructSessionReview` can re-anchor the file state without
 * re-walking the prior hunk-decided chain.
 */
export interface RecordUndoInput {
  sessionId: string;
  /** Current or last turn id (caller resolves the post-Stop fallback). */
  turnId: string;
  agentId: AgentId;
  subagentId?: string;
  scope: 'hunk' | 'file' | 'turn';
  target: {
    srcTurnId: string;
    /** -1 sentinel ⇒ "infer from chronological replay" (see UndoEventZ). */
    srcEventId: number;
    path?: string;
    hunkIdx?: number;
  };
  /** path → restored content; the method writes each to the blob store. */
  postContents: Record<string, string>;
  cascaded?: Array<{ turnId: string; path: string; hunkIdx: number }>;
}

export class HistoryService {
  private readonly root: string;
  private readonly blobs: BlobStore;
  private readonly index: HistoryIndexFile;
  private readonly reader: HistoryReader;
  /** Writer instances per-session (each ties to one sessionId for state). */
  private readonly writers = new Map<string, HistoryWriter>();
  /** Index entries kept in memory between turn-started and turn-stopped. */
  private readonly liveSessions = new Map<string, SessionIndexEntry>();
  /**
   * β.0 (10.1.5b): 1-second TTL cache for `getPendingReviewsSummary`. The
   * status bar's debounced refresh and the `openPanel` command upgrade both
   * call this method; the cache absorbs the recompute storm during a burst.
   * Invalidated explicitly via `invalidatePendingSummaryCache` whenever the
   * underlying counts change (hunk decisions, undo, file revert, delete).
   */
  private pendingSummaryCache: { value: PendingReviewsSummary; expiresAt: number } | null = null;
  private static readonly PENDING_SUMMARY_TTL_MS = 1_000;

  /**
   * Live-update listeners. See `HistoryChangeListener` JSDoc on the type
   * definition for the contract and failure semantics.
   */
  private readonly listeners = new Set<HistoryChangeListener>();

  constructor(private readonly opts: HistoryServiceOptions) {
    this.root = resolveHistoryRoot(opts.scope, opts.workspaceRoot);
    this.blobs = new BlobStore({ root: this.root });
    this.index = new HistoryIndexFile({ root: this.root });
    this.reader = new HistoryReader({ root: this.root });
  }

  /** Absolute path to the workspace's history root. Exposed for ops/debug. */
  getRoot(): string {
    return this.root;
  }

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * Subscribe to live-update notifications. Returns an unsubscribe function.
   *
   * Listeners fire on every successful `record*` write and on `deleteSession`.
   * They do NOT fire when the service is disabled (the early-exit short-circuits
   * before emission). A throwing listener cannot break the write path —
   * `emitChange` isolates each listener in a try/catch.
   */
  addChangeListener(listener: HistoryChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(info: HistoryChangeInfo): void {
    for (const l of this.listeners) {
      try {
        l(info);
      } catch (err) {
        this.opts.logger.warn('history', 'listener.threw', {
          err: String(err),
          kind: info.kind,
          sid: info.sessionId,
        });
      }
    }
  }

  // -- write paths ---------------------------------------------------------

  async recordTurnStarted(input: RecordTurnStartedInput): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(input.sessionId);
      const files: TurnStartedEvent['files'] = [];
      for (const f of input.files) {
        const beforeBlob = f.beforeContent != null
          ? await this.blobs.write(f.beforeContent)
          : null;
        files.push({ path: f.relPath, beforeBlob, mtimeBeforeMs: f.mtimeMs });
      }
      const ev: Omit<TurnStartedEvent, 'eventId' | 'v'> = {
        kind: 'turn-started',
        ts: Date.now(),
        turnId: input.turnId,
        agentId: input.agentId,
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        files,
      };
      await writer.append(ev);
      await this.upsertIndexEntry(input.sessionId, input.agentId, /* incrementTurn */ true, null);
      this.emitChange({ sessionId: input.sessionId, kind: 'turn-started' });
    } catch (err) {
      this.opts.logger.warn('history', 'turn.started.failed', { err: String(err), sid: input.sessionId });
    }
  }

  async recordTurnStopped(input: RecordTurnStoppedInput): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(input.sessionId);
      const files: TurnStoppedEvent['files'] = [];
      for (const f of input.files) {
        const afterBlob = f.afterContent != null
          ? await this.blobs.write(f.afterContent)
          : null;
        files.push({
          path: f.relPath,
          afterBlob,
          isNew: f.isNew,
          isDeleted: f.isDeleted,
          isBinary: f.isBinary,
          ...(f.subagentId ? { subagentId: f.subagentId } : {}),
          hunks: f.hunks,
        });
      }
      const lastMsg = truncateMessage(input.lastAssistantMessage);
      const ev: Omit<TurnStoppedEvent, 'eventId' | 'v'> = {
        kind: 'turn-stopped',
        ts: Date.now(),
        turnId: input.turnId,
        agentId: input.agentId,
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        lastAssistantMessage: lastMsg,
        files,
      };
      await writer.append(ev);
      await this.markSessionClosed(input.sessionId, input.agentId, lastMsg);
      this.emitChange({ sessionId: input.sessionId, kind: 'turn-stopped' });
    } catch (err) {
      this.opts.logger.warn('history', 'turn.stopped.failed', { err: String(err), sid: input.sessionId });
    }
  }

  async recordHunkDecided(input: RecordHunkDecidedInput): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(input.sessionId);
      const postBlob = input.postContent != null
        ? await this.blobs.write(input.postContent)
        : null;
      await writer.append({
        kind: 'hunk-decided',
        ts: Date.now(),
        turnId: input.turnId,
        agentId: input.agentId,
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        path: input.relPath,
        hunkIdx: input.hunkIdx,
        decision: input.decision,
        postBlob,
        drift: input.drift,
      });
      await this.invalidatePendingHunkCount(input.sessionId);
      this.emitChange({ sessionId: input.sessionId, kind: 'hunk-decided' });
    } catch (err) {
      this.opts.logger.warn('history', 'decision.failed', { err: String(err), sid: input.sessionId });
    }
  }

  async recordFileSnapshotReverted(input: RecordFileSnapshotRevertedInput): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(input.sessionId);
      const postBlob = await this.blobs.write(input.postContent);
      await writer.append({
        kind: 'file-snapshot-reverted',
        ts: Date.now(),
        turnId: input.turnId,
        agentId: input.agentId,
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        path: input.relPath,
        postBlob,
      });
      await this.invalidatePendingHunkCount(input.sessionId);
      this.emitChange({ sessionId: input.sessionId, kind: 'snapshot-reverted' });
    } catch (err) {
      this.opts.logger.warn('history', 'revert.failed', { err: String(err), sid: input.sessionId });
    }
  }

  /**
   * Phase β.0 (FR-B0.7): emit an `undo` event for an in-session undo path.
   *
   * Fire-and-forget pattern — failures are logged but never block the user
   * flow. Each entry in `postContents` is written to the blob store; the
   * resulting SHA map becomes `postBlobs` on the event.
   */
  async recordUndo(input: RecordUndoInput): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(input.sessionId);
      const postBlobs: Record<string, string> = {};
      for (const [relPath, content] of Object.entries(input.postContents)) {
        postBlobs[relPath] = await this.blobs.write(content);
      }
      const target: UndoEvent['target'] = {
        srcTurnId: input.target.srcTurnId,
        srcEventId: input.target.srcEventId,
        ...(input.target.path !== undefined ? { path: input.target.path } : {}),
        ...(input.target.hunkIdx !== undefined ? { hunkIdx: input.target.hunkIdx } : {}),
      };
      await writer.append({
        kind: 'undo',
        ts: Date.now(),
        turnId: input.turnId,
        agentId: input.agentId,
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        scope: input.scope,
        target,
        postBlobs,
        cascaded: input.cascaded ?? [],
      });
      await this.invalidatePendingHunkCount(input.sessionId);
      this.emitChange({ sessionId: input.sessionId, kind: 'undo' });
    } catch (err) {
      this.opts.logger.warn('history', 'undo.failed', { err: String(err), sid: input.sessionId });
    }
  }

  async recordTurnAborted(
    sessionId: string,
    turnId: string,
    agentId: AgentId,
    reason: TurnAbortedEvent['reason'],
  ): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const writer = this.getWriter(sessionId);
      await writer.append({
        kind: 'turn-aborted',
        ts: Date.now(),
        turnId,
        agentId,
        reason,
      });
      const entry = this.liveSessions.get(sessionId);
      if (entry) {
        entry.status = 'aborted';
        // β.0 (10.1.2): abort closes the open turn; any pending count is stale.
        entry.hasOpenTurn = false;
        entry.pendingHunkCount = null;
        await this.index.upsertSession(entry);
      }
      this.emitChange({ sessionId, kind: 'turn-aborted' });
    } catch (err) {
      this.opts.logger.warn('history', 'abort.failed', { err: String(err) });
    }
  }

  // -- read paths ----------------------------------------------------------

  async listSessions(): Promise<SessionIndexEntry[]> {
    const idx = await this.index.read();
    return idx.sessions.slice();
  }

  async readEvents(sessionId: string): Promise<HistoryEvent[]> {
    return this.reader.readAll(sessionId);
  }

  readSessionStream(sessionId: string): AsyncGenerator<HistoryEvent> {
    return this.reader.readSession(sessionId);
  }

  async findResumeCandidates(opts: { withinMs: number }): Promise<ResumeCandidate[]> {
    return this.reader.findResumeCandidates(opts);
  }

  async readBlob(sha: string): Promise<string> {
    return this.blobs.read(sha);
  }

  /**
   * β.0 (10.1.3): replay a session's events into a `ReconstructedSessionReview`
   * suitable for `ReviewOrchestrator.adoptReconstructed`.
   *
   * Algorithm
   * ---------
   * Stream events chronologically. Maintain per-file mutable state
   * `{ acceptedSet, hunks, originalSnapshot, afterContent }`.
   *
   *   turn-started: read `beforeBlob` per file → originalSnapshot; init entry.
   *                 The most recent turn-started's turnId becomes the session's
   *                 turnId (Resume re-opens the prior turn, not a synthetic one).
   *   turn-stopped: read `afterBlob` → afterContent; replace hunks; seed
   *                 acceptedSet = {0..N-1} (every hunk initially applied).
   *                 Decisions logged AFTER this event toggle membership.
   *   hunk-decided: accepted → set.add(hunkIdx); rejected → set.delete.
   *   file-snapshot-reverted: set.clear(); afterContent = originalSnapshot
   *   undo: re-anchor afterContent from postBlob (the simplest "what should the
   *         world look like now" anchor — avoids re-walking the toggle chain).
   *   turn-aborted: noted but does not stop replay (subsequent events may
   *                 still apply if the session continued with a new turn).
   *
   * Drift classification
   * --------------------
   * After replay, read the file's current on-disk content and compare its
   * SHA-256 against the reconstructed `afterContent`:
   *   - missing on disk → 'missing'
   *   - hashes match    → 'clean'
   *   - hashes differ   → 'drifted'
   *
   * Returns null if the session has no events.
   */
  async reconstructSessionReview(
    sessionId: string,
    options?: { cwd?: string; readDiskFile?: (relPath: string) => Promise<string | null> },
  ): Promise<ReconstructedSessionReview | null> {
    const cwd = options?.cwd ?? this.opts.workspaceRoot;

    interface PerFileState {
      relPath: string;
      originalSnapshot: string;
      afterContent: string;
      isNew: boolean;
      isDeleted: boolean;
      isBinary: boolean;
      /** M9.6: per-file sub-agent attribution from turn-stopped events. */
      subagentId?: string;
      hunks: ReconstructedFileReview['hunks'];
      acceptedSet: Set<number>;
    }
    const files = new Map<string, PerFileState>();
    let agentId: AgentId = 'claude-code';
    let turnId: string | null = null;
    let lastEventId = -1;
    let lastEventAt = 0;
    let hadAnyEvent = false;

    for await (const ev of this.reader.readSession(sessionId)) {
      hadAnyEvent = true;
      lastEventId = Math.max(lastEventId, ev.eventId);
      lastEventAt = Math.max(lastEventAt, ev.ts);
      agentId = ev.agentId;
      switch (ev.kind) {
        case 'turn-started': {
          turnId = ev.turnId;
          // Batch per-file beforeBlob reads. Within a single event the reads
          // are independent (content-addressed immutable blobs); cross-event
          // ordering is preserved by the outer for-await-of loop.
          const beforeContents = await Promise.all(
            ev.files.map((f) => (f.beforeBlob ? this.safeReadBlob(f.beforeBlob) : Promise.resolve(''))),
          );
          for (let i = 0; i < ev.files.length; i++) {
            const f = ev.files[i]!;
            const before = beforeContents[i]!;
            const state = files.get(f.path) ?? {
              relPath: f.path,
              originalSnapshot: before,
              afterContent: before,
              isNew: false,
              isDeleted: false,
              isBinary: false,
              hunks: [],
              acceptedSet: new Set<number>(),
            };
            // Subsequent turn-started for the same file (multi-turn session)
            // replaces the snapshot baseline. Hunks/acceptedSet reset later
            // when turn-stopped lands.
            state.originalSnapshot = before;
            files.set(f.path, state);
          }
          break;
        }
        case 'turn-stopped': {
          turnId = ev.turnId;
          // Batch per-file afterBlob reads (same rationale as turn-started).
          const afterContents = await Promise.all(
            ev.files.map((f) => (f.afterBlob ? this.safeReadBlob(f.afterBlob) : Promise.resolve(''))),
          );
          for (let i = 0; i < ev.files.length; i++) {
            const f = ev.files[i]!;
            const after = afterContents[i]!;
            const existing = files.get(f.path);
            const state: PerFileState = existing ?? {
              relPath: f.path,
              originalSnapshot: '',
              afterContent: after,
              isNew: false,
              isDeleted: false,
              isBinary: false,
              hunks: [],
              acceptedSet: new Set<number>(),
            };
            state.afterContent = after;
            state.isNew = f.isNew;
            state.isDeleted = f.isDeleted;
            state.isBinary = f.isBinary;
            // M9.6: preserve per-file sub-agent attribution across replay.
            if (f.subagentId) state.subagentId = f.subagentId;
            state.hunks = f.hunks.map((h) => ({
              index: h.idx,
              oldStart: h.oldStart,
              oldLines: h.oldLines,
              newStart: h.newStart,
              newLines: h.newLines,
              // header is not persisted — reconstruct an empty placeholder.
              // Webview-side renderers re-derive from oldStart/newStart.
              header: '',
              lines: h.lines.slice(),
              status: 'pending',
            }));
            state.acceptedSet = new Set(f.hunks.map((h) => h.idx));
            files.set(f.path, state);
          }
          break;
        }
        case 'hunk-decided': {
          const state = files.get(ev.path);
          if (!state) break;
          const hunk = state.hunks.find((h) => h.index === ev.hunkIdx);
          if (hunk) {
            hunk.status = ev.decision;
            hunk.decidedAt = ev.ts;
          }
          if (ev.decision === 'accepted') state.acceptedSet.add(ev.hunkIdx);
          else                              state.acceptedSet.delete(ev.hunkIdx);
          if (ev.postBlob) {
            const content = await this.safeReadBlob(ev.postBlob);
            state.afterContent = content;
          }
          break;
        }
        case 'file-snapshot-reverted': {
          const state = files.get(ev.path);
          if (!state) break;
          state.acceptedSet.clear();
          for (const h of state.hunks) {
            h.status = 'rejected';
            h.decidedAt = ev.ts;
          }
          state.afterContent = await this.safeReadBlob(ev.postBlob);
          break;
        }
        case 'undo': {
          // Re-anchor each affected file's afterContent from postBlobs.
          // Reads are independent — batch them.
          const undoEntries = Object.entries(ev.postBlobs);
          const undoContents = await Promise.all(
            undoEntries.map(([, sha]) => this.safeReadBlob(sha)),
          );
          for (let i = 0; i < undoEntries.length; i++) {
            const [relPath] = undoEntries[i]!;
            const content = undoContents[i]!;
            const state = files.get(relPath);
            if (!state) continue;
            state.afterContent = content;
            // For scope:'hunk' with a specific hunkIdx, flip that hunk back
            // to pending so the user sees the undone decision as undecided.
            if (ev.scope === 'hunk' && ev.target.path === relPath && ev.target.hunkIdx !== undefined) {
              const hunk = state.hunks.find((h) => h.index === ev.target.hunkIdx);
              if (hunk) {
                hunk.status = 'pending';
                delete hunk.decidedAt;
              }
              // Set membership: if the hunk was accepted → remove (revert
              // toggle); if rejected → add. Best-effort — afterContent is
              // already canonical via postBlob anchor.
            } else if (ev.scope === 'file') {
              // File-scope undo: revert every hunk to pending.
              for (const h of state.hunks) {
                h.status = 'pending';
                delete h.decidedAt;
              }
            } else if (ev.scope === 'turn') {
              for (const h of state.hunks) {
                h.status = 'pending';
                delete h.decidedAt;
              }
            }
          }
          break;
        }
        case 'turn-aborted':
          // Note the abort but keep replaying — a session can recover.
          break;
      }
    }

    if (!hadAnyEvent || turnId == null) return null;

    // Drift classification per file: read current disk content + compare.
    const diskReader = options?.readDiskFile ?? ((rel: string) => this.readWorkspaceFile(cwd, rel));
    const driftPerFile: Record<string, FileDriftStatus> = {};
    for (const [relPath, state] of files) {
      let drift: FileDriftStatus;
      try {
        const onDisk = await diskReader(relPath);
        if (onDisk == null) {
          drift = state.isDeleted ? 'clean' : 'missing';
        } else if (state.isBinary) {
          // Binary: can't hash UTF-8 → trust the recon if the file exists.
          drift = 'clean';
        } else {
          drift = sha256Hex(onDisk) === sha256Hex(state.afterContent) ? 'clean' : 'drifted';
        }
      } catch {
        drift = 'missing';
      }
      driftPerFile[relPath] = drift;
    }

    const reconstructedFiles: ReconstructedFileReview[] = [];
    const hunkSets: ReconstructedSessionReview['hunkSets'] = [];
    for (const [relPath, state] of files) {
      const filePath = this.joinCwd(cwd, relPath);
      if (filePath === null) {
        // joinCwd already logged the escape; skip this file so reconstruction
        // doesn't surface a path that points outside the workspace.
        continue;
      }
      reconstructedFiles.push({
        filePath,
        relPath,
        before: state.originalSnapshot,
        after: state.afterContent,
        isNew: state.isNew,
        isDeleted: state.isDeleted,
        isBinary: state.isBinary,
        ...(state.subagentId ? { subagentId: state.subagentId } : {}),
        hunks: state.hunks.map((h) => ({ ...h })),
      });
      hunkSets.push({
        filePath,
        originalSnapshot: state.originalSnapshot,
        allHunks: state.hunks.map((h) => ({
          index: h.index,
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          header: h.header,
          lines: h.lines.slice(),
        })),
        acceptedSet: Array.from(state.acceptedSet).sort((a, b) => a - b),
      });
    }

    return {
      sessionId,
      agentId,
      cwd,
      turnId,
      lastEventId,
      lastEventAt,
      files: reconstructedFiles,
      hunkSets,
      driftPerFile,
    };
  }

  private async safeReadBlob(sha: string): Promise<string> {
    try {
      return await this.blobs.read(sha);
    } catch (err) {
      this.opts.logger.warn('history', 'blob.read.failed', { sha, err: String(err) });
      return '';
    }
  }

  private async readWorkspaceFile(cwd: string, relPath: string): Promise<string | null> {
    const abs = this.joinCwd(cwd, relPath);
    if (abs === null) return null;
    try {
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Resolve `cwd + relPath` into an absolute path, rejecting attempts to
   * escape `cwd`. `relPath` is sourced from the persisted event log today
   * (extension-controlled), so this is defence-in-depth — but cheap and
   * future-proofs against any new code path that wires user-controlled
   * relative paths through here.
   */
  private joinCwd(cwd: string, relPath: string): string | null {
    const resolvedCwd = path.resolve(cwd);
    const abs = path.resolve(resolvedCwd, relPath);
    const rel = path.relative(resolvedCwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      this.opts.logger.warn('history', 'path.escape.rejected', { cwd: resolvedCwd, relPath });
      return null;
    }
    return abs;
  }

  /**
   * β.0 (10.1.8a): permanently delete a session from the event log.
   * Removes its segments and sweeps blobs that were *only* referenced by it.
   *
   * Cross-session safety
   * --------------------
   * The blob store is content-addressed; multiple sessions can reference
   * the same blob (e.g., identical `before` snapshots). We MUST NOT delete
   * a blob still referenced by another session, so the implementation scans
   * the surviving sessions' refs first and only sweeps blobs whose sole
   * referent was the doomed session.
   *
   * Best-effort on failure: partial state (segments gone, index unupdated)
   * could occur if the process crashes mid-operation. The next activation's
   * retention sweeper would notice the dangling index entry on subsequent
   * boot and clean up.
   */
  async deleteSession(sessionId: string): Promise<{ blobsDeleted: number }> {
    if (!this.opts.enabled) return { blobsDeleted: 0 };

    // 1. Collect blob refs from the session being deleted.
    const doomedBlobs = new Set<string>();
    for await (const ev of this.reader.readSession(sessionId)) {
      collectBlobRefs(ev, doomedBlobs);
    }

    // 2. Collect blob refs from every other session (must scan BEFORE
    //    deleting segments — otherwise we'd lose track of shared refs).
    const otherSessions = (await this.listSessions()).filter(
      (s) => s.sessionId !== sessionId,
    );
    const liveBlobs = new Set<string>();
    for (const s of otherSessions) {
      for await (const ev of this.reader.readSession(s.sessionId)) {
        collectBlobRefs(ev, liveBlobs);
      }
    }

    // 3. Delete this session's segments + drop the writer state.
    const writer = this.getWriter(sessionId);
    const segments = await writer.listSegments(sessionId);
    for (const seg of segments) {
      await fs.unlink(seg).catch(() => undefined);
    }
    this.writers.delete(sessionId);
    this.liveSessions.delete(sessionId);

    // 4. Sweep blobs whose sole referent was the deleted session.
    let blobsDeleted = 0;
    for (const sha of doomedBlobs) {
      if (!liveBlobs.has(sha)) {
        await this.blobs.delete(sha);
        blobsDeleted++;
      }
    }

    // 5. Drop from index + invalidate the aggregate cache so the status
    //    bar / openPanel probe pick up the change on the next call.
    await this.index.update((cur) => {
      cur.sessions = cur.sessions.filter((s) => s.sessionId !== sessionId);
    });
    this.pendingSummaryCache = null;
    this.emitChange({ sessionId, kind: 'session-deleted' });

    return { blobsDeleted };
  }

  // -- retention -----------------------------------------------------------

  /**
   * Delete sessions older than `retentionDays` and the blobs they
   * exclusively referenced. Returns the count of (sessions, blobs) removed
   * so the caller can log.
   */
  async sweep(retentionDays: number): Promise<{ sessions: number; blobs: number }> {
    if (!this.opts.enabled) return { sessions: 0, blobs: 0 };
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const idx = await this.index.read();
    const expired = idx.sessions.filter((s) => s.lastEventAt < cutoffMs);
    if (expired.length === 0) return { sessions: 0, blobs: 0 };

    // Collect blob refs from sessions we're keeping.
    const liveBlobs = new Set<string>();
    const kept = idx.sessions.filter((s) => s.lastEventAt >= cutoffMs);
    for (const s of kept) {
      for await (const ev of this.reader.readSession(s.sessionId)) {
        collectBlobRefs(ev, liveBlobs);
      }
    }

    // Delete each expired session's segments.
    for (const s of expired) {
      const segments = await (this.getWriter(s.sessionId)).listSegments(s.sessionId);
      for (const seg of segments) {
        await fs.unlink(seg).catch(() => undefined);
      }
      this.writers.delete(s.sessionId);
    }

    // Sweep blobs no longer referenced.
    let blobsDeleted = 0;
    for await (const blob of this.blobs.list()) {
      if (!liveBlobs.has(blob.sha)) {
        await this.blobs.delete(blob.sha);
        blobsDeleted++;
      }
    }

    await this.index.update((current) => {
      current.sessions = current.sessions.filter((s) => s.lastEventAt >= cutoffMs);
    });

    return { sessions: expired.length, blobs: blobsDeleted };
  }

  // -- internals -----------------------------------------------------------

  private getWriter(sessionId: string): HistoryWriter {
    let w = this.writers.get(sessionId);
    if (!w) {
      w = new HistoryWriter({ root: this.root, sessionId });
      this.writers.set(sessionId, w);
    }
    return w;
  }

  private async upsertIndexEntry(
    sessionId: string,
    agentId: AgentId,
    incrementTurn: boolean,
    lastMsg: string | null,
  ): Promise<void> {
    const now = Date.now();
    const existing = this.liveSessions.get(sessionId);
    const entry: SessionIndexEntry = existing ?? {
      sessionId,
      status: 'open',
      agentId,
      startedAt: now,
      lastEventAt: now,
      lastMessage: null,
      turnCount: 0,
      hasOpenTurn: false,
      pendingHunkCount: null,
    };
    if (incrementTurn) entry.turnCount += 1;
    entry.status = 'open';
    entry.lastEventAt = now;
    if (lastMsg !== null) entry.lastMessage = lastMsg;
    // β.0 (10.1.2): turn-started → hasOpenTurn true; pendingHunkCount stale.
    entry.hasOpenTurn = true;
    entry.pendingHunkCount = null;
    this.liveSessions.set(sessionId, entry);
    await this.index.upsertSession(entry);
  }

  private async markSessionClosed(
    sessionId: string,
    agentId: AgentId,
    lastMsg: string | null,
  ): Promise<void> {
    const now = Date.now();
    const entry = this.liveSessions.get(sessionId) ?? {
      sessionId,
      status: 'closed' as const,
      agentId,
      startedAt: now,
      lastEventAt: now,
      lastMessage: lastMsg,
      turnCount: 1,
      hasOpenTurn: false,
      pendingHunkCount: null,
    };
    entry.status = 'closed';
    entry.lastEventAt = now;
    entry.lastMessage = lastMsg;
    // β.0 (10.1.2): turn-stopped → close the open turn; pendingHunkCount stale
    // (every hunk Claude produced this turn is now pending review).
    entry.hasOpenTurn = false;
    entry.pendingHunkCount = null;
    this.liveSessions.set(sessionId, entry);
    await this.index.upsertSession(entry);
  }

  /**
   * β.0 (10.1.2): lazy-compute or return cached pending hunk count for a
   * session. A hunk is "pending" if it appeared in the most recent
   * turn-stopped event for its (sessionId, path) pair and was NOT
   * subsequently decided (hunk-decided), file-reverted, or undone.
   *
   * Strategy: stream-replay the session and maintain per-(path, hunkIdx)
   * status. After the walk, count hunks still 'pending'. Cache on the entry
   * so subsequent reads are O(1) until the next write invalidates.
   *
   * Bounded by the session's event count — typically tens to low hundreds.
   * Replaces the per-session O(S × E) scan the toast emitted at activation.
   */
  async getPendingHunkCount(sessionId: string): Promise<number> {
    const idx = await this.index.read();
    const entry = idx.sessions.find((s) => s.sessionId === sessionId);
    if (!entry) return 0;
    if (entry.pendingHunkCount != null) return entry.pendingHunkCount;

    // Replay to compute.
    type HunkKey = string; // `${path}::${hunkIdx}`
    const pending = new Set<HunkKey>();
    // Track last turnId-per-path so a new turn re-seeds (i.e., subsequent
    // turns' hunks supersede the prior — but in v0.2 each turn is a new
    // review surface; an unfinished prior turn carries its pending count).
    for await (const ev of this.reader.readSession(sessionId)) {
      switch (ev.kind) {
        case 'turn-stopped':
          for (const f of ev.files) {
            for (const h of f.hunks) pending.add(`${f.path}::${h.idx}`);
          }
          break;
        case 'hunk-decided':
          pending.delete(`${ev.path}::${ev.hunkIdx}`);
          break;
        case 'file-snapshot-reverted':
          // Every hunk for this file in the most recent turn is decided (rejected).
          for (const k of Array.from(pending)) {
            if (k.startsWith(`${ev.path}::`)) pending.delete(k);
          }
          break;
        case 'undo':
          // Reverse decisions per scope. For scope:'hunk' with a specific
          // path+hunkIdx, the undone hunk flips back to pending.
          if (ev.scope === 'hunk' && ev.target.path && ev.target.hunkIdx !== undefined) {
            pending.add(`${ev.target.path}::${ev.target.hunkIdx}`);
          } else if (ev.scope === 'file' && ev.target.path) {
            // File-scope undo: don't have per-hunk granularity in the event,
            // so leave the count slightly stale (≥ true count) — better than
            // a full session re-replay and accurate enough for status bar.
            // Future: emit per-hunk undo when scope='file' to refine.
          }
          break;
        case 'turn-started':
        case 'turn-aborted':
          break;
      }
    }
    const count = pending.size;
    // Write-through to entry cache.
    const live = this.liveSessions.get(sessionId);
    if (live) {
      live.pendingHunkCount = count;
      this.liveSessions.set(sessionId, live);
      await this.index.upsertSession(live);
    } else {
      // Not currently tracked in liveSessions — persist via index update.
      const fresh: SessionIndexEntry = { ...entry, pendingHunkCount: count };
      await this.index.upsertSession(fresh);
    }
    return count;
  }

  /**
   * β.0 (10.1.2): invalidate the cached pending count for a session.
   * Called from `recordHunkDecided` and `recordUndo` write paths so the
   * next `getPendingReviewsSummary` recomputes from the segments.
   */
  private async invalidatePendingHunkCount(sessionId: string): Promise<void> {
    const entry = this.liveSessions.get(sessionId);
    if (entry && entry.pendingHunkCount !== null) {
      entry.pendingHunkCount = null;
      this.liveSessions.set(sessionId, entry);
      // Persist only if it changed something callers will read soon.
      await this.index.upsertSession(entry);
    }
    // β.0 (10.1.5b): the per-session change always invalidates the aggregate.
    this.pendingSummaryCache = null;
  }

  /**
   * β.0 (10.1.5b): aggregate "what's pending review across all recent sessions"
   * view, composed from `listSessions()` + per-session `getPendingHunkCount`.
   * Drives the status bar pending-count indicator and the `Open Review Panel`
   * resume prompt.
   *
   * Implementation notes
   * --------------------
   * 1. Filter by `withinMs` (default 7 days) to bound the work — older sessions
   *    are out of resume scope per the existing crash-recovery probe semantics.
   * 2. Exclude `status === 'aborted'` sessions — those were explicitly torn down
   *    (window-closed reason, extension deactivated, etc.). Open / closed both
   *    qualify: an unfinished closed session is the central β.0 use case.
   * 3. Use cached `pendingHunkCount` from the index when present (the lazy
   *    cache is maintained by `getPendingHunkCount`); fall back to a fresh
   *    replay otherwise.
   * 4. `totalCount` is the size of the most recent turn-stopped's hunks list
   *    — derived via a single stream scan alongside the pending count.
   * 5. 1-second TTL cache on the whole result absorbs the recompute storm
   *    when the status bar + openPanel command both fire within the same tick.
   */
  async getPendingReviewsSummary(opts?: {
    withinMs?: number;
    topN?: number;
  }): Promise<PendingReviewsSummary> {
    const now = Date.now();
    if (this.pendingSummaryCache && this.pendingSummaryCache.expiresAt > now) {
      return this.pendingSummaryCache.value;
    }

    const withinMs = opts?.withinMs ?? 7 * 24 * 60 * 60 * 1000;
    const topN     = opts?.topN     ?? 5;
    const cutoff   = now - withinMs;

    const sessions = await this.listSessions();
    const recoverable = sessions.filter(
      (s) => s.lastEventAt >= cutoff && s.status !== 'aborted',
    );

    const enriched = await Promise.all(
      recoverable.map(async (s) => {
        const { pending, total } = await this.computePendingAndTotal(s);
        return {
          sessionId: s.sessionId,
          agentId: s.agentId,
          pendingCount: pending,
          totalCount: total,
          lastEventAt: s.lastEventAt,
          status: s.status,
        };
      }),
    );

    const withPending = enriched.filter((e) => e.pendingCount > 0);
    const summary: PendingReviewsSummary = {
      totalSessions: withPending.length,
      totalPendingHunks: withPending.reduce((sum, e) => sum + e.pendingCount, 0),
      sessions: withPending
        .sort((a, b) => b.lastEventAt - a.lastEventAt)
        .slice(0, topN),
    };

    this.pendingSummaryCache = {
      value: summary,
      expiresAt: now + HistoryService.PENDING_SUMMARY_TTL_MS,
    };
    return summary;
  }

  /**
   * Single-pass computation of (pending, total) for a session. `pending` uses
   * the same replay semantics as `getPendingHunkCount`; `total` is the count of
   * hunks in the most recent `turn-stopped` (or the running total across turns
   * if multiple turn-stoppeds exist, which matches the v0.2 surface).
   */
  private async computePendingAndTotal(
    entry: SessionIndexEntry,
  ): Promise<{ pending: number; total: number }> {
    // Fast path: cached pending count + a single scan for total only.
    if (entry.pendingHunkCount != null) {
      let total = 0;
      for await (const ev of this.reader.readSession(entry.sessionId)) {
        if (ev.kind === 'turn-stopped') {
          for (const f of ev.files) total += f.hunks.length;
        }
      }
      return { pending: entry.pendingHunkCount, total };
    }
    // Slow path: replay once, compute both.
    type HunkKey = string;
    const pendingSet = new Set<HunkKey>();
    let total = 0;
    for await (const ev of this.reader.readSession(entry.sessionId)) {
      switch (ev.kind) {
        case 'turn-stopped':
          for (const f of ev.files) {
            total += f.hunks.length;
            for (const h of f.hunks) pendingSet.add(`${f.path}::${h.idx}`);
          }
          break;
        case 'hunk-decided':
          pendingSet.delete(`${ev.path}::${ev.hunkIdx}`);
          break;
        case 'file-snapshot-reverted':
          for (const k of Array.from(pendingSet)) {
            if (k.startsWith(`${ev.path}::`)) pendingSet.delete(k);
          }
          break;
        case 'undo':
          if (ev.scope === 'hunk' && ev.target.path && ev.target.hunkIdx !== undefined) {
            pendingSet.add(`${ev.target.path}::${ev.target.hunkIdx}`);
          }
          break;
        case 'turn-started':
        case 'turn-aborted':
          break;
      }
    }
    return { pending: pendingSet.size, total };
  }
}

/**
 * Resolves the history root directory for a (scope, workspaceRoot) pair.
 * - user scope:      `~/.claude/review-history/<sha256(workspace)[:16]>/`
 * - workspace scope: `<workspaceRoot>/.claude/review-history/`
 */
export function resolveHistoryRoot(scope: InstallScope, workspaceRoot: string): string {
  if (scope === 'user') {
    const hash = sha256Hex(path.resolve(workspaceRoot)).slice(0, 16);
    return path.join(os.homedir(), '.claude', 'review-history', hash);
  }
  return path.join(workspaceRoot, '.claude', 'review-history');
}

function truncateMessage(msg: string | null): string | null {
  if (msg == null) return null;
  if (Buffer.byteLength(msg, 'utf8') <= LAST_MESSAGE_CAP_BYTES) return msg;
  // Truncate by bytes then trim a likely-broken trailing UTF-8 sequence.
  const buf = Buffer.from(msg, 'utf8').subarray(0, LAST_MESSAGE_CAP_BYTES);
  return buf.toString('utf8') + ' …(truncated)';
}

function collectBlobRefs(ev: HistoryEvent, sink: Set<string>): void {
  switch (ev.kind) {
    case 'turn-started':
      for (const f of ev.files) if (f.beforeBlob) sink.add(f.beforeBlob);
      return;
    case 'turn-stopped':
      for (const f of ev.files) if (f.afterBlob) sink.add(f.afterBlob);
      return;
    case 'hunk-decided':
      if (ev.postBlob) sink.add(ev.postBlob);
      return;
    case 'file-snapshot-reverted':
      sink.add(ev.postBlob);
      return;
    case 'undo':
      for (const b of Object.values(ev.postBlobs)) sink.add(b);
      return;
    case 'turn-aborted':
      return;
  }
}

// Suppress unused-import lint without affecting runtime.
void crypto;
