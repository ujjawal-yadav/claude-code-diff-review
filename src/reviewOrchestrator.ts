import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { computeDiff, revertHunk } from './diffEngine.js';
import { Logger } from './logger.js';
import { SnapshotStore } from './snapshotStore.js';
import {
  asAbsPath,
  asSessionId,
  AbsPath,
  ComputedDiff,
  FileReview,
  FileStatus,
  HunkReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
  StructuredHunk,
} from './types.js';

/**
 * Workflow coordinator (TRD §5.6, §8).
 *
 * Responsibilities
 * ----------------
 *  - On Stop hook: build SessionReview from snapshot store + on-disk state,
 *    compute structured diffs, hand off to ReviewPanel.
 *  - On hunk action: accept (no-op on disk) / reject (revert one hunk to disk).
 *  - On bulk action: walk files & apply.
 *  - Debounce re-diff on save.
 *  - Circuit-breaker against pathological reopen storms.
 *
 * Pure-ish: all VS Code surface area is injected via the `panel` and
 * `writeFile` callbacks, which makes the orchestrator unit-testable without
 * spinning up Electron.
 */

const REOPEN_WINDOW_MS    = 60_000;
const REOPEN_LIMIT        = 5;
const STOP_DEBOUNCE_MS    = 250;
const RE_DIFF_DEBOUNCE_MS = 200;

export interface PanelGateway {
  openOrFocus(session: SessionReview): Promise<void>;
  postFileUpdated(filePath: AbsPath, file: FileReview): void;
  postHunkApplied(filePath: AbsPath, hunkIndex: number, status: HunkStatus): void;
  postSessionCompleted(sessionId: SessionId, metrics: SessionMetrics): void;
  close(sessionId: SessionId): void;
}

export interface OrchestratorOptions {
  store: SnapshotStore;
  panel: PanelGateway;
  logger: Logger;
  /** Injected file writer; default: `fs.writeFile`. Tests can override. */
  writeFile?: (absPath: AbsPath, content: string) => Promise<void>;
  /** Override the on-disk read; default: `fs.readFile(... 'utf8')`. */
  readFile?:  (absPath: AbsPath) => Promise<string>;
  /**
   * Optional callback fired whenever a session's review state changes
   * (open / hunk action / bulk action / file update / dismiss).
   * Used by the CodeLens provider to refresh gutter widgets.
   */
  onChange?: () => void;
}

export class ReviewOrchestrator {
  private readonly sessions = new Map<SessionId, SessionReview>();
  private readonly stopDebounce = new Map<SessionId, NodeJS.Timeout>();
  private readonly reopenWindow = new Map<SessionId, number[]>();
  private readonly reDiffTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Per-file Promise-chain mutex. Every action that mutates a file's
   * on-disk state OR its in-memory FileReview goes through this so two
   * concurrent clicks (panel + CodeLens, two reject-hunks) cannot
   * race-write and clobber each other.
   *
   * Different files run in parallel; same-file actions serialise.
   */
  private readonly fileLocks = new Map<AbsPath, Promise<unknown>>();

  /**
   * Denormalised lookup indexes. Both share references with `session.files`,
   * so any in-place mutation to a `FileReview` (e.g. `hunk.status = ...`)
   * is visible everywhere. Maintained only on session lifecycle (open /
   * dismiss); the per-action hot path does O(1) reads against them.
   *
   * `byPath` — per-session lookup: `(sid, absPath) → FileReview`.
   * `globalByPath` — cross-session lookup used by CodeLens to answer
   *   "which session(s) currently track this file?" without scanning every
   *   session's files array. Keyed by absPath; value carries sessionId so
   *   the caller can also resolve the SessionReview.
   */
  private readonly byPath = new Map<SessionId, Map<AbsPath, FileReview>>();
  private readonly globalByPath = new Map<AbsPath, { sessionId: SessionId; file: FileReview }>();

  private readonly write: NonNullable<OrchestratorOptions['writeFile']>;
  private readonly read:  NonNullable<OrchestratorOptions['readFile']>;

  constructor(private readonly opts: OrchestratorOptions) {
    this.write = opts.writeFile ?? defaultWrite;
    this.read  = opts.readFile  ?? defaultRead;
  }

  private notifyChange(): void {
    try { this.opts.onChange?.(); }
    catch (err) { this.opts.logger.warn('orchestrator', 'onChange.error', { err: String(err) }); }
  }

