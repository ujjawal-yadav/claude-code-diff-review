import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewOrchestrator, PanelGateway, __test } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import { computeDiff } from '../../src/diffEngine.js';
import {
  asAbsPath,
  AbsPath,
  FileReview,
  HunkReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from '../../src/types.js';

class FakePanel implements PanelGateway {
  opened: SessionReview[] = [];
  fileUpdates: Array<{ filePath: AbsPath; file: FileReview }> = [];
  hunkApplied: Array<{ filePath: AbsPath; hunkIndex: number; status: HunkStatus }> = [];
  completed: Array<{ sessionId: SessionId; metrics: SessionMetrics }> = [];
  closed: SessionId[] = [];

  async openOrFocus(session: SessionReview) { this.opened.push(session); }
  postFileUpdated(filePath: AbsPath, file: FileReview) { this.fileUpdates.push({ filePath, file }); }
  postHunkApplied(filePath: AbsPath, hunkIndex: number, status: HunkStatus) {
    this.hunkApplied.push({ filePath, hunkIndex, status });
  }
  postSessionCompleted(sessionId: SessionId, metrics: SessionMetrics) { this.completed.push({ sessionId, metrics }); }
  close(sessionId: SessionId) { this.closed.push(sessionId); }
}

function makeOrchestrator(opts?: { onWrite?: (p: AbsPath, c: string) => Promise<void>; onRead?: (p: AbsPath) => Promise<string> }) {
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new FakePanel();
  const logger = new Logger('test', 'error');
  const written = new Map<AbsPath, string>();
  const orchestrator = new ReviewOrchestrator({
    store,
    panel,
    logger,
    writeFile: opts?.onWrite ?? (async (p, c) => { written.set(p, c); }),
    readFile:  opts?.onRead  ?? (async () => { throw new Error('read not stubbed'); }),
  });
  return { orchestrator, store, panel, written, logger };
}

describe('orchestrator — pure helpers', () => {
  it('recomputeFileStatus marks accepted when all decided positively', () => {
    const hunks: HunkReview[] = [
      { index: 0, header: '', lines: [], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, status: 'accepted' },
      { index: 1, header: '', lines: [], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, status: 'accepted' },
    ];
    expect(__test.recomputeFileStatus(hunks)).toBe('accepted');
  });

  it('recomputeFileStatus marks partial on mixed decisions', () => {
    const hunks: HunkReview[] = [
      { index: 0, header: '', lines: [], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, status: 'accepted' },
      { index: 1, header: '', lines: [], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, status: 'rejected' },
    ];
    expect(__test.recomputeFileStatus(hunks)).toBe('partial');
  });

  it('recomputeFileStatus marks pending when none decided', () => {
    const hunks: HunkReview[] = [
      { index: 0, header: '', lines: [], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, status: 'pending' },
    ];
    expect(__test.recomputeFileStatus(hunks)).toBe('pending');
  });

  it('relativePathSafe forward-slashes the result', () => {
    const r = __test.relativePathSafe('/work', '/work/src/foo.ts');
    expect(r).toBe('src/foo.ts');
  });
});

describe('orchestrator — handleStop flow', () => {
  beforeEach(() => {
    // No-op
  });

  it('opens review with computed diffs after stop', async () => {
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'one\nTWO\nthree\n',
    });
    // Pre-populate store: one touched file with original "two"
    const sid = 'sid1';
    const cwd = '/work';
    await store.captureOriginal(sid, cwd, 'a.ts'); // file does not exist => '' captured
    // Override the captured original to simulate a real before-snapshot.
    store.get(sid)!.originals.set(asAbsPath('/work/a.ts'), 'one\ntwo\nthree\n');
    store.recordTouched(sid, cwd, 'a.ts');

    orchestrator.handleStop(sid, false, 'Refactored.');
    await waitDebounce();

    expect(panel.opened.length).toBe(1);
    expect(panel.opened[0].files.length).toBe(1);
    expect(panel.opened[0].files[0].hunks.length).toBe(1);
    expect(panel.opened[0].lastAssistantMessage).toBe('Refactored.');
  });

  it('does NOT open when stop_hook_active=true', async () => {
    const { orchestrator, panel } = makeOrchestrator();
    orchestrator.handleStop('sid', true, null);
    await waitDebounce();
    expect(panel.opened.length).toBe(0);
  });

  it('does NOT open when no touched files', async () => {
    const { orchestrator, panel } = makeOrchestrator();
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();
    expect(panel.opened.length).toBe(0);
  });

  it('debounces multiple Stop events into one open', async () => {
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'one\nTWO\nthree\n',
    });
    const sid = 'sid';
    await store.captureOriginal(sid, '/work', 'a.ts');
    store.get(sid)!.originals.set(asAbsPath('/work/a.ts'), 'one\ntwo\nthree\n');
    store.recordTouched(sid, '/work', 'a.ts');

    orchestrator.handleStop(sid, false, null);
    orchestrator.handleStop(sid, false, null);
    orchestrator.handleStop(sid, false, null);
    await waitDebounce();

    expect(panel.opened.length).toBe(1);
  });

  it('circuit breaker trips after 5 reopens in 60s', async () => {
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'x\n',
    });
    const sid = 'sid';
    await store.captureOriginal(sid, '/work', 'a.ts');
    store.get(sid)!.originals.set(asAbsPath('/work/a.ts'), 'y\n');
    store.recordTouched(sid, '/work', 'a.ts');

    // First five must succeed, sixth must be gated by circuit breaker.
    for (let i = 0; i < 6; i++) {
      orchestrator.handleStop(sid, false, null);
      await waitDebounce();
      // Reset the panel state so each call has a clean slate; but openings still accumulate.
    }
    expect(panel.opened.length).toBe(5);
  });
});

