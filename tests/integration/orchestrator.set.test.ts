/**
 * Integration: orchestrator + set-based pipeline end-to-end.
 *
 * Phase α Track 6 — verifies the rename from "sequential disk mutation"
 * to "set membership render" preserves the on-disk semantics that the
 * webview and CodeLens consumers depend on.
 */

import { describe, it, expect } from 'vitest';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from '../../src/types.js';

class CapturingPanel implements PanelGateway {
  opened: SessionReview[] = [];
  fileUpdates: Array<{ sessionId: SessionId; filePath: AbsPath; file: FileReview }> = [];
  hunkApplied: Array<{ sessionId: SessionId; filePath: AbsPath; hunkIndex: number; status: HunkStatus }> = [];
  setConflicts: Array<{ sessionId: SessionId; filePath: AbsPath; attemptedHunkIndex: number; conflictingHunks: number[] }> = [];
  completed: Array<{ sessionId: SessionId; metrics: SessionMetrics }> = [];
  async openOrFocus(session: SessionReview) { this.opened.push(session); }
  postFileUpdated(sessionId: SessionId, filePath: AbsPath, file: FileReview) {
    this.fileUpdates.push({ sessionId, filePath, file });
  }
  postHunkApplied(sessionId: SessionId, filePath: AbsPath, hunkIndex: number, status: HunkStatus) {
    this.hunkApplied.push({ sessionId, filePath, hunkIndex, status });
  }
  postSetConflict(sessionId: SessionId, filePath: AbsPath, attemptedHunkIndex: number, conflictingHunks: number[]) {
    this.setConflicts.push({ sessionId, filePath, attemptedHunkIndex, conflictingHunks });
  }
  undoDepths: number[] = [];
  postUndoStackDepth(_sid: SessionId, depth: number) { this.undoDepths.push(depth); }
  postRejectionDrafts(_sid: SessionId, _drafts: ReadonlyArray<{ filePath: string; relPath: string; hunkIdx: number; reason: string; ts: number }>) { void _drafts; }
  postBuildSignal(_sid: SessionId, _signal: import('../../src/types.js').BuildSignal) { void _signal; }
  postSessionCompleted(sessionId: SessionId, metrics: SessionMetrics) {
    this.completed.push({ sessionId, metrics });
  }
  close(_sessionId: SessionId) {}
}

function buildHarness(opts: { before: string; after: string }) {
  // Track every write as a separate entry (a Map keyed by path would
  // collapse repeat writes to the same file into a single entry).
  const writes = new Map<string, string>();
  const writeCalls: Array<{ path: string; content: string }> = [];
  // Track the "live" disk: starts at `after` (Claude's edit) and follows writes.
  let live = opts.after;
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new CapturingPanel();
  const logger = new Logger('test', 'error');
  const orchestrator = new ReviewOrchestrator({
    store,
    panel,
    logger,
    writeFile: async (p, c) => {
      writes.set(p, c);
      writeCalls.push({ path: p, content: c });
      live = c;
    },
    readFile: async () => live,
  });
  return { orchestrator, store, panel, writes, writeCalls, getLive: () => live };
}

const SID = 'integration-set-sid';
const CWD = process.platform === 'win32' ? 'C:\\integration' : '/integration';
const REL = 'src/file.ts';

/**
 * Seed the snapshot store and trigger Stop. Uses the resolved AbsPath
 * returned by `captureOriginal` as the source of truth — the orchestrator
 * keys hunk-set state by that resolved path, not by whatever string we
 * passed in. Returns the resolved AbsPath for use in subsequent calls.
 */
async function seedAndOpen(
  harness: ReturnType<typeof buildHarness>,
  before: string,
): Promise<AbsPath> {
  const resolved = await harness.store.captureOriginal(SID, CWD, REL);
  if (!resolved) throw new Error('captureOriginal failed (path traversal?)');
  harness.store.get(SID)!.originals.set(resolved, before);
  harness.store.recordTouched(SID, CWD, REL);
  harness.orchestrator.handleStop(SID, false, null);
  // Wait for stop debounce + open
  await new Promise((r) => setTimeout(r, 350));
  return resolved;
}

