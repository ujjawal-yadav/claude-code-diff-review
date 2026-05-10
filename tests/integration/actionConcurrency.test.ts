import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, FileReview, HunkStatus, SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

/**
 * Action-path correctness under concurrency and FS failure (M6 polish).
 *
 * Goal: prove that
 *   1. Concurrent reject clicks on different hunks of one file converge to
 *      a deterministic on-disk state (= the captured `before`).
 *   2. Concurrent reject clicks on hunks of *different* files run in
 *      parallel without cross-file interference.
 *   3. A write that throws does not corrupt review state — the hunk stays
 *      pending, the file is flagged, the user can retry.
 *   4. Bulk-reject on a file with all-pending hunks fast-paths to a
 *      snapshot write (one fs.writeFile, not per-hunk).
 */

class CapturingPanel implements PanelGateway {
  fileUpdates: Array<{ filePath: AbsPath; warnings: string[] }> = [];
  hunkApplied: Array<{ filePath: AbsPath; hunkIndex: number; status: HunkStatus }> = [];
  completed: Array<{ sessionId: SessionId }> = [];
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(filePath: AbsPath, file: FileReview) {
    this.fileUpdates.push({ filePath, warnings: [...file.warnings] });
  }
  postHunkApplied(filePath: AbsPath, hunkIndex: number, status: HunkStatus) {
    this.hunkApplied.push({ filePath, hunkIndex, status });
  }
  postSessionCompleted(sessionId: SessionId, _metrics: SessionMetrics) {
    this.completed.push({ sessionId });
  }
  close(_sessionId: SessionId) {}
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-action-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

interface Harness {
  orchestrator: ReviewOrchestrator;
  panel: CapturingPanel;
  store: SnapshotStore;
  abs: AbsPath[];
  writeCallCount: () => number;
  failNextWrite: { value: boolean };
}

async function buildSession(beforeContent: string, afterContent: string, files = 1): Promise<Harness> {
  // Pre-seed disk with the after content. Both the orchestrator's injected
  // readFile/writeFile and test assertions read this real on-disk state.
  for (let i = 0; i < files; i++) {
    await fs.writeFile(path.join(tmp, `f${i}.ts`), afterContent, 'utf8');
  }
  let writeCalls = 0;
  const failNextWrite = { value: false };
  const store = new SnapshotStore({ maxSessionBytes: 50_000_000, maxFilesPerSession: 200 });
  const panel = new CapturingPanel();
  const orchestrator = new ReviewOrchestrator({
    store, panel,
    logger: new Logger('action-test', 'error'),
    readFile: async (p) => fs.readFile(String(p), 'utf8'),
    writeFile: async (p, c) => {
      writeCalls++;
      if (failNextWrite.value) {
        failNextWrite.value = false;
        throw new Error('disk full');
      }
      await fs.writeFile(String(p), c, 'utf8');
    },
  });

  const sid = 'sid';
  const abs: AbsPath[] = [];
  for (let i = 0; i < files; i++) {
    const a = (await store.captureOriginal(sid, tmp, `f${i}.ts`))!;
    store.get(sid)!.originals.set(a, beforeContent);
    store.recordTouched(sid, tmp, `f${i}.ts`);
    abs.push(a);
  }
  orchestrator.handleStop(sid, false, null);
  await new Promise((r) => setTimeout(r, 320));

  return { orchestrator, panel, store, abs, writeCallCount: () => writeCalls, failNextWrite };
}

describe('action — concurrent rejects on the same file', () => {
  it('serialises through the per-file mutex; final state matches `before`', async () => {
    // 5 well-separated hunks so jsdiff has clean context for each.
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after  = before
      .replace('line 0',  'LINE 0')
      .replace('line 12', 'LINE 12')
      .replace('line 24', 'LINE 24')
      .replace('line 36', 'LINE 36')
      .replace('line 48', 'LINE 48');

    const { orchestrator, abs } = await buildSession(before, after);
    const review = orchestrator.getSession('sid')!;
    expect(review.files[0].hunks.length).toBe(5);

    // Fire all 5 rejects in parallel — race on the same file.
    await Promise.all(
      review.files[0].hunks.map((h) => orchestrator.handleHunkAction('sid', abs[0], h.index, 'reject')),
    );

    expect(orchestrator.getSession('sid')!.files[0].hunks.every((h) => h.status === 'rejected')).toBe(true);
    const onDisk = await fs.readFile(path.join(tmp, 'f0.ts'), 'utf8');
    expect(onDisk).toBe(before);
  });

  it('mixed concurrent accept + reject on different hunks converges deterministically', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after  = before
      .replace('l0',  'L0')
      .replace('l10', 'L10')
      .replace('l20', 'L20');
    const { orchestrator, abs } = await buildSession(before, after);
    const review = orchestrator.getSession('sid')!;
    expect(review.files[0].hunks.length).toBe(3);

    await Promise.all([
      orchestrator.handleHunkAction('sid', abs[0], 0, 'reject'),
      orchestrator.handleHunkAction('sid', abs[0], 1, 'accept'),
      orchestrator.handleHunkAction('sid', abs[0], 2, 'reject'),
    ]);

    const file = orchestrator.getSession('sid')!.files[0];
    expect(file.hunks[0].status).toBe('rejected');
    expect(file.hunks[1].status).toBe('accepted');
    expect(file.hunks[2].status).toBe('rejected');
    // Disk should have hunks 0 and 2 reverted, hunk 1 (L10) kept.
    const onDisk = await fs.readFile(path.join(tmp, 'f0.ts'), 'utf8');
    expect(onDisk.includes('l0\n')).toBe(true);   // 0 reverted
    expect(onDisk.includes('L10')).toBe(true);    // 1 accepted
    expect(onDisk.includes('l20\n')).toBe(true);  // 2 reverted
  });
});

