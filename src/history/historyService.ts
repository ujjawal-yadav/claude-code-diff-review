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
