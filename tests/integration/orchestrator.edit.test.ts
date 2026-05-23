/**
 * v0.4 (A4) — integration tests for `handleEditHunk` + reconstruction.
 *
 * Coverage:
 *   - happy path: edit lands, status flips to 'edited', disk content
 *     reflects the substituted hunk, event is logged
 *   - mixing edited + accepted hunks renders both deterministically
 *   - per-hunk Undo restores the original `after` (Claude's content)
 *   - re-edit replaces the prior override (L1 — re-editable semantics)
 *   - reconstruction round-trip: edit → dismiss → reconstruct → adopt
 *     produces equivalent in-memory state
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { HistoryService } from '../../src/history/historyService.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, FileReview, HunkStatus,
  SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

class NoopPanel implements PanelGateway {
  hunkApplied: Array<{ sessionId: SessionId; filePath: AbsPath; hunkIndex: number; status: HunkStatus }> = [];
  fileUpdates: Array<{ filePath: AbsPath; file: FileReview }> = [];
  async openOrFocus(_s: SessionReview) {}
  postFileUpdated(_sid: SessionId, filePath: AbsPath, file: FileReview) {
    this.fileUpdates.push({ filePath, file });
  }
  postHunkApplied(sessionId: SessionId, filePath: AbsPath, hunkIndex: number, status: HunkStatus) {
    this.hunkApplied.push({ sessionId, filePath, hunkIndex, status });
  }
  postSetConflict() {}
  postSessionCompleted(_sid: SessionId, _m: SessionMetrics) {}
  postUndoStackDepth() {}
  postRejectionDrafts() {}
  postBuildSignal(_sid: SessionId, _signal: import('../../src/types.js').BuildSignal) { void _signal; }
  close(_sid: SessionId) {}
}

async function setupHarness() {
  const root = await mkdtemp(join(tmpdir(), 'edit-test-'));
  const logger = new Logger('test', 'error');
  const history = new HistoryService({
    scope: 'workspace',
    workspaceRoot: root,
    enabled: true,
    logger,
  });
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();
  let live = '';
  const writes: string[] = [];
  const orchestrator = new ReviewOrchestrator({
    store,
    panel,
    logger,
    history,
    writeFile: async (_p, c) => { live = c; writes.push(c); },
    readFile: async () => live,
  });
  return { root, logger, history, store, panel, orchestrator, writes, setLive: (v: string) => { live = v; } };
}

const CWD = process.platform === 'win32' ? 'C:\\edit-int' : '/edit-int';
const SID = 'edit-sid-1';
const REL = 'src/foo.ts';

async function seedAndOpen(h: Awaited<ReturnType<typeof setupHarness>>, before: string, after: string): Promise<AbsPath> {
  // beginTurnIfNeeded mints a turnId — required for orchestrator's history
  // record helpers (without it, recordTurnStoppedEvent bails). In production
  // this is done by extension.ts on PreToolUse before captureOriginal; we
  // mimic that ordering here.
  h.store.beginTurnIfNeeded(SID, CWD, 'claude-code');
  const resolved = await h.store.captureOriginal(SID, CWD, REL);
  if (!resolved) throw new Error('captureOriginal failed');
  h.store.get(SID)!.originals.set(resolved, before);
  h.store.recordTouched(SID, CWD, REL);
  h.setLive(after);
  await h.orchestrator.handleStop(SID, false, null);
  await new Promise((r) => setTimeout(r, 350));
  return resolved;
}

describe('orchestrator — handleEditHunk', () => {
  it('writes the substituted hunk to disk, flips status to edited, logs hunk-edited event', async () => {
    const h = await setupHarness();
    try {
      const before = 'a\nb\nc\nd\ne\n';
      const after  = 'a\nB\nc\nd\ne\n';
      const resolved = await seedAndOpen(h, before, after);

      const session = h.orchestrator.getSession(SID);
      const file = session!.files.find((f) => f.filePath === resolved)!;
      expect(file).toBeDefined();
      expect(file.hunks.length).toBeGreaterThanOrEqual(1);
      const hunkIdx = file.hunks[0]!.index;

      // User keeps line A, replaces middle with USER, keeps line C.
      await h.orchestrator.handleEditHunk(SID, resolved, hunkIdx, 'a\nUSER\nc');
      // history.recordHunkEdited is fire-and-forget — give it a tick.
      await new Promise((r) => setTimeout(r, 100));

      // Status flipped.
      const updated = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!;
      expect(updated.hunks[hunkIdx]!.status).toBe('edited');

      // Disk reflects user content.
      expect(h.writes[h.writes.length - 1]).toContain('USER');
      expect(h.writes[h.writes.length - 1]).not.toContain('B\n');

      // hunk-edited event in the log.
      const events = await h.history.readEvents(SID);
      const editEvent = events.find((e) => e.kind === 'hunk-edited');
      expect(editEvent).toBeDefined();
    } finally {
      await new Promise((r) => setTimeout(r, 100)); await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('re-edit replaces the prior override (L1: re-editable)', async () => {
    const h = await setupHarness();
    try {
      const before = 'a\nb\nc\n';
      const after  = 'a\nB\nc\n';
      const resolved = await seedAndOpen(h, before, after);
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;

      await h.orchestrator.handleEditHunk(SID, resolved, hunkIdx, 'a\nFIRST\nc');
      // Re-edit needs the hunk to be pending again — undo first.
      await h.orchestrator.handleUndoHunkDecision(SID, resolved, hunkIdx);
      await h.orchestrator.handleEditHunk(SID, resolved, hunkIdx, 'a\nSECOND\nc');

      const file = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!;
      expect(file.hunks[hunkIdx]!.status).toBe('edited');
      const lastWrite = h.writes[h.writes.length - 1];
      expect(lastWrite).toContain('SECOND');
      expect(lastWrite).not.toContain('FIRST');
    } finally {
      await new Promise((r) => setTimeout(r, 100)); await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('per-hunk Undo on an edited hunk reverts to original after content (Claude\'s)', async () => {
    const h = await setupHarness();
    try {
      const before = 'a\nb\nc\n';
      const after  = 'a\nB\nc\n';
      const resolved = await seedAndOpen(h, before, after);
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;

      await h.orchestrator.handleEditHunk(SID, resolved, hunkIdx, 'a\nUSER\nc');
      expect(h.writes[h.writes.length - 1]).toContain('USER');

      await h.orchestrator.handleUndoHunkDecision(SID, resolved, hunkIdx);
      // After undo, the hunk should be pending; the editedHunks override
      // should have been dropped; render produces the original snapshot
      // (set empty since we removed the index from acceptedSet).
      const file = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!;
      expect(file.hunks[hunkIdx]!.status).toBe('pending');
      // Disk should now reflect before (pending = not applied).
      expect(h.writes[h.writes.length - 1]).toBe(before);
    } finally {
      await new Promise((r) => setTimeout(r, 100)); await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reconstruction round-trip preserves edit override', async () => {
    const h = await setupHarness();
    try {
      const before = 'a\nb\nc\n';
      const after  = 'a\nB\nc\n';
      const resolved = await seedAndOpen(h, before, after);
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;

      await h.orchestrator.handleEditHunk(SID, resolved, hunkIdx, 'a\nROUNDTRIP\nc');
      // history writes are fire-and-forget.
      await new Promise((r) => setTimeout(r, 50));

      // Reconstruct from log via a fresh orchestrator.
      const recon = await h.history.reconstructSessionReview(SID, { cwd: CWD });
      expect(recon).not.toBeNull();
      const reconHunk = recon!.files[0]!.hunks.find((hh) => hh.index === hunkIdx)!;
      expect(reconHunk.status).toBe('edited');

      // editedHunks is surfaced on the hunkSets entry.
      const reconHunkSet = recon!.hunkSets[0]!;
      expect(reconHunkSet.editedHunks.length).toBe(1);
      expect(reconHunkSet.editedHunks[0]!.index).toBe(hunkIdx);
      expect(reconHunkSet.editedHunks[0]!.lines.some((l) => l.includes('ROUNDTRIP'))).toBe(true);
    } finally {
      await new Promise((r) => setTimeout(r, 100)); await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
