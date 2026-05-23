/**
 * v0.5 — integration tests for `BuildSignalManager`.
 *
 * Covers the full per-session lifecycle without spawning real tsc:
 *   - start() emits 'running' aggregate + 'running' per-file
 *   - completion mutates buildStatus + buildErrors in place
 *   - intersect aligns errors with hunk line ranges
 *   - cancel() aborts and settles 'unknown'
 *   - dispose() cancels all in-flight runs (extension.deactivate path)
 *   - 50-cycle leak guard — no lingering subprocess handles
 */

import { describe, it, expect, vi } from 'vitest';
import { BuildSignalManager, type BuildSignalPanel } from '../../src/buildSignal/buildSignalManager.js';
import { Logger } from '../../src/logger.js';
import { asAbsPath, asSessionId } from '../../src/types.js';
import type {
  BuildErrorRef, BuildSignal, FileReview, HunkReview, SessionId, SessionReview,
} from '../../src/types.js';

const logger = new Logger('test', 'error');

function makeHunk(opts: { index: number; newStart: number; newLines: number }): HunkReview {
  return {
    index: opts.index,
    oldStart: opts.newStart,
    oldLines: opts.newLines,
    newStart: opts.newStart,
    newLines: opts.newLines,
    header: `@@ -${opts.newStart},${opts.newLines} +${opts.newStart},${opts.newLines} @@`,
    lines: [],
    status: 'pending',
  };
}

function makeFile(relPath: string, hunks: HunkReview[]): FileReview {
  return {
    filePath: asAbsPath(`/tmp/ws/${relPath}`),
    relPath,
    before: '',
    after: '',
    hunks,
    status: 'pending',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    warnings: [],
  };
}

function makeReview(files: FileReview[]): SessionReview {
  return {
    agentId: 'claude-code',
    sessionId: asSessionId('bsm-test'),
    cwd: '/tmp/ws',
    startedAt: 0,
    openedAt: 0,
    lastAssistantMessage: null,
    files,
    state: 'open',
    metrics: { totalHunks: 0, acceptedHunks: 0, rejectedHunks: 0, bytesSnapshotted: 0 },
  };
}

class CapturePanel implements BuildSignalPanel {
  fileUpdates: Array<{ relPath: string; status: FileReview['buildStatus'] }> = [];
  signals: BuildSignal[] = [];
  postFileUpdated(_sid: SessionId, _filePath: import('../../src/types.js').AbsPath, file: FileReview): void {
    this.fileUpdates.push({ relPath: file.relPath, status: file.buildStatus });
  }
  postBuildSignal(_sid: SessionId, signal: BuildSignal): void {
    this.signals.push({ ...signal, projectDiagnostics: signal.projectDiagnostics.slice() });
  }
}

/** Build a deferred-resolution fake `runTsc` so tests can advance the run
 *  at their own pace. */
function makeFakeRunTsc(behaviour: 'pass' | 'fail' | 'cancel' | 'never') {
  let resolveFn!: (r: any) => void;
  let progressEmittedBy: ((p: any) => void) | undefined;
  const promise = new Promise<any>((r) => { resolveFn = r; });
  const fakeRunTsc = vi.fn((opts: any) => {
    progressEmittedBy = opts.onProgress;
    if (opts.signal.aborted) {
      return Promise.resolve({
        kind: 'aborted',
        exitCode: -1,
        diagnostics: [],
        projectDiagnostics: [],
        cached: false,
        fatalStderr: null,
        durationMs: 1,
      });
    }
    opts.signal.addEventListener('abort', () => {
      resolveFn({
        kind: 'aborted',
        exitCode: -1,
        diagnostics: [],
        projectDiagnostics: [],
        cached: false,
        fatalStderr: null,
        durationMs: 1,
      });
    });
    if (behaviour === 'pass') {
      queueMicrotask(() => resolveFn({
        kind: 'success',
        exitCode: 0,
        diagnostics: [],
        projectDiagnostics: [],
        cached: false,
        fatalStderr: null,
        durationMs: 10,
      }));
    } else if (behaviour === 'fail') {
      const diagnostic: BuildErrorRef = {
        relPath: 'a.ts', line: 12, col: 1,
        code: 2322, severity: 'error', message: 'Type X not assignable.',
      };
      queueMicrotask(() => resolveFn({
        kind: 'diagnostics',
        exitCode: 1,
        diagnostics: [diagnostic],
        projectDiagnostics: [],
        cached: false,
        fatalStderr: null,
        durationMs: 10,
      }));
    } else if (behaviour === 'cancel') {
      // never resolve naturally; let the abort flow take over
    } else if (behaviour === 'never') {
      // pure hang — used for leak guard
    }
    return promise;
  });
  return { fakeRunTsc, emitProgress: (p: any) => progressEmittedBy?.(p) };
}

