import { describe, it, expect } from 'vitest';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, FileReview, HunkStatus, SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

/**
 * Memory leak smoke (TRD §15, M6 exit gate).
 *
 *   Open → dismiss 50 sessions in sequence; assert ΔRSS < 50 MB.
 *
 * This catches the obvious classes of leak (un-released session data,
 * uncancelled timers, dangling AbortControllers). It can't catch every
 * leak — that's what manual heap profiles are for — but it pins the
 * happy path against the budget the TRD set.
 */

class StubPanel implements PanelGateway {
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_sessionId: SessionId, _filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_sessionId: SessionId, _filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict(_sessionId: SessionId, _filePath: AbsPath, _attemptedHunkIndex: number, _conflictingHunks: number[]) {}
  postUndoStackDepth(_sid: SessionId, _depth: number) {}
  postRejectionDrafts(_sid: SessionId, _drafts: ReadonlyArray<{ filePath: string; relPath: string; hunkIdx: number; reason: string; ts: number }>) { void _drafts; }
  postBuildSignal(_sid: SessionId, _signal: import('../../src/types.js').BuildSignal) { void _signal; }
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
}

const SESSIONS = 50;
const FILES_PER_SESSION = 5;
const RSS_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB

describe('memory — sequential session lifecycle', () => {
  it(`opens & dismisses ${SESSIONS} sessions without growing RSS by > ${RSS_BUDGET_BYTES / 1024 / 1024} MB`, async () => {
    if (typeof global.gc !== 'function') {
      // Skip cleanly: this test is most reliable with --expose-gc.
      // eslint-disable-next-line no-console
      console.warn('[mem] global.gc not available; running test but RSS measurements will be noisy.');
    }

    const store = new SnapshotStore({ maxSessionBytes: 5 * 1024 * 1024, maxFilesPerSession: 50 });
    const orchestrator = new ReviewOrchestrator({
      store,
      panel: new StubPanel(),
      logger: new Logger('mem', 'error'),
      readFile: async () => 'after content\n',
      writeFile: async () => {},
    });

    // Warm-up: V8 lazy compilations etc. shouldn't count toward growth.
    for (let i = 0; i < 3; i++) {
      await runOneSession(orchestrator, store, `warm-${i}`);
    }
    if (global.gc) global.gc();
    const baseline = process.memoryUsage().rss;

    for (let i = 0; i < SESSIONS; i++) {
      await runOneSession(orchestrator, store, `s-${i}`);
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage().rss;
    const delta = after - baseline;

    // eslint-disable-next-line no-console
    console.log(`[mem] ΔRSS over ${SESSIONS} sessions: ${(delta / 1024 / 1024).toFixed(1)} MB (baseline ${(baseline / 1024 / 1024).toFixed(1)} MB)`);

    expect(delta).toBeLessThan(RSS_BUDGET_BYTES);
    // Active sessions and store entries must both be empty after dismiss.
    expect(orchestrator.listSessionIds().length).toBe(0);
    expect(store.size()).toBe(0);
  }, 60_000);
});

async function runOneSession(orchestrator: ReviewOrchestrator, store: SnapshotStore, sid: string): Promise<void> {
  for (let i = 0; i < FILES_PER_SESSION; i++) {
    const cap = await store.captureOriginal(sid, process.cwd(), `mem_${sid}_${i}.ts`);
    if (cap) store.get(sid)!.originals.set(cap, 'before content\n');
    store.recordTouched(sid, process.cwd(), `mem_${sid}_${i}.ts`);
  }
  orchestrator.handleStop(sid, false, null);
  await new Promise((r) => setTimeout(r, 320));
  orchestrator.dismissSession(sid);
}