  /**
   * Run `fn` while holding an exclusive lock for `filePath`. Other lock
   * acquisitions on the same path queue behind this one. Errors do not
   * poison the chain — the next caller still proceeds.
   */
  private lockFile<T>(filePath: AbsPath, fn: () => Promise<T>): Promise<T> {
    const prior = this.fileLocks.get(filePath) ?? Promise.resolve();
    const swallow = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);
    const next = prior.then(() => fn(), () => fn());
    this.fileLocks.set(filePath, swallow(next));
    return next;
  }

  /** Stop hook entry. Debounces sub-agent multi-stop bursts. */
  handleStop(sessionId: string, stopHookActive: boolean, lastAssistantMessage: string | null): void {
    if (stopHookActive) {
      this.opts.logger.debug('orchestrator', 'stop.gated');
      return;
    }
    const sid = asSessionId(sessionId);
    const existing = this.stopDebounce.get(sid);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.stopDebounce.delete(sid);
      this.openReview(sid, lastAssistantMessage).catch((err) => {
        this.opts.logger.error('orchestrator', 'open.error', { sid, err: String(err) });
      });
    }, STOP_DEBOUNCE_MS);
    this.stopDebounce.set(sid, t);
  }

  /** Re-diff a single file (debounced) — call from onDidSaveTextDocument. */
  scheduleReDiff(sessionId: string, filePath: AbsPath): void {
    const key = `${sessionId}::${filePath}`;
    const prior = this.reDiffTimers.get(key);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      this.reDiffTimers.delete(key);
      this.reDiff(asSessionId(sessionId), filePath).catch((err) => {
        this.opts.logger.error('orchestrator', 'rediff.error', { err: String(err) });
      });
    }, RE_DIFF_DEBOUNCE_MS);
    this.reDiffTimers.set(key, t);
  }

  async handleHunkAction(
    sessionId: string,
    filePath: string,
    hunkIndex: number,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const sid = asSessionId(sessionId);
    const review = this.sessions.get(sid);
    if (!review) {
      this.opts.logger.warn('orchestrator', 'action.no-session', { sid });
      return;
    }
    const absFile = asAbsPath(filePath);
    const file = this.getFile(sid, absFile);
    if (!file) {
      this.opts.logger.warn('orchestrator', 'action.no-file', { sid, filePath });
      return;
    }

    await this.lockFile(absFile, async () => {
      // Re-read hunk under the lock — state may have changed while we waited.
      const hunk = file.hunks[hunkIndex];
      if (!hunk || hunk.status !== 'pending') return;

      if (action === 'reject') {
        const result = await this.applyReject(file, hunk);
        if (!result.ok) {
          // Hunk stays pending; warning surfaced inside applyReject.
          return;
        }
      }

      hunk.status = action === 'accept' ? 'accepted' : 'rejected';
      hunk.decidedAt = Date.now();
      file.status = recomputeFileStatus(file.hunks);
      review.metrics = recomputeMetrics(review.files);
      this.opts.panel.postHunkApplied(absFile, hunkIndex, hunk.status);
      this.notifyChange();
      this.maybeComplete(review);
    });
  }

  async handleBulk(
    sessionId: string,
    scope: 'file' | 'session',
    action: 'accept' | 'reject',
    filePath?: string,
  ): Promise<void> {
    const sid = asSessionId(sessionId);
    const review = this.sessions.get(sid);
    if (!review) return;

    let targetFiles: FileReview[];
    if (scope === 'session') {
      targetFiles = review.files;
    } else {
      const f = filePath ? this.getFile(sid, asAbsPath(filePath)) : undefined;
      targetFiles = f ? [f] : [];
    }

    // Different files run under distinct locks ⇒ parallelisable. Same-file
    // contention queues behind this. We await Promise.all so every file's
    // disk write completes before we notify and check completion.
    await Promise.all(targetFiles.map((file) => this.lockFile(file.filePath, async () => {
      const everyHunkPending = file.hunks.length > 0 && file.hunks.every((h) => h.status === 'pending');

      // Fast path: when rejecting EVERY pending hunk in a file, skip
      // per-hunk reverse-patch (which can drift across hunks) and just
      // write the captured snapshot directly. Identical end state, more
      // robust against context drift.
      if (action === 'reject' && everyHunkPending) {
        try {
          await this.write(file.filePath, file.before);
          file.after = file.before;
          for (const h of file.hunks) {
            if (h.status === 'pending') { h.status = 'rejected'; h.decidedAt = Date.now(); }
          }
        } catch (err) {
          this.markWriteFailed(file, err);
          this.opts.panel.postFileUpdated(file.filePath, file);
          return;
        }
      } else {
        for (let i = 0; i < file.hunks.length; i++) {
          const h = file.hunks[i];
          if (h.status !== 'pending') continue;
          if (action === 'reject') {
            const result = await this.applyReject(file, h);
            if (!result.ok) continue; // stays pending; warning is on the file
          }
          h.status = action === 'accept' ? 'accepted' : 'rejected';
          h.decidedAt = Date.now();
        }
      }
      file.status = recomputeFileStatus(file.hunks);
      this.opts.panel.postFileUpdated(file.filePath, file);
    })));

    review.metrics = recomputeMetrics(review.files);
    this.notifyChange();
    this.maybeComplete(review);
  }

  dismissSession(sessionId: string): void {
    const sid = asSessionId(sessionId);
    this.opts.panel.close(sid);
    this.sessions.delete(sid);
    this.unindexSession(sid);
    this.opts.store.release(sid);
    this.opts.logger.info('orchestrator', 'session.dismissed', { sid });
    this.notifyChange();
  }

  /**
   * Catastrophic-failure escape hatch (TRD §13 NFR-2.2).
   *
   * Writes the captured original (`file.before`) back to disk and marks
   * every hunk as rejected. Used when `revertHunk` fuzz-fails — typically
   * when a formatter ran after Claude's edit and the post-edit content has
   * drifted too far for a per-hunk reverse patch to apply.
   */
  async revertFileToSnapshot(sessionId: string, filePath: string): Promise<void> {
    const sid = asSessionId(sessionId);
    const review = this.sessions.get(sid);
    if (!review) return;
    const absFile = asAbsPath(filePath);
    const file = this.getFile(sid, absFile);
    if (!file) return;

    await this.lockFile(absFile, async () => {
      try {
        await this.write(absFile, file.before);
      } catch (err) {
        this.markWriteFailed(file, err);
        this.opts.panel.postFileUpdated(absFile, file);
        return;
      }
      file.after = file.before;
      for (const h of file.hunks) {
        if (h.status === 'pending') {
          h.status = 'rejected';
          h.decidedAt = Date.now();
        }
      }
      file.status = recomputeFileStatus(file.hunks);
      file.warnings = file.warnings.filter((w) => w !== 'fuzz-failed-revert' && w !== 'write-failed' && w !== 'read-failed');
      review.metrics = recomputeMetrics(review.files);
      this.opts.panel.postFileUpdated(absFile, file);
      this.opts.logger.info('orchestrator', 'file.snapshot-reverted', { file: absFile });
      this.notifyChange();
      this.maybeComplete(review);
    });
  }

  /** Test/inspection helper. */
  getSession(sessionId: string): SessionReview | undefined {
    return this.sessions.get(asSessionId(sessionId));
  }

  /** List sessionIds with an open or completed review. */
  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * O(1) cross-session lookup: "which session currently tracks this file?".
   * Used by `HunkCodeLensProvider` to avoid scanning every session.
   */
  findFile(filePath: string): { session: SessionReview; file: FileReview } | null {
    const hit = this.globalByPath.get(filePath as AbsPath);
    if (!hit) return null;
    const session = this.sessions.get(hit.sessionId);
    if (!session) return null;
    return { session, file: hit.file };
  }

  // -- denormalised index maintenance ----------------------------------------

  private indexFiles(sid: SessionId, files: FileReview[]): void {
    this.unindexSession(sid);
    const perSession = new Map<AbsPath, FileReview>();
    this.byPath.set(sid, perSession);
    for (const file of files) {
      perSession.set(file.filePath, file);
      // Last-write-wins on cross-session collisions. Multi-session edits to
      // the same file are rare and the CodeLens caller can iterate sessions
      // explicitly if it needs both. Documented in TRD §21 OTQ-1.
      this.globalByPath.set(file.filePath, { sessionId: sid, file });
    }
  }

  private unindexSession(sid: SessionId): void {
    const existing = this.byPath.get(sid);
    if (!existing) return;
    for (const absPath of existing.keys()) {
      const slot = this.globalByPath.get(absPath);
      if (slot && slot.sessionId === sid) this.globalByPath.delete(absPath);
    }
    this.byPath.delete(sid);
  }

  private getFile(sid: SessionId, absPath: AbsPath): FileReview | undefined {
    return this.byPath.get(sid)?.get(absPath);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async openReview(sid: SessionId, lastAssistantMessage: string | null): Promise<void> {
    if (this.tripCircuitBreaker(sid)) {
      this.opts.logger.error('orchestrator', 'circuit.tripped', { sid });
      return;
    }

    const sessionData = this.opts.store.get(sid);
    if (!sessionData || sessionData.touched.size === 0) {
      this.opts.logger.info('orchestrator', 'open.no-changes', { sid });
      return;
    }

    const files: FileReview[] = [];
    for (const absPath of sessionData.touched) {
      const before = sessionData.originals.get(absPath) ?? '';
      let after: string;
      try {
        after = await this.read(absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          after = ''; // deleted
        } else {
          this.opts.logger.warn('orchestrator', 'read.error', { absPath, err: String(err) });
          continue;
        }
      }
      const diff = computeDiff(absPath, before, after);
      files.push(toFileReview(diff, sessionData.cwd, sessionData.overBudget));
    }

    const review: SessionReview = {
      agentId: sessionData.agentId,
      sessionId: sid,
      cwd: sessionData.cwd,
      startedAt: sessionData.startedAt,
      openedAt: Date.now(),
      lastAssistantMessage,
      files,
      state: 'open',
      metrics: recomputeMetrics(files),
    };
    this.sessions.set(sid, review);
    this.indexFiles(sid, files);
    await this.opts.panel.openOrFocus(review);
    this.opts.logger.info('orchestrator', 'review.opened', {
      sid,
      files: files.length,
      hunks: review.metrics.totalHunks,
    });
    this.notifyChange();
  }

  private async applyReject(file: FileReview, hunk: HunkReview): Promise<{ ok: true } | { ok: false; reason: 'fuzz' | 'fs' }> {
    let current: string;
    try {
      current = await this.read(file.filePath);
    } catch (err) {
      file.warnings = uniqueWarnings([...file.warnings, 'read-failed']);
      this.opts.panel.postFileUpdated(file.filePath, file);
      this.opts.logger.error('orchestrator', 'reject.read-failed', { file: file.filePath, err: String(err) });
      return { ok: false, reason: 'fs' };
    }

    const result = revertHunk(current, hunkAsStructured(hunk));
    if (!result.ok) {
      file.warnings = uniqueWarnings([...file.warnings, 'fuzz-failed-revert']);
      this.opts.panel.postFileUpdated(file.filePath, file);
      this.opts.logger.warn('orchestrator', 'reject.fuzz-fail', { file: file.filePath, hunk: hunk.index });
      return { ok: false, reason: 'fuzz' };
    }

    try {
      await this.write(file.filePath, result.newContent);
    } catch (err) {
      this.markWriteFailed(file, err);
      this.opts.panel.postFileUpdated(file.filePath, file);
      return { ok: false, reason: 'fs' };
    }
    file.after = result.newContent;
    // Successful write clears any prior FS-failure warning so the banner disappears.
    if (file.warnings.includes('write-failed') || file.warnings.includes('read-failed')) {
      file.warnings = file.warnings.filter((w) => w !== 'write-failed' && w !== 'read-failed');
    }
    return { ok: true };
  }

  private markWriteFailed(file: FileReview, err: unknown): void {
    file.warnings = uniqueWarnings([...file.warnings, 'write-failed']);
    this.opts.logger.error('orchestrator', 'write.failed', { file: file.filePath, err: String(err) });
  }

  private async reDiff(sid: SessionId, absPath: AbsPath): Promise<void> {
    const review = this.sessions.get(sid);
    if (!review) return;
    const file = this.getFile(sid, absPath);
    if (!file) return;
    let after: string;
    try {
      after = await this.read(absPath);
    } catch {
      return;
    }
    const diff = computeDiff(absPath, file.before, after);
    const refreshed = toFileReview(diff, review.cwd, false);
    // Preserve human decisions where index alignment still applies.
    refreshed.hunks = refreshed.hunks.map((h) => {
      const prior = file.hunks[h.index];
      if (prior && hunksAlignedShallow(prior, h)) {
        const merged: HunkReview = { ...h, status: prior.status };
        if (prior.decidedAt != null) merged.decidedAt = prior.decidedAt;
        return merged;
      }
      return h;
    });
    // Drop fuzz-failed-revert when we re-diff: a successful re-diff makes
    // that warning stale (the file may have been hand-fixed).
    refreshed.warnings = uniqueWarnings([
      ...file.warnings.filter((w) => w !== 'fuzz-failed-revert'),
      'external-edit',
    ]);
    Object.assign(file, refreshed);
    file.status = recomputeFileStatus(file.hunks);
    this.opts.panel.postFileUpdated(absPath, file);
    this.notifyChange();
  }

  private maybeComplete(review: SessionReview): void {
    const allDecided = review.files.every((f) => f.hunks.every((h) => h.status !== 'pending'));
    if (!allDecided) return;
    review.state = 'completed';
    this.opts.panel.postSessionCompleted(review.sessionId, review.metrics);
    this.opts.logger.info('orchestrator', 'session.completed', { sid: review.sessionId, metrics: review.metrics });
  }

  /** Returns true if the breaker is tripped for this session. */
  private tripCircuitBreaker(sid: SessionId): boolean {
    const now = Date.now();
    const window = (this.reopenWindow.get(sid) ?? []).filter((t) => now - t < REOPEN_WINDOW_MS);
    window.push(now);
    this.reopenWindow.set(sid, window);
    return window.length > REOPEN_LIMIT;
  }
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function defaultRead(absPath: AbsPath): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

async function defaultWrite(absPath: AbsPath, content: string): Promise<void> {
  await fs.writeFile(absPath, content, 'utf8');
}

function toFileReview(diff: ComputedDiff, cwd: string, overBudget: boolean): FileReview {
  const warnings: FileReview['warnings'] = [];
  if (overBudget) warnings.push('snapshot-truncated');
  if (diff.isBinary) warnings.push('binary-file');
  const hunks: HunkReview[] = diff.hunks.map((h) => ({
    index: h.index,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    header: h.header,
    lines: h.lines,
    status: 'pending' as HunkStatus,
  }));
  return {
    filePath: diff.filePath,
    relPath: relativePathSafe(cwd, diff.filePath),
    before: diff.before,
    after: diff.after,
    hunks,
    status: hunks.length === 0 ? 'accepted' : 'pending',
    isNew: diff.isNew,
    isDeleted: diff.isDeleted,
    isBinary: diff.isBinary,
    warnings,
  };
}

function relativePathSafe(cwd: string, absPath: string): string {
  const r = path.relative(cwd, absPath);
  return r.length === 0 || r.startsWith('..') ? absPath : r.replace(/\\/g, '/');
}

function recomputeFileStatus(hunks: HunkReview[]): FileStatus {
  if (hunks.length === 0) return 'accepted';
  let acc = 0, rej = 0, pen = 0;
  for (const h of hunks) {
    if (h.status === 'accepted') acc++;
    else if (h.status === 'rejected') rej++;
    else pen++;
  }
  if (pen > 0) {
    return acc + rej > 0 ? 'partial' : 'pending';
  }
  if (acc > 0 && rej > 0) return 'partial';
  if (rej > 0) return 'rejected';
  return 'accepted';
}

function recomputeMetrics(files: FileReview[]): SessionMetrics {
  let total = 0, accepted = 0, rejected = 0, bytes = 0;
  for (const f of files) {
    bytes += Buffer.byteLength(f.before, 'utf8');
    for (const h of f.hunks) {
      total++;
      if (h.status === 'accepted') accepted++;
      else if (h.status === 'rejected') rejected++;
    }
  }
  return { totalHunks: total, acceptedHunks: accepted, rejectedHunks: rejected, bytesSnapshotted: bytes };
}

function hunkAsStructured(h: HunkReview): StructuredHunk {
  return {
    index: h.index,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    header: h.header,
    lines: h.lines,
  };
}

function hunksAlignedShallow(a: HunkReview, b: HunkReview): boolean {
  return a.oldStart === b.oldStart && a.oldLines === b.oldLines && a.lines.join('\n') === b.lines.join('\n');
}

function uniqueWarnings<T extends string>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/** Exported for unit tests. */
export const __test = { recomputeFileStatus, recomputeMetrics, relativePathSafe };