const fakeResolveTsconfig = vi.fn(async () => ({
  configPath: '/tmp/ws/tsconfig.json',
  useBuildMode: false,
}));

describe('BuildSignalManager — happy path', () => {
  it('start() seeds running state then transitions to pass on clean exit', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('pass');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    // First signal post: running.
    expect(panel.signals[0]?.status).toBe('running');
    expect(review.files[0]?.buildStatus).toBe('running');
    // Let the fake resolve.
    await new Promise((r) => setTimeout(r, 20));
    const last = panel.signals[panel.signals.length - 1]!;
    expect(last.status).toBe('pass');
    expect(review.files[0]?.buildStatus).toBe('pass');
    expect(manager.size()).toBe(0);
  });

  it('start() transitions to fail when tsc emits errors; per-hunk buildErrors attached', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('fail');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    await new Promise((r) => setTimeout(r, 20));
    const last = panel.signals[panel.signals.length - 1]!;
    expect(last.status).toBe('fail');
    expect(last.totalErrors).toBe(1);
    expect(review.files[0]?.buildStatus).toBe('fail');
    expect(review.files[0]?.hunks[0]?.buildErrors?.length).toBe(1);
  });
});

describe('BuildSignalManager — cancellation', () => {
  it('cancel() aborts the in-flight run and settles unknown', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('cancel');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    expect(manager.size()).toBe(1);
    manager.cancel(review.sessionId);
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.size()).toBe(0);
    const last = panel.signals[panel.signals.length - 1]!;
    expect(last.status).toBe('unknown');
  });

  it('dispose() cancels every in-flight run', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('cancel');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const reviewA = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    const reviewB = { ...reviewA, sessionId: asSessionId('other') };
    manager.start(reviewA.sessionId, reviewA);
    manager.start(reviewB.sessionId, reviewB);
    expect(manager.size()).toBe(2);
    manager.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.size()).toBe(0);
  });

  it('second start() on same session cancels the prior run', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('cancel');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    manager.start(review.sessionId, review);
    expect(manager.size()).toBe(1);
    manager.dispose();
  });
});

describe('BuildSignalManager — gated off', () => {
  it('start() is a no-op when options.enabled is false', () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('pass');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: false, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    expect(fakeRunTsc).not.toHaveBeenCalled();
    expect(manager.size()).toBe(0);
    expect(panel.signals).toEqual([]);
  });

  it('updateOptions flipping enabled→false cancels in-flight runs', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('cancel');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    const review = makeReview([makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
    manager.start(review.sessionId, review);
    expect(manager.size()).toBe(1);
    manager.updateOptions({ enabled: false, timeoutMs: 5000, overrideCommand: '' });
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.size()).toBe(0);
  });
});

describe('BuildSignalManager — memory leak guard', () => {
  it('50 start/cancel cycles leave size() === 0 and no leaked promises', async () => {
    const panel = new CapturePanel();
    const { fakeRunTsc } = makeFakeRunTsc('cancel');
    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );
    for (let i = 0; i < 50; i++) {
      const review = makeReview([makeFile(`f${i}.ts`, [makeHunk({ index: 0, newStart: 1, newLines: 5 })])]);
      review.sessionId = asSessionId(`s${i}`);
      manager.start(review.sessionId, review);
      manager.cancel(review.sessionId);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.size()).toBe(0);
  });
});