describe('orchestrator — handleHunkAction', () => {
  // Build a sid + resolved abspath that matches the store's normalisation
  async function seed(store: SnapshotStore, before: string, sid = 'sid', rel = 'a.ts'): Promise<{ abs: AbsPath }> {
    const cwd = process.cwd(); // real, normalised cwd → resolveSafe will accept relative children
    const abs = (await store.captureOriginal(sid, cwd, rel))!;
    store.get(sid)!.originals.set(abs, before);
    store.recordTouched(sid, cwd, rel);
    return { abs };
  }

  it('reject calls revertHunk and writes the reverted content', async () => {
    const { orchestrator, store, panel, written } = makeOrchestrator({
      onRead: async () => 'one\nTWO\nthree\n',
    });
    const { abs } = await seed(store, 'one\ntwo\nthree\n');
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();

    await orchestrator.handleHunkAction('sid', abs, 0, 'reject');

    expect(written.get(abs)).toBe('one\ntwo\nthree\n');
    expect(panel.hunkApplied[0]).toEqual({ filePath: abs, hunkIndex: 0, status: 'rejected' });
  });

  it('accept does not call write but marks the hunk', async () => {
    const writes: Array<[AbsPath, string]> = [];
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'one\nTWO\nthree\n',
      onWrite: async (p, c) => { writes.push([p, c]); },
    });
    const { abs } = await seed(store, 'one\ntwo\nthree\n');
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();

    await orchestrator.handleHunkAction('sid', abs, 0, 'accept');

    expect(writes.length).toBe(0);
    expect(panel.hunkApplied[0].status).toBe('accepted');
  });

  it('completing all hunks emits session-completed', async () => {
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'one\nTWO\nthree\n',
    });
    const { abs } = await seed(store, 'one\ntwo\nthree\n');
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();

    await orchestrator.handleHunkAction('sid', abs, 0, 'accept');

    expect(panel.completed.length).toBe(1);
    expect(panel.completed[0].sessionId).toBe('sid');
  });

  it('handleBulk session/accept marks every pending hunk', async () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';
    const after  = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n';
    const sampleAbs = asAbsPath('/probe');
    const sample = computeDiff(sampleAbs, before, after);
    expect(sample.hunks.length).toBe(2);

    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => after,
    });
    await seed(store, before);
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();

    await orchestrator.handleBulk('sid', 'session', 'accept');

    const review = orchestrator.getSession('sid')!;
    expect(review.files[0].hunks.every((h) => h.status === 'accepted')).toBe(true);
    expect(panel.completed.length).toBe(1);
  });
});

describe('orchestrator — revertFileToSnapshot', () => {
  async function seed(store: SnapshotStore, before: string, sid = 'sid', rel = 'a.ts'): Promise<{ abs: AbsPath }> {
    const cwd = process.cwd();
    const abs = (await store.captureOriginal(sid, cwd, rel))!;
    store.get(sid)!.originals.set(abs, before);
    store.recordTouched(sid, cwd, rel);
    return { abs };
  }

  it('writes the captured original back to disk and rejects every pending hunk', async () => {
    const before = 'one\ntwo\nthree\n';
    const after  = 'one\nTWO\nthree\n';
    const writes: Array<[AbsPath, string]> = [];
    const { orchestrator, store } = makeOrchestrator({
      onRead: async () => after,
      onWrite: async (p, c) => { writes.push([p, c]); },
    });
    const { abs } = await seed(store, before);
    orchestrator.handleStop('sid', false, null);
    await waitDebounce();

    await orchestrator.revertFileToSnapshot('sid', abs);

    expect(writes.length).toBe(1);
    expect(writes[0][1]).toBe(before);
    const review = orchestrator.getSession('sid')!;
    expect(review.files[0].hunks.every((h) => h.status === 'rejected')).toBe(true);
    expect(review.files[0].after).toBe(before);
    expect(review.files[0].warnings.includes('fuzz-failed-revert')).toBe(false);
  });

  it('is a no-op for unknown sessions', async () => {
    const writes: Array<[AbsPath, string]> = [];
    const { orchestrator } = makeOrchestrator({
      onWrite: async (p, c) => { writes.push([p, c]); },
    });
    await orchestrator.revertFileToSnapshot('no-such', '/no/file.ts');
    expect(writes.length).toBe(0);
  });
});

describe('orchestrator — dismissSession', () => {
  it('closes the panel, removes review state, releases the snapshot store', async () => {
    const { orchestrator, store, panel } = makeOrchestrator({
      onRead: async () => 'x\n',
    });
    const sid = 'sid';
    await store.captureOriginal(sid, '/work', 'a.ts');
    store.get(sid)!.originals.set(asAbsPath('/work/a.ts'), 'y\n');
    store.recordTouched(sid, '/work', 'a.ts');
    orchestrator.handleStop(sid, false, null);
    await waitDebounce();

    orchestrator.dismissSession(sid);

    expect(panel.closed[0]).toBe(sid);
    expect(orchestrator.getSession(sid)).toBeUndefined();
    expect(store.get(sid)).toBeUndefined();
  });
});

async function waitDebounce(): Promise<void> {
  // STOP_DEBOUNCE_MS = 250 in source.
  await new Promise((r) => setTimeout(r, 320));
}
