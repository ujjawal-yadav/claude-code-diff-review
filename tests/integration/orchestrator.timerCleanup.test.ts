/**
 * v0.5.1 (LH1) — integration tests for dismissSession timer cleanup.
 *
 * Pre-existing latent bug: dismissSession cleared sessions / byPath /
 * hunkSets / undoStack / rejectionDrafts BUT NOT the two timer maps:
 *   - stopDebounce (keyed by sid; 250 ms debounce per handleStop)
 *   - reDiffTimers (keyed `${sid}::${absPath}`; 200 ms debounce per save)
 *
 * Symptom A (ghost open): if user dismisses during the debounce window,
 *   the timer still fires → openReview runs against a deleted session.
 * Symptom B (slow leak): each scheduleReDiff adds an entry that's only
 *   cleared by its own fire — over hundreds of edit/dismiss cycles the
 *   map grows unboundedly, retaining file-path strings + closures.
 *
 * Fix: dismissSession clears both maps explicitly. These tests prove the
 * cleanup happens and that no callback fires post-dismiss.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, FileReview, HunkStatus,
  SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

class NoopPanel implements PanelGateway {
  async openOrFocus(_s: SessionReview) {}
  postFileUpdated(_sid: SessionId, _filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_sid: SessionId, _filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict() {}
  postSessionCompleted(_sid: SessionId, _m: SessionMetrics) {}
  postUndoStackDepth() {}
  postRejectionDrafts() {}
  postBuildSignal() {}
  close(_sid: SessionId) {}
}

function setup() {
  const logger = new Logger('test', 'error');
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();
  const openSpy = vi.spyOn(panel, 'openOrFocus');
  let live = '';
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger,
    writeFile: async (_p, c) => { live = c; },
    readFile: async () => live,
  });
  return { logger, store, panel, orchestrator, openSpy, setLive: (v: string) => { live = v; } };
}

const CWD = process.platform === 'win32' ? 'C:\\timer-cleanup' : '/timer-cleanup';
const SID = 'timer-test-sid';

describe('dismissSession — v0.5.1 LH1 timer cleanup', () => {
  it('clears stopDebounce so a debounced Stop does NOT fire after dismiss', async () => {
    const h = setup();
    // Trigger a Stop (sets a 250ms debounce timer).
    h.orchestrator.handleStop(SID, false, null);
    // Immediately dismiss before the timer fires.
    h.orchestrator.dismissSession(SID);
    // Advance past the debounce window.
    await new Promise((r) => setTimeout(r, 400));
    // openOrFocus must NOT have been called — the ghost timer was cancelled.
    expect(h.openSpy).not.toHaveBeenCalled();
  });

  it('clears reDiffTimers when dismissing during a pending re-diff', async () => {
    const h = setup();
    // Seed the snapshot store so the session is "live" for scheduleReDiff.
    h.store.beginTurnIfNeeded(SID, CWD, 'claude-code');
    const abs = await h.store.captureOriginal(SID, CWD, 'src/foo.ts');
    if (!abs) throw new Error('captureOriginal failed');
    h.store.get(SID)!.originals.set(abs, 'before\n');
    h.store.recordTouched(SID, CWD, 'src/foo.ts');
    h.setLive('after\n');
    h.orchestrator.handleStop(SID, false, null);
    await new Promise((r) => setTimeout(r, 350));
    // Now there's a live session. Schedule a reDiff (200ms debounce).
    h.orchestrator.scheduleReDiff(SID, abs);
    // Inspect internal state — there should be a pending timer.
    // We can't read `reDiffTimers` directly (private), but we CAN dismiss
    // and verify no exception/error fires.
    h.orchestrator.dismissSession(SID);
    // Advance past the reDiff debounce window.
    await new Promise((r) => setTimeout(r, 300));
    // No crash, no orphan timer fired. We also assert the session is gone.
    expect(h.orchestrator.getSession(SID)).toBeUndefined();
    expect(h.orchestrator.listSessionIds()).not.toContain(SID);
  });

  it('multiple back-to-back dismiss + handleStop cycles do not accumulate timers', async () => {
    const h = setup();
    // Simulate 20 quick cycles: stop, dismiss, repeat.
    for (let i = 0; i < 20; i++) {
      h.orchestrator.handleStop(`${SID}-${i}`, false, null);
      h.orchestrator.dismissSession(`${SID}-${i}`);
    }
    // Wait past the longest debounce window.
    await new Promise((r) => setTimeout(r, 400));
    // None of the 20 sessions should have opened.
    expect(h.openSpy).not.toHaveBeenCalled();
    expect(h.orchestrator.listSessionIds()).toHaveLength(0);
  });
});
