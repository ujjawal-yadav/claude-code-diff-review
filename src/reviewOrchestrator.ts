import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { computeDiff } from './diffEngine.js';
import { flagFile, flagHunk } from './riskFlagger.js';
import { initialHunkSetState, renderFileFromHunkSet } from './core/hunkSet.js';
import type { HistoryService } from './history/historyService.js';
import type { ReconstructedSessionReview } from './history/historyTypes.js';
import { Logger } from './logger.js';
import { SnapshotStore } from './snapshotStore.js';
import {
  asAbsPath,
  asSessionId,
  AbsPath,
  ComputedDiff,
  FileReview,
  FileStatus,
  FileWarning,
  HunkReview,
  HunkSetState,
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
  /**
   * β.0 multi-panel correctness: the three file-targeted post helpers now
   * carry `sessionId` explicitly. The orchestrator knows it at every call
   * site (we're always inside a `handleHunkAction(sid, ...)` /
   * `handleBulk(sid, ...)` / `reDiff(sid, ...)` / similar), so this is
   * pure plumbing. The earlier `findSessionForFile` lookup-via-globalByPath
   * routed wrong when two sessions touched the same file (last-write-wins
   * in `indexFiles`). Explicit sid eliminates the class.
   */
  postFileUpdated(sessionId: SessionId, filePath: AbsPath, file: FileReview): void;
  postHunkApplied(sessionId: SessionId, filePath: AbsPath, hunkIndex: number, status: HunkStatus): void;
  postSessionCompleted(sessionId: SessionId, metrics: SessionMetrics): void;
  /**
   * Phase α Track 6: surface a set-conflict from the set-based renderer.
   * The orchestrator has already reverted the offending set change; the
   * webview is responsible for the UX (banner + "re-accept coupled hunks").
   */
  postSetConflict(sessionId: SessionId, filePath: AbsPath, attemptedHunkIndex: number, conflictingHunks: number[]): void;
  /** Option A: tell the webview the current undo-stack depth (0 ⇒ disable ↶). */
  postUndoStackDepth(sessionId: SessionId, depth: number): void;
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
  /**
   * Phase α Track 1 — Memory Design event log. When provided, the
   * orchestrator records turn-started / turn-stopped / hunk-decided /
   * file-snapshot-reverted events. When absent (e.g. in unit tests),
   * all set-based behaviour still works; the log is just not written.
   */
  history?: HistoryService;
  /**
   * Phase α: agent identity stamped on every event in the log. Defaults
   * to 'claude-code' (the v0.1.0 single-agent assumption). Track 3 will
   * dispatch on incoming agentId from the adapter layer.
   */
  agentId?: 'claude-code' | 'opencode';
  /**
   * M9.6: fired AFTER a session has been removed from orchestrator state.
   * Used by extension.ts to clear adapter-level per-session caches (e.g.
   * the sub-agent task cache) so memory stays bounded.
   */
  onDismissSession?: (sessionId: string) => void;
  /**
   * v0.3: when true, run `flagFile` / `flagHunk` heuristics in `openReview`
   * and attach `flags` to FileReview / HunkReview. Default behavior at
   * orchestrator level is "off" (false) — extension.ts threads the user's
   * `claudeReview.riskFlags.enabled` config in. Off means no chips render.
   */
  riskFlagsEnabled?: boolean;
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

  /**
   * Set-based reversibility state (Phase α Track 6 — PHASE-ALPHA-IMMEDIATE.md §8).
   *
   * Per-(session, file) `HunkSetState` carrying the original snapshot and
   * the currently-accepted hunk indices. Lives host-side only — Sets do
   * not survive structured-clone over `postMessage`. The webview consumes
   * the derived `HunkReview.status` field which the host maintains in
   * lockstep with `acceptedSet`.
   *
   * Replaces the v0.1.0 sequential disk-mutation pipeline: every action
   * now (a) toggles set membership, (b) re-renders from the snapshot,
   * (c) writes the rendered bytes, (d) updates `HunkReview.status`. Zero
   * drift across N toggles of the same hunk.
   */
  private readonly hunkSets = new Map<SessionId, Map<AbsPath, HunkSetState>>();

  /**
   * Option A: per-session undo stack. Every mutating action (hunk decision,
   * bulk file/session, snapshot-revert, per-hunk undo) pushes a snapshot
   * BEFORE mutating. `handleUndoLastAction` pops the top and restores
   * acceptedSet + hunk statuses + on-disk content for every affected file.
   * Capped to bound memory; oldest entries drop when the cap is reached.
   */
  private readonly undoStack = new Map<SessionId, UndoSnapshot[]>();
  private static readonly UNDO_STACK_CAP = 50;

  private readonly write: NonNullable<OrchestratorOptions['writeFile']>;
  private readonly read:  NonNullable<OrchestratorOptions['readFile']>;
  private readonly agentId: 'claude-code' | 'opencode';

  constructor(private readonly opts: OrchestratorOptions) {
    this.write = opts.writeFile ?? defaultWrite;
    this.read  = opts.readFile  ?? defaultRead;
    this.agentId = opts.agentId ?? 'claude-code';
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
      // Phase α: close the current turn at the Stop boundary so the next
      // PreToolUse mints a fresh turnId. Idempotent — Stops without any
      // intervening edit are no-ops.
      this.opts.store.endTurn(sid);
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

      // Option A: snapshot for undo BEFORE mutating.
      const snapshot = this.snapshotForUndo(sid, [file], 'hunk-action', hunkIndex);

      const outcome = await this.applyHunkSetChange(sid, file, (set) => {
        if (action === 'accept') set.add(hunkIndex);
        else                     set.delete(hunkIndex);
      });

      if (!outcome.ok) {
        if (outcome.reason === 'set-conflict') {
          this.opts.panel.postSetConflict(sid, absFile, hunkIndex, outcome.conflictingHunks);
        }
        // hunk stays pending; warnings already attached to file inside applyHunkSetChange
        this.opts.panel.postFileUpdated(sid, absFile, file);
        return;
      }

      hunk.status = action === 'accept' ? 'accepted' : 'rejected';
      hunk.decidedAt = Date.now();
      file.status = recomputeFileStatus(file.hunks);
      review.metrics = recomputeMetrics(review.files);
      this.opts.panel.postHunkApplied(sid, absFile, hunkIndex, hunk.status);
      this.pushUndoSnapshot(sid, snapshot);
      this.notifyChange();
      this.maybeComplete(review);

      // Phase α Track 1: log the decision after the write lands. Best-effort —
      // history failures never block the user flow (service logs internally).
      this.recordHunkDecisionEvent(sid, file, hunk.index, hunk.status as 'accepted' | 'rejected', outcome.content);
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

    // Option A: one snapshot per bulk action (not per file in the batch).
    // Undoing a bulk action restores every affected file in one step.
    const bulkSnapshot = targetFiles.length > 0
      ? this.snapshotForUndo(sid, targetFiles, scope === 'session' ? 'bulk-session' : 'bulk-file')
      : null;
    let bulkProducedChanges = false;

    // Different files run under distinct locks ⇒ parallelisable. Same-file
    // contention queues behind this. Each file does a single set-based
    // render + write (the legacy "fast path" for full-file rejects is now
    // the default path for every operation — by construction).
    await Promise.all(targetFiles.map((file) => this.lockFile(file.filePath, async () => {
      const pendingIndices = file.hunks
        .map((h, i) => (h.status === 'pending' ? i : -1))
        .filter((i) => i >= 0);
      if (pendingIndices.length === 0) return;

      const outcome = await this.applyHunkSetChange(sid, file, (set) => {
        if (action === 'accept') {
          for (const i of pendingIndices) set.add(i);
        } else {
          for (const i of pendingIndices) set.delete(i);
        }
      });

      if (!outcome.ok) {
        // Conflict during bulk → keep pending; surface single banner per file.
        if (outcome.reason === 'set-conflict') {
          this.opts.panel.postSetConflict(sid, file.filePath, pendingIndices[0], outcome.conflictingHunks);
        }
        this.opts.panel.postFileUpdated(sid, file.filePath, file);
        return;
      }

      const now = Date.now();
      for (const i of pendingIndices) {
        const h = file.hunks[i];
        h.status = action === 'accept' ? 'accepted' : 'rejected';
        h.decidedAt = now;
      }
      file.status = recomputeFileStatus(file.hunks);
      this.opts.panel.postFileUpdated(sid, file.filePath, file);
      bulkProducedChanges = true;

      // Phase α Track 1: log each hunk decision in this bulk batch.
      for (const i of pendingIndices) {
        const h = file.hunks[i];
        this.recordHunkDecisionEvent(sid, file, h.index, h.status as 'accepted' | 'rejected', outcome.content);
      }
    })));

    review.metrics = recomputeMetrics(review.files);
    // Option A: push the bulk snapshot only if the action actually changed
    // something. Avoids "Undo" entries for no-op bulks (e.g., accept-all
    // when nothing was pending).
    if (bulkSnapshot && bulkProducedChanges) {
      this.pushUndoSnapshot(sid, bulkSnapshot);
    }
    this.notifyChange();
    this.maybeComplete(review);
  }

  /**
   * Phase α M9.2.9: undo the latest decision on a single hunk within the
   * current panel session. Inverts the hunk's set membership and flips
   * its status back to `pending`. Goes through the same per-file mutex
   * as the original decision so concurrent clicks serialise.
   *
   * Cross-turn / cross-session undo (rebase semantics from MEMORY-DESIGN
   * §5) is Phase β Revisit and gated behind `history.crossTurnUndo`.
   */
  async handleUndoHunkDecision(sessionId: string, filePath: string, hunkIndex: number): Promise<void> {
    const sid = asSessionId(sessionId);
    const review = this.sessions.get(sid);
    if (!review) {
      this.opts.logger.warn('orchestrator', 'undo.no-session', { sid });
      return;
    }
    const absFile = asAbsPath(filePath);
    const file = this.getFile(sid, absFile);
    if (!file) {
      this.opts.logger.warn('orchestrator', 'undo.no-file', { sid, filePath });
      return;
    }

    await this.lockFile(absFile, async () => {
      const hunk = file.hunks[hunkIndex];
      if (!hunk) return;
      // Already pending? No-op.
      if (hunk.status === 'pending') return;

      // Option A: snapshot for undo so "undo of undo" works.
      const snapshot = this.snapshotForUndo(sid, [file], 'undo-hunk', hunkIndex);

      const wasAccepted = hunk.status === 'accepted';
      // Inverse-toggle: if accepted → remove from set; if rejected → add back.
      const outcome = await this.applyHunkSetChange(sid, file, (set) => {
        if (wasAccepted) set.delete(hunkIndex);
        else             set.add(hunkIndex);
      });

      if (!outcome.ok) {
        // Best-effort: surface conflict if any (rare for undo since the
        // prior decision was rendered cleanly), then leave status as-is.
        if (outcome.reason === 'set-conflict') {
          this.opts.panel.postSetConflict(sid, absFile, hunkIndex, outcome.conflictingHunks);
        }
        this.opts.panel.postFileUpdated(sid, absFile, file);
        return;
      }

      hunk.status = 'pending';
      delete hunk.decidedAt;
      file.status = recomputeFileStatus(file.hunks);
      review.metrics = recomputeMetrics(review.files);
      this.opts.panel.postHunkApplied(sid, absFile, hunkIndex, hunk.status);
      this.pushUndoSnapshot(sid, snapshot);
      this.notifyChange();

      // Phase β.0 (FR-B0.7): emit `undo` event so `reconstructSessionReview`
      // observes the reverted-to state instead of replaying the now-undone
      // hunk-decided event. Resolves turnId via lastTurnId fallback (Stop
      // has already fired by the time per-hunk Undo is reachable).
      const sessionData = this.opts.store.get(sid);
      const srcTurnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId ?? sid;
      this.recordUndoEvent(
        sid,
        'hunk',
        { srcTurnId, srcEventId: -1, path: file.relPath, hunkIdx: hunkIndex },
        new Map([[absFile, outcome.content]]),
        () => file.relPath,
        file.subagentId,
      );

      this.opts.logger.info('orchestrator', 'hunk.undone', {
        sid, file: absFile, hunk: hunkIndex, previousStatus: wasAccepted ? 'accepted' : 'rejected',
      });
    });
  }

  dismissSession(sessionId: string): void {
    const sid = asSessionId(sessionId);
    this.opts.panel.close(sid);
    this.sessions.delete(sid);
    this.unindexSession(sid);
    this.unindexHunkSets(sid);
    this.undoStack.delete(sid);
    this.opts.store.release(sid);
    try { this.opts.onDismissSession?.(sid); } catch { /* never throw to caller */ }
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
      // Option A: snapshot before the revert so user can undo it.
      const snapshot = this.snapshotForUndo(sid, [file], 'snapshot-revert');

      // Phase α: route through the set pipeline so the `acceptedSet` stays
      // in sync with disk. Empty set ⇒ render returns the snapshot
      // unconditionally (no fuzz involved) — same end state as the legacy
      // direct `writeFile(file.before)` path, but with consistent state.
      const outcome = await this.applyHunkSetChange(sid, file, (set) => set.clear());
      if (!outcome.ok) {
        // Write failed → leave hunks untouched (caller can retry; matches
        // v0.1.0 invariant that decisions only flip on successful disk write).
        // `applyHunkSetChange` already added the appropriate warning.
        this.opts.panel.postFileUpdated(sid, absFile, file);
        return;
      }

      const now = Date.now();
      for (const h of file.hunks) {
        // Every hunk becomes rejected (whether previously pending, accepted,
        // or already rejected — full-file revert is a terminal decision).
        h.status = 'rejected';
        if (h.decidedAt == null) h.decidedAt = now;
      }
      file.status = recomputeFileStatus(file.hunks);
      review.metrics = recomputeMetrics(review.files);
      this.opts.panel.postFileUpdated(sid, absFile, file);
      this.pushUndoSnapshot(sid, snapshot);
      this.opts.logger.info('orchestrator', 'file.snapshot-reverted', { file: absFile });
      this.notifyChange();
      this.maybeComplete(review);

      // Phase α Track 1: log the snapshot revert as a distinct event so
      // History panel can render it as its own action (not just N rejects).
      void this.recordSnapshotRevertEvent(sid, file, outcome.content);
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

  /**
   * Phase β.0 (10.1.4): adopt a `ReconstructedSessionReview` into the live
   * orchestrator state so a closed/aborted session can be re-opened.
   *
   * Restores every per-session map in lockstep — `sessions`, `byPath`,
   * `globalByPath`, `hunkSets`, `undoStack` (empty: cross-session undo is
   * dev-mode-gated) — and seeds `SnapshotStore` via `injectSession` so a
   * subsequent PreToolUse does NOT re-capture already-mutated content as
   * the "original."
   *
   * Drift handling per file:
   *   - 'clean':   render as normal
   *   - 'drifted': attach 'external-edit' warning; afterContent kept as
   *                reconstructed (re-diff against current disk happens on
   *                next save via `scheduleReDiff`)
   *   - 'missing': attach 'vanished' warning
   *
   * Does NOT call `panel.openOrFocus` — caller decides when to surface the
   * UI (Open Review Panel command in 10.1.7 / History panel Resume in 10.1.8).
   *
   * Invariant: Resume re-opens the prior turn. Decisions appended after
   * Resume carry the reconstructed turnId — preserving the audit lineage.
   */
  adoptReconstructed(reconstructed: ReconstructedSessionReview): SessionReview {
    const sid = asSessionId(reconstructed.sessionId);

    // Seed SnapshotStore FIRST so a racing PreToolUse reads the historical
    // `before` content and not the on-disk mutated state.
    const originals = new Map<AbsPath, string>();
    const subagentIdByPath = new Map<AbsPath, string | null>();
    for (const f of reconstructed.files) {
      const abs = asAbsPath(f.filePath);
      originals.set(abs, f.before);
      // M9.6: preserve sub-agent attribution per file across reconstruction.
      subagentIdByPath.set(abs, f.subagentId ?? null);
    }
    this.opts.store.injectSession({
      sessionId: sid,
      cwd: reconstructed.cwd,
      originals,
      subagentIdByPath,
      // Re-open the prior turn — user decisions during resume append events
      // under the original turnId via the `currentTurnId ?? lastTurnId`
      // fallback path in record*Event helpers. (Architectural decision #8.)
      //
      // Bug C fix: leave currentTurnId NULL so Claude's continuation edits
      // mint a FRESH turn id (beginTurnIfNeeded → freshlyMinted=true).
      // Setting currentTurnId to the prior id caused the next Stop to emit
      // a SECOND turn-stopped event with the same turnId — reconstruction
      // then REPLACED the prior turn's hunks + acceptedSet, silently
      // dropping every hunk-decided that came in between.
      currentTurnId: null,
      lastTurnId: reconstructed.turnId,
      turnStartedAt: null,
    });

    // Build FileReview list. Per-file drift translates to warnings.
    const files: FileReview[] = reconstructed.files.map((f) => {
      const warnings: FileWarning[] = [];
      const drift = reconstructed.driftPerFile[f.relPath];
      if (drift === 'drifted') warnings.push('external-edit');
      if (drift === 'missing') warnings.push('vanished');
      if (f.isBinary) warnings.push('binary-file');
      const hunks: HunkReview[] = f.hunks.map((h) => {
        const entry: HunkReview = {
          index: h.index,
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          header: h.header,
          lines: h.lines.slice(),
          status: h.status,
        };
        if (h.decidedAt !== undefined) entry.decidedAt = h.decidedAt;
        return entry;
      });
      const fileReview: FileReview = {
        filePath: asAbsPath(f.filePath),
        relPath: f.relPath,
        before: f.before,
        after: f.after,
        hunks,
        status: recomputeFileStatus(hunks),
        isNew: f.isNew,
        isDeleted: f.isDeleted,
        isBinary: f.isBinary,
        warnings,
        ...(f.subagentId ? { subagentId: f.subagentId } : {}),
      };
      return fileReview;
    });

    const review: SessionReview = {
      sessionId: sid,
      cwd: reconstructed.cwd,
      agentId: reconstructed.agentId,
      startedAt: reconstructed.lastEventAt, // best approximation from log
      openedAt: Date.now(),
      lastAssistantMessage: null,
      files,
      state: 'open',
      metrics: recomputeMetrics(files),
    };
    this.sessions.set(sid, review);
    this.indexFiles(sid, files);

    // Restore hunkSets from reconstructed acceptedSet (NOT initialHunkSetState
    // which defaults to all-applied).
    const perSession = new Map<AbsPath, HunkSetState>();
    for (const hs of reconstructed.hunkSets) {
      const abs = asAbsPath(hs.filePath);
      perSession.set(abs, {
        filePath: abs,
        originalSnapshot: hs.originalSnapshot,
        allHunks: hs.allHunks.map((h) => ({ ...h, lines: h.lines.slice() })),
        acceptedSet: new Set(hs.acceptedSet),
      });
    }
    this.hunkSets.set(sid, perSession);

    // Cross-session undo is dev-mode-gated and out of scope for β.0.
    this.undoStack.set(sid, []);

    this.opts.logger.info('orchestrator', 'session.adopted', {
      sid, files: files.length, turnId: reconstructed.turnId,
    });
    this.notifyChange();
    return review;
  }

  /**
   * β.0 (10.1.8b): roll back every file in a reconstructed turn to its
   * pre-edit content. Disk-only restore (decision #11): writes through the
   * per-file mutex and emits `file-snapshot-reverted` per file. Does NOT
   * touch in-memory session state; if the session is also live in the
   * panel, the natural `onDidSaveTextDocument` re-diff path picks up the
   * change. The History panel's Rollback button is the sole caller today.
   *
   * Caller is responsible for confirming the destructive action — this
   * method assumes consent.
   */
  async rollbackTurnFromHistory(
    reconstructed: ReconstructedSessionReview,
  ): Promise<{ filesRestored: number; failed: number }> {
    let restored = 0;
    let failed = 0;
    for (const f of reconstructed.files) {
      if (f.isDeleted) {
        // A file Claude created can be unmade by deleting it. Out of scope
        // for v0.2 — defer to a follow-up (would need an `unlinkFile` write).
        this.opts.logger.debug('orchestrator', 'rollback.skip-isnew', { rel: f.relPath });
        continue;
      }
      const abs = asAbsPath(f.filePath);
      await this.lockFile(abs, async () => {
        try {
          await this.write(abs, f.before);
          restored++;
          // Emit a file-snapshot-reverted event so the next reconstruction
          // sees the rollback as a first-class decision (and the pending
          // count drops to zero for this file).
          const history = this.opts.history;
          if (history) {
            void history.recordFileSnapshotReverted({
              sessionId: reconstructed.sessionId,
              turnId: reconstructed.turnId,
              agentId: reconstructed.agentId,
              relPath: f.relPath,
              postContent: f.before,
            });
          }
        } catch (err) {
          failed++;
          this.opts.logger.warn('orchestrator', 'rollback.write-failed', {
            abs, err: String(err),
          });
        }
      });
    }
    this.opts.logger.info('orchestrator', 'rollback.applied', {
      sid: reconstructed.sessionId,
      turnId: reconstructed.turnId,
      restored, failed,
    });
    this.notifyChange();
    return { filesRestored: restored, failed };
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
      // Phase α regression guard: a touched file with no actual content
      // change (Claude wrote identical bytes, or an Edit was a no-op)
      // should NOT appear in the review. Without this filter, the panel
      // shows phantom "No changes." files with disabled ✓ File buttons
      // and silent ✗ File clicks. New / deleted / binary files are kept
      // regardless — those have meaningful content to surface.
      if (diff.hunks.length === 0 && !diff.isNew && !diff.isDeleted && !diff.isBinary) {
        this.opts.logger.debug('orchestrator', 'open.skip-no-changes', { absPath });
        continue;
      }
      const fr = toFileReview(diff, sessionData.cwd, sessionData.overBudget);
      // M9.6: surface the sub-agent that produced this file's edit, if any.
      const subagentId = sessionData.subagentIdByPath.get(absPath);
      if (subagentId) fr.subagentId = subagentId;
      // v0.3: risk-flag triage — heuristic decision support. Pure functions
      // over the already-built FileReview/HunkReview shapes; no I/O. Gated
      // on `riskFlagsEnabled` so users can opt out via config.
      if (this.opts.riskFlagsEnabled) {
        const fileFlags = flagFile(fr);
        if (fileFlags.length > 0) fr.flags = fileFlags;
        for (const h of fr.hunks) {
          const hunkFlags = flagHunk(h);
          if (hunkFlags.length > 0) h.flags = hunkFlags;
        }
      }
      files.push(fr);
    }

    // Bug B fix: when openReview fires for an already-tracked session
    // (Claude continued editing in a resumed session, or fired multiple
    // Stops in one logical turn), preserve hunk decisions where the new
    // diff aligns with the prior hunks. Mirrors `reDiff`'s pattern
    // (`hunksAlignedShallow` at the bottom of this file). Without this,
    // every continuation Stop wipes the user's prior accept/reject in
    // the live panel.
    const priorSession = this.sessions.get(sid);
    if (priorSession) {
      for (const newFile of files) {
        const priorFile = priorSession.files.find((p) => p.filePath === newFile.filePath);
        if (!priorFile) continue;
        newFile.hunks = newFile.hunks.map((h) => {
          const priorH = priorFile.hunks[h.index];
          if (priorH && hunksAlignedShallow(priorH, h)) {
            const merged: HunkReview = { ...h, status: priorH.status };
            if (priorH.decidedAt !== undefined) merged.decidedAt = priorH.decidedAt;
            return merged;
          }
          return h;
        });
        newFile.status = recomputeFileStatus(newFile.hunks);
      }
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
    // Phase α Track 6: seed initial set state — `acceptedSet = all hunks`
    // so `renderFileFromHunkSet` produces current disk content byte-for-byte.
    // No user-visible behaviour change vs v0.1.0; every subsequent
    // Accept/Reject is a set toggle from this baseline.
    this.indexHunkSets(sid, files, sessionData.originals);
    // Bug B fix continued: if we preserved any prior decisions above,
    // override the freshly-seeded acceptedSet so it reflects them.
    // Rule: a hunk is in the set iff its status is NOT 'rejected'
    // (pending and accepted both correspond to on-disk content).
    if (priorSession) {
      const perSession = this.hunkSets.get(sid);
      if (perSession) {
        for (const file of files) {
          const hs = perSession.get(file.filePath);
          if (!hs) continue;
          const accepted = new Set<number>();
          for (const h of file.hunks) {
            if (h.status !== 'rejected') accepted.add(h.index);
          }
          hs.acceptedSet = accepted;
        }
      }
    }
    await this.opts.panel.openOrFocus(review);
    this.opts.logger.info('orchestrator', 'review.opened', {
      sid,
      files: files.length,
      hunks: review.metrics.totalHunks,
    });
    this.notifyChange();

    // Phase α Track 1: emit `turn-stopped` into the event log. We have
    // every file's full diff (hunks + before/after content) right here,
    // so this single record captures the whole turn for crash recovery
    // and the History panel. Awaited (not fire-and-forget) so a fast
    // crash after Stop still has a durable turn boundary — without this,
    // reconstructSessionReview can race and see only turn-started.
    await this.recordTurnStoppedEvent(sid, review, sessionData.cwd, lastAssistantMessage);
  }

  /**
   * Phase α Track 6: the core write primitive for the set-based pipeline.
   *
   * Snapshots the current `acceptedSet`, applies `mutate` to it, re-renders
   * the file from the original snapshot, writes the rendered bytes to disk.
   * On any failure (render conflict, FS error), the set mutation is rolled
   * back so `acceptedSet` and disk stay in sync.
   *
   * Returns the rendered content on success (caller may use it to update
   * `file.after`) or a tagged failure for the caller to surface.
   */
  private async applyHunkSetChange(
    sid: SessionId,
    file: FileReview,
    mutate: (set: Set<number>) => void,
  ): Promise<
    | { ok: true; content: string }
    | { ok: false; reason: 'set-conflict'; conflictingHunks: number[] }
    | { ok: false; reason: 'snapshot-binary' }
    | { ok: false; reason: 'fs' }
  > {
    const hunkSet = this.getHunkSet(sid, file.filePath);
    if (!hunkSet) {
      this.opts.logger.warn('orchestrator', 'applyHunkSetChange.no-state', { sid, file: file.filePath });
      return { ok: false, reason: 'fs' };
    }

    const previousSet = new Set(hunkSet.acceptedSet);
    mutate(hunkSet.acceptedSet);

    // No-op short-circuit: if the set didn't actually change (e.g. accepting
    // a hunk that's already in the initial-all-accepted set), skip render
    // and write. Preserves the v0.1.0 behaviour that accept-on-applied is
    // a free no-op on disk.
    if (setsEqual(previousSet, hunkSet.acceptedSet)) {
      return { ok: true, content: file.after };
    }

    const result = renderFileFromHunkSet(hunkSet);
    if (!result.ok) {
      hunkSet.acceptedSet = previousSet;
      if (result.reason === 'set-conflict') {
        file.warnings = uniqueWarnings([...file.warnings, 'fuzz-failed-revert']);
        this.opts.logger.warn('orchestrator', 'set.conflict', {
          file: file.filePath,
          conflicting: result.conflictingHunks,
        });
        return { ok: false, reason: 'set-conflict', conflictingHunks: result.conflictingHunks };
      }
      this.opts.logger.warn('orchestrator', 'set.binary', { file: file.filePath });
      return { ok: false, reason: 'snapshot-binary' };
    }

    try {
      await this.write(file.filePath, result.content);
    } catch (err) {
      hunkSet.acceptedSet = previousSet;
      this.markWriteFailed(file, err);
      return { ok: false, reason: 'fs' };
    }

    file.after = result.content;
    // Successful write clears any prior FS-failure warning so the banner disappears.
    if (file.warnings.includes('write-failed') || file.warnings.includes('read-failed') || file.warnings.includes('fuzz-failed-revert')) {
      file.warnings = file.warnings.filter((w) => w !== 'write-failed' && w !== 'read-failed' && w !== 'fuzz-failed-revert');
    }
    return { ok: true, content: result.content };
  }

  private getHunkSet(sid: SessionId, absPath: AbsPath): HunkSetState | undefined {
    return this.hunkSets.get(sid)?.get(absPath);
  }

  /**
   * Phase α Track 1: persist a hunk decision in the event log.
   * No-ops cleanly when history isn't configured (tests, --history=off).
   */
  private recordHunkDecisionEvent(
    sid: SessionId,
    file: FileReview,
    hunkIdx: number,
    decision: 'accepted' | 'rejected',
    postContent: string,
  ): void {
    const history = this.opts.history;
    if (!history) return;
    const sessionData = this.opts.store.get(sid);
    // Hunk decisions fire AFTER the panel opens, which is AFTER Stop, which
    // clears `currentTurnId`. The retained `lastTurnId` holds the UUID for
    // the turn whose review the user is acting on. Without this fallback,
    // every panel-driven decision would silently skip the event log.
    const turnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId;
    if (!turnId) return;
    void history.recordHunkDecided({
      sessionId: sid,
      turnId,
      agentId: this.agentId,
      relPath: file.relPath,
      hunkIdx,
      decision,
      postContent,
      drift: { fuzz: null },
    });
  }

  /**
   * Phase β.0 (FR-B0.7): emit an `undo` event for an in-session undo path.
   *
   * Resolves the turnId in fallback order `currentTurnId → lastTurnId → sid`.
   * The fallback to `lastTurnId` is critical for per-hunk ↶ Undo: that path
   * fires AFTER Stop (the review panel is already open), at which point
   * `endTurn` has cleared `currentTurnId`. Without `lastTurnId` the event
   * would attach to a synthetic session-id "turn" and lose its lineage.
   *
   * Fire-and-forget — matches every other `record*Event` helper.
   */
  private recordUndoEvent(
    sid: SessionId,
    scope: 'hunk' | 'file' | 'turn',
    target: {
      srcTurnId: string;
      srcEventId: number;
      path?: string;
      hunkIdx?: number;
    },
    postContents: Map<AbsPath, string>,
    relPathByAbs: (abs: AbsPath) => string,
    /**
     * M9.6 audit-gap fix: the sub-agent attribution for the file(s) being
     * undone. Without this, reconstruction loses attribution as soon as
     * any decision is undone — same shape of bug as β.0's missing
     * `lastTurnId`. The history layer's `recordUndo` input already
     * supports `subagentId`; we just need to pass it through.
     */
    subagentId?: string,
  ): void {
    const history = this.opts.history;
    if (!history) return;
    const sessionData = this.opts.store.get(sid);
    // `?? sid` was previously here as a last-resort fallback, but sessionId
    // is not a UUID — the event would be written to disk yet rejected by
    // `decodeEvent` on read. Bail cleanly instead.
    const turnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId;
    if (!turnId) return;
    const postRecord: Record<string, string> = {};
    for (const [abs, content] of postContents) {
      postRecord[relPathByAbs(abs)] = content;
    }
    const targetClean: { srcTurnId: string; srcEventId: number; path?: string; hunkIdx?: number } = {
      srcTurnId: target.srcTurnId,
      srcEventId: target.srcEventId,
    };
    if (target.path !== undefined)    targetClean.path    = target.path;
    if (target.hunkIdx !== undefined) targetClean.hunkIdx = target.hunkIdx;
    void history.recordUndo({
      sessionId: sid,
      turnId,
      agentId: this.agentId,
      ...(subagentId ? { subagentId } : {}),
      scope,
      target: targetClean,
      postContents: postRecord,
    });
  }

  private recordSnapshotRevertEvent(sid: SessionId, file: FileReview, postContent: string): void {
    const history = this.opts.history;
    if (!history) return;
    const sessionData = this.opts.store.get(sid);
    // Same post-Stop fallback as recordHunkDecisionEvent: revert fires after
    // the panel opens, so `currentTurnId` is already null.
    const turnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId;
    if (!turnId) return;
    void history.recordFileSnapshotReverted({
      sessionId: sid,
      turnId,
      agentId: this.agentId,
      relPath: file.relPath,
      postContent,
    });
  }

  private async recordTurnStoppedEvent(
    sid: SessionId,
    review: SessionReview,
    cwd: string,
    lastAssistantMessage: string | null,
  ): Promise<void> {
    const history = this.opts.history;
    if (!history) return;
    const sessionData = this.opts.store.get(sid);
    // `handleStop` calls `endTurn(sid)` BEFORE `openReview`, so by the time
    // this runs, `currentTurnId` is null but the retained `lastTurnId` still
    // holds the UUID minted at the first PreToolUse. We MUST surface that
    // (not the sessionId) — the event schema's `turnId` requires a UUID, and
    // a non-UUID fallback would be rejected by `decodeEvent` on read and
    // produce a phantom "no turn-stopped" reconstruction with empty hunks.
    const turnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId;
    if (!turnId) {
      this.opts.logger.warn('orchestrator', 'history.turnStopped.no-turn', { sid });
      return;
    }
    // Bug C fix: filter to ONLY the files touched in this turn. The
    // session-wide `review.files` includes prior-turn files when the user
    // resumed and Claude continued; emitting them in this turn's
    // turn-stopped would cause reconstruction to REPLACE the prior turn's
    // state on replay (turn-stopped's handler resets state.hunks +
    // acceptedSet). For freshly-minted turns we have the per-turn set;
    // when there is no per-turn set (e.g. legacy flow without
    // `currentTurnTouched` populated), fall back to emitting everything
    // — keeps the v0.1 single-turn case intact.
    const turnTouched = sessionData?.currentTurnTouched;
    const filesToEmit = (turnTouched && turnTouched.size > 0)
      ? review.files.filter((f) => turnTouched.has(f.filePath))
      : review.files;
    try {
      await history.recordTurnStopped({
        sessionId: sid,
        turnId,
        agentId: this.agentId,
        lastAssistantMessage,
        files: filesToEmit.map((f) => ({
          relPath: f.relPath,
          afterContent: f.isBinary ? null : f.after,
          isNew: f.isNew,
          isDeleted: f.isDeleted,
          isBinary: f.isBinary,
          // M9.6: file-level sub-agent attribution from the live FileReview.
          ...(f.subagentId ? { subagentId: f.subagentId } : {}),
          hunks: f.hunks.map((h) => ({
            idx: h.index,
            oldStart: h.oldStart,
            oldLines: h.oldLines,
            newStart: h.newStart,
            newLines: h.newLines,
            lines: h.lines,
          })),
        })),
      });
    } catch (err) {
      this.opts.logger.warn('orchestrator', 'history.turnStopped.failed', { err: String(err) });
    }
    // The unused cwd reference keeps the helper's signature stable for
    // future use (path resolution will need it when we surface absolute
    // paths in history queries).
    void cwd;
  }

  private indexHunkSets(sid: SessionId, files: FileReview[], originals: Map<AbsPath, string>): void {
    const perSession = new Map<AbsPath, HunkSetState>();
    for (const file of files) {
      const before = originals.get(file.filePath) ?? file.before;
      const allHunks: StructuredHunk[] = file.hunks.map(hunkAsStructured);
      perSession.set(file.filePath, initialHunkSetState(file.filePath, before, allHunks));
    }
    this.hunkSets.set(sid, perSession);
  }

  private unindexHunkSets(sid: SessionId): void {
    this.hunkSets.delete(sid);
  }

  /**
   * Option A: capture every affected file's state BEFORE a mutating action,
   * so `handleUndoLastAction` can restore set + statuses + disk verbatim.
   */
  private snapshotForUndo(
    sid: SessionId,
    affected: FileReview[],
    scope: UndoSnapshot['scope'],
    hunkIdx?: number,
  ): UndoSnapshot {
    const files = new Map<AbsPath, UndoSnapshotFile>();
    for (const file of affected) {
      const hunkSet = this.getHunkSet(sid, file.filePath);
      files.set(file.filePath, {
        acceptedSet: new Set(hunkSet?.acceptedSet ?? []),
        hunkStatuses: file.hunks.map((h) => {
          const entry: { index: number; status: HunkStatus; decidedAt?: number } = {
            index: h.index,
            status: h.status,
          };
          if (h.decidedAt !== undefined) entry.decidedAt = h.decidedAt;
          return entry;
        }),
        after: file.after,
        warnings: [...file.warnings],
      });
    }
    const snap: UndoSnapshot = { scope, files };
    if (hunkIdx !== undefined) snap.hunkIdx = hunkIdx;
    return snap;
  }

  private pushUndoSnapshot(sid: SessionId, snapshot: UndoSnapshot): void {
    let stack = this.undoStack.get(sid);
    if (!stack) { stack = []; this.undoStack.set(sid, stack); }
    stack.push(snapshot);
    if (stack.length > ReviewOrchestrator.UNDO_STACK_CAP) stack.shift();
    this.opts.panel.postUndoStackDepth(sid, stack.length);
  }

  private emitUndoStackDepth(sid: SessionId): void {
    this.opts.panel.postUndoStackDepth(sid, this.undoStack.get(sid)?.length ?? 0);
  }

  /**
   * Option A entry point: pop the most recent action snapshot and restore
   * every affected file. Editor-style Ctrl+Z semantics:
   *   - bulk accept-all → undo → all hunks back to pending, no disk change
   *     (since accept-all is no-op on disk when all hunks were already in set)
   *   - bulk reject-all → undo → all hunks re-applied, disk restored
   *   - single hunk → undo → that hunk re-applies, status reverts
   *   - revert-to-snapshot → undo → all pre-revert content restored
   *
   * Goes through `lockFile` per affected file so concurrent UI clicks
   * serialise.
   */
  async handleUndoLastAction(sessionId: string): Promise<void> {
    const sid = asSessionId(sessionId);
    const stack = this.undoStack.get(sid);
    if (!stack || stack.length === 0) {
      this.opts.logger.debug('orchestrator', 'undo-last.empty-stack', { sid });
      return;
    }
    const review = this.sessions.get(sid);
    if (!review) {
      this.opts.logger.warn('orchestrator', 'undo-last.no-session', { sid });
      return;
    }
    const snapshot = stack.pop()!;

    // Phase β.0 (FR-B0.7): accumulate per-file post-undo contents so we can
    // emit a single `undo` event after all per-file restores complete.
    // Path keyed by absolute path (matches lockFile granularity) — we'll
    // translate to relPath at emit time using `file.relPath`.
    const undoPostContents = new Map<AbsPath, string>();
    const undoRelPaths = new Map<AbsPath, string>();

    for (const [absFile, fileSnap] of snapshot.files) {
      await this.lockFile(absFile, async () => {
        const file = this.getFile(sid, absFile);
        const hunkSet = this.getHunkSet(sid, absFile);
        if (!file || !hunkSet) return;

        // Restore set first so any future read sees a consistent state.
        hunkSet.acceptedSet = new Set(fileSnap.acceptedSet);

        // Only write to disk if the content actually differs — avoids
        // spurious writes when the action was a no-op-on-disk (e.g.,
        // accept-all from initial-all-applied state).
        if (file.after !== fileSnap.after) {
          try {
            await this.write(absFile, fileSnap.after);
          } catch (err) {
            // Restore failed: push the snapshot back so the user can retry,
            // and don't corrupt the in-memory state.
            stack.push(snapshot);
            this.markWriteFailed(file, err);
            this.opts.panel.postFileUpdated(sid, absFile, file);
            this.opts.panel.postUndoStackDepth(sid, stack.length);
            return;
          }
          file.after = fileSnap.after;
        }

        // Restore hunk statuses + decidedAt.
        const byIndex = new Map(fileSnap.hunkStatuses.map((h) => [h.index, h]));
        for (const h of file.hunks) {
          const prev = byIndex.get(h.index);
          if (!prev) continue;
          h.status = prev.status;
          if (prev.decidedAt !== undefined) h.decidedAt = prev.decidedAt;
          else delete h.decidedAt;
        }
        file.status = recomputeFileStatus(file.hunks);
        // Restore warnings exactly so transient banners revert too.
        file.warnings = [...fileSnap.warnings];
        this.opts.panel.postFileUpdated(sid, absFile, file);

        // Phase β.0 (FR-B0.7): capture content for audit emission.
        undoPostContents.set(absFile, file.after);
        undoRelPaths.set(absFile, file.relPath);
      });
    }

    review.metrics = recomputeMetrics(review.files);
    this.notifyChange();
    this.emitUndoStackDepth(sid);

    // Phase β.0 (FR-B0.7): emit one undo event after the restore lands.
    // Skip when nothing changed on disk (no postContents → no audit value).
    if (undoPostContents.size > 0) {
      const undoScope: 'hunk' | 'file' | 'turn' =
        (snapshot.scope === 'hunk-action' || snapshot.scope === 'undo-hunk') ? 'hunk' :
        (snapshot.scope === 'bulk-file' || snapshot.scope === 'snapshot-revert') ? 'file' :
        'turn';
      const sessionData = this.opts.store.get(sid);
      const srcTurnId = sessionData?.currentTurnId ?? sessionData?.lastTurnId ?? sid;
      const target: { srcTurnId: string; srcEventId: number; path?: string; hunkIdx?: number } = {
        srcTurnId,
        srcEventId: -1,
      };
      if (undoScope === 'hunk') {
        // Single-file, single-hunk scope. `snapshot.hunkIdx` was captured at
        // snapshot creation time (handleHunkAction / handleUndoHunkDecision).
        const [absFile] = undoPostContents.keys();
        const relPath = undoRelPaths.get(absFile);
        if (relPath !== undefined)        target.path    = relPath;
        if (snapshot.hunkIdx !== undefined) target.hunkIdx = snapshot.hunkIdx;
      } else if (undoScope === 'file') {
        // Single-file revert.
        const [absFile] = undoPostContents.keys();
        const relPath = undoRelPaths.get(absFile);
        if (relPath !== undefined) target.path = relPath;
      }
      // For 'turn' scope (bulk-session), omit path/hunkIdx — multiple files.
      // M9.6 audit-gap fix: pass per-event subagentId for single-file scopes;
      // omit for turn-scoped (the canonical per-file attribution lives on
      // turn-stopped's `files[i].subagentId` for multi-file turns).
      let undoSubagentId: string | undefined;
      if (undoScope === 'hunk' || undoScope === 'file') {
        const [absFile] = undoPostContents.keys();
        if (absFile !== undefined) {
          const fr = this.getFile(sid, absFile);
          if (fr?.subagentId) undoSubagentId = fr.subagentId;
        }
      }
      this.recordUndoEvent(
        sid,
        undoScope,
        target,
        undoPostContents,
        (abs) => undoRelPaths.get(abs) ?? abs,
        undoSubagentId,
      );
    }

    this.opts.logger.info('orchestrator', 'undo-last.applied', {
      sid, scope: snapshot.scope, files: snapshot.files.size, remaining: stack.length,
    });
  }

  private markWriteFailed(file: FileReview, err: unknown): void {
    file.warnings = uniqueWarnings([...file.warnings, 'write-failed']);
    this.opts.logger.error('orchestrator', 'write.failed', { file: file.filePath, err: String(err) });
  }

  private async reDiff(sid: SessionId, absPath: AbsPath): Promise<void> {
    // β.0 (10.1.9): gate through the per-file mutex so the swap of
    // `file.hunks` + `hunkSets` cannot race with a concurrent hunk action,
    // drift-classification read, or undo. Pre-β.0 this ran unprotected —
    // benign while drift was never observed externally, but β.0's
    // reconstruction reads file.after and would see torn state.
    await this.lockFile(absPath, async () => {
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

      // Phase α Track 6: rebuild HunkSetState from the refreshed hunks so the
      // set stays consistent with the new hunk indices. `acceptedSet` is
      // derived from preserved hunk.status. New hunks (no prior alignment)
      // arrive as 'pending' and start outside the set.
      const newAllHunks: StructuredHunk[] = file.hunks.map(hunkAsStructured);
      const newAccepted = new Set<number>();
      for (const h of file.hunks) {
        if (h.status === 'accepted') newAccepted.add(h.index);
      }
      let perSession = this.hunkSets.get(sid);
      if (!perSession) {
        perSession = new Map();
        this.hunkSets.set(sid, perSession);
      }
      perSession.set(absPath, {
        filePath: absPath,
        originalSnapshot: file.before,
        allHunks: newAllHunks,
        acceptedSet: newAccepted,
      });

      this.opts.panel.postFileUpdated(sid, absPath, file);
      this.notifyChange();
    });
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

// --------------------------------------------------------------------------
// Option A: undo-stack snapshot types
// --------------------------------------------------------------------------

interface UndoSnapshotFile {
  acceptedSet: Set<number>;
  hunkStatuses: Array<{ index: number; status: HunkStatus; decidedAt?: number }>;
  /** On-disk content immediately before the mutation. */
  after: string;
  /** File-level warnings before the mutation (so banners revert too). */
  warnings: FileReview['warnings'];
}

interface UndoSnapshot {
  scope: 'hunk-action' | 'bulk-file' | 'bulk-session' | 'snapshot-revert' | 'undo-hunk';
  /** Affected files keyed by absolute path. */
  files: Map<AbsPath, UndoSnapshotFile>;
  /**
   * Phase β.0 (FR-B0.7): the specific hunk index toggled by the originating
   * action — populated only when `scope === 'hunk-action' | 'undo-hunk'`.
   * Used to attach `target.hunkIdx` on the emitted `undo` event so
   * `reconstructSessionReview` can pinpoint the reverted hunk without
   * inferring it from per-hunk status diffs.
   */
  hunkIdx?: number;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Exported for unit tests. */
export const __test = { recomputeFileStatus, recomputeMetrics, relativePathSafe };