describe('orchestrator + set pipeline — integration', () => {
  it('Bug A: files Claude touched but did not change are skipped from the review', async () => {
    // Same before and after — Claude "wrote" identical content.
    const identical = 'unchanged\ncontent\nhere\n';
    const harness = buildHarness({ before: identical, after: identical });
    await seedAndOpen(harness, identical);

    expect(harness.panel.opened.length).toBe(1);
    // The review opens, but the touched-but-unchanged file is filtered out.
    // (sessionData.touched still has the path; the review just doesn't surface it.)
    expect(harness.panel.opened[0].files.length).toBe(0);
  });

  it('initial state after Stop: disk content equals Claude after-content (acceptedSet=all)', async () => {
    // Lines well-separated (context=3 gives 7-line hunk window each, need ≥10 apart)
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'line 5 MODIFIED';
    afterArr[25] = 'line 25 MODIFIED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    await seedAndOpen(harness, before);

    expect(harness.panel.opened.length).toBe(1);
    const file = harness.panel.opened[0].files[0];
    expect(file.hunks.length).toBe(2);
    // No writes yet — we only read the post-edit disk to build the diff.
    expect(harness.writes.size).toBe(0);
    // Disk content unchanged.
    expect(harness.getLive()).toBe(after);
  });

  it('rejecting hunk 0 writes content that reverts hunk 0 but keeps hunk 1', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'line 5 MODIFIED';
    afterArr[25] = 'line 25 MODIFIED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'reject');

    // A write happened — the new disk content reverts line 5 but keeps line 25.
    expect(harness.writes.size).toBe(1);
    const written = harness.writes.get(abs)!;
    expect(written.includes('line 5 MODIFIED')).toBe(false);
    expect(written.includes('line 5\n')).toBe(true);
    expect(written.includes('line 25 MODIFIED')).toBe(true);

    // The orchestrator notified the panel of the hunk status change.
    expect(harness.panel.hunkApplied).toEqual([
      { sessionId: SID, filePath: abs, hunkIndex: 0, status: 'rejected' },
    ]);
    // No set conflicts surfaced.
    expect(harness.panel.setConflicts.length).toBe(0);
  });

  it('bulk reject-all writes the snapshot once (single FS write, no per-hunk reverts)', async () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'X5';
    afterArr[25] = 'X25';
    afterArr[45] = 'X45';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleBulk(SID, 'file', 'reject', abs);

    expect(harness.writes.size).toBe(1);
    expect(harness.writes.get(abs)).toBe(before);
    // Every hunk should be rejected in the in-memory file state.
    const file = harness.orchestrator.getSession(SID)!.files[0];
    expect(file.hunks.every((h) => h.status === 'rejected')).toBe(true);
  });

  it('M9.2.9: undo a rejected hunk re-applies the change and marks the hunk pending', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5] = 'line 5 MODIFIED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    // Reject hunk 0 → disk reverts.
    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'reject');
    expect(harness.writes.size).toBe(1);
    expect(harness.writes.get(abs)!.includes('line 5 MODIFIED')).toBe(false);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('rejected');

    // Undo: hunk re-applies and status flips to pending.
    await harness.orchestrator.handleUndoHunkDecision(SID, abs, 0);
    expect(harness.writeCalls.length).toBe(2);
    expect(harness.writes.get(abs)!.includes('line 5 MODIFIED')).toBe(true);
    const hunk = harness.orchestrator.getSession(SID)!.files[0].hunks[0];
    expect(hunk.status).toBe('pending');
    expect(hunk.decidedAt).toBeUndefined();
  });

  it('M9.2.9: undo an accepted hunk reverts it and marks the hunk pending', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5] = 'CHANGED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    // Accept the single hunk (no disk write because already applied).
    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'accept');
    expect(harness.writes.size).toBe(0);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('accepted');

    // Undo: the hunk is removed from acceptedSet, disk reverts to snapshot
    // for that hunk; status flips to pending.
    await harness.orchestrator.handleUndoHunkDecision(SID, abs, 0);
    expect(harness.writes.size).toBe(1);
    expect(harness.writes.get(abs)!.includes('CHANGED')).toBe(false);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('pending');
  });

  it('M9.2.9: undo is a no-op on a pending hunk', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5] = 'CHANGED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleUndoHunkDecision(SID, abs, 0);
    expect(harness.writes.size).toBe(0);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('pending');
  });

  it('Option A: undo last action — undoes a single hunk reject', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'line 5 MODIFIED';
    afterArr[25] = 'line 25 MODIFIED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'reject');
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('rejected');
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(1);

    await harness.orchestrator.handleUndoLastAction(SID);
    const hunk = harness.orchestrator.getSession(SID)!.files[0].hunks[0];
    expect(hunk.status).toBe('pending');
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(0);
    // Disk content restored to Claude's after (the line-5 modification is back).
    expect(harness.getLive().includes('line 5 MODIFIED')).toBe(true);
  });

  it('Option A: undo last action — undoes a bulk reject-all in one step', async () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'X5';
    afterArr[25] = 'X25';
    afterArr[45] = 'X45';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleBulk(SID, 'file', 'reject', abs);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks.every((h) => h.status === 'rejected')).toBe(true);
    expect(harness.getLive()).toBe(before);

    await harness.orchestrator.handleUndoLastAction(SID);
    const file = harness.orchestrator.getSession(SID)!.files[0];
    expect(file.hunks.every((h) => h.status === 'pending')).toBe(true);
    expect(harness.getLive()).toBe(after);
  });

  it('Option A: undo stack respects LIFO order across multiple actions', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'A';
    afterArr[25] = 'B';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'accept');  // depth 1
    await harness.orchestrator.handleHunkAction(SID, abs, 1, 'reject');  // depth 2
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(2);

    // Undo the most recent (reject) → hunk 1 back to pending
    await harness.orchestrator.handleUndoLastAction(SID);
    const session1 = harness.orchestrator.getSession(SID)!;
    expect(session1.files[0].hunks[0].status).toBe('accepted'); // first action survives
    expect(session1.files[0].hunks[1].status).toBe('pending');
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(1);

    // Undo again → hunk 0 back to pending
    await harness.orchestrator.handleUndoLastAction(SID);
    const session2 = harness.orchestrator.getSession(SID)!;
    expect(session2.files[0].hunks[0].status).toBe('pending');
    expect(session2.files[0].hunks[1].status).toBe('pending');
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(0);

    // Empty stack undo is a no-op
    await harness.orchestrator.handleUndoLastAction(SID);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks.every((h) => h.status === 'pending')).toBe(true);
  });

  it('Option A: dismissSession clears the undo stack', async () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5] = 'CHANGED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'reject');
    expect(harness.panel.undoDepths[harness.panel.undoDepths.length - 1]).toBe(1);

    harness.orchestrator.dismissSession(SID);
    // Session is gone; undo on a dismissed session is a no-op (early return).
    await harness.orchestrator.handleUndoLastAction(SID);
    expect(harness.orchestrator.getSession(SID)).toBeUndefined();
  });

  it('accept on an already-applied hunk skips disk write but flips status', async () => {
    // Initial state: all hunks in acceptedSet. Accept = no-op on the set.
    // The setsEqual short-circuit means no render and no write.
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5] = 'CHANGED';
    const after = afterArr.join('\n');
    const harness = buildHarness({ before, after });
    const abs = await seedAndOpen(harness, before);

    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'accept');

    expect(harness.writes.size).toBe(0);
    const file = harness.orchestrator.getSession(SID)!.files[0];
    expect(file.hunks[0].status).toBe('accepted');
  });
});