describe('action — concurrent rejects across different files', () => {
  it('different files run in parallel and end in correct states', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'A\nb\nc\nd\nE\n';
    const { orchestrator, abs } = await buildSession(before, after, 3);

    await Promise.all([
      orchestrator.handleBulk('sid', 'file', 'reject', abs[0]),
      orchestrator.handleBulk('sid', 'file', 'reject', abs[1]),
      orchestrator.handleBulk('sid', 'file', 'reject', abs[2]),
    ]);

    for (let i = 0; i < 3; i++) {
      const onDisk = await fs.readFile(path.join(tmp, `f${i}.ts`), 'utf8');
      expect(onDisk).toBe(before);
    }
  });
});

describe('action — bulk-reject fast path', () => {
  it('writes the snapshot once, not per-hunk, when every hunk is pending', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after  = before.replace('l0', 'L0').replace('l10', 'L10').replace('l20', 'L20');
    const harness = await buildSession(before, after);
    const baselineWrites = harness.writeCallCount();

    await harness.orchestrator.handleBulk('sid', 'session', 'reject');

    // Exactly one write per file (fast path), not 3 (one per hunk).
    expect(harness.writeCallCount() - baselineWrites).toBe(1);
    const onDisk = await fs.readFile(path.join(tmp, 'f0.ts'), 'utf8');
    expect(onDisk).toBe(before);
  });
});

describe('action — write failure surfaces visibly and keeps state consistent', () => {
  it('hunk stays pending; warning is emitted; retry succeeds', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'A\nb\nc\nd\nE\n';
    const harness = await buildSession(before, after);
    harness.failNextWrite.value = true;

    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'reject');

    const file = harness.orchestrator.getSession('sid')!.files[0];
    // Hunk stays pending — nothing happened on disk.
    expect(file.hunks[0].status).toBe('pending');
    expect(file.warnings.includes('write-failed')).toBe(true);
    // The file-updated post carrying the warning was sent.
    expect(harness.panel.fileUpdates.some((u) => u.warnings.includes('write-failed'))).toBe(true);

    // Retry: should succeed and clear the warning.
    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'reject');
    const fileAfter = harness.orchestrator.getSession('sid')!.files[0];
    expect(fileAfter.hunks[0].status).toBe('rejected');
    expect(fileAfter.warnings.includes('write-failed')).toBe(false);
  });

  it('revertFileToSnapshot surfaces write failure without partially marking hunks', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'A\nb\nc\nd\nE\n';
    const harness = await buildSession(before, after);
    harness.failNextWrite.value = true;

    await harness.orchestrator.revertFileToSnapshot('sid', harness.abs[0]);
    const file = harness.orchestrator.getSession('sid')!.files[0];
    // No hunks were marked rejected because the write failed.
    expect(file.hunks.every((h) => h.status === 'pending')).toBe(true);
    expect(file.warnings.includes('write-failed')).toBe(true);
  });
});

describe('action — idempotency', () => {
  it('clicking accept twice on the same hunk only transitions once', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'A\nb\nc\nd\nE\n';
    const harness = await buildSession(before, after);

    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'accept');
    const transitionsAfterFirst = harness.panel.hunkApplied.length;

    // Second click on the (now decided) hunk: must be a no-op.
    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'accept');
    expect(harness.panel.hunkApplied.length).toBe(transitionsAfterFirst);
  });

  it('trying to reject a hunk that is already accepted is a no-op', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'A\nb\nc\nd\nE\n';
    const harness = await buildSession(before, after);
    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'accept');
    await harness.orchestrator.handleHunkAction('sid', harness.abs[0], 0, 'reject');
    const file = harness.orchestrator.getSession('sid')!.files[0];
    expect(file.hunks[0].status).toBe('accepted');
  });
});
