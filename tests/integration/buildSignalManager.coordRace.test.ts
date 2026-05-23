/**
 * v0.5.1 (LH2) — race test: handleEditHunk mutates hunk.newStart/newLines
 * while tsc is in-flight; intersectDiagnosticsWithHunks must match
 * diagnostics against the TSC-TIME coords, not the post-edit coords.
 *
 * Without the coord snapshot, a hunk originally at lines 10-14 that gets
 * edited to lines 20-27 mid-run would cause a tsc error at line 12 to
 * MISS the hunk entirely (12 ∉ [20, 27]) and the badge would not appear.
 * With the snapshot, intersection uses the start-time range and the error
 * lands correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BuildSignalManager, type BuildSignalPanel,
} from '../../src/buildSignal/buildSignalManager.js';
import { Logger } from '../../src/logger.js';
import { asAbsPath, asSessionId } from '../../src/types.js';
import type {
  BuildErrorRef, BuildSignal,
  FileReview, HunkReview, SessionId, SessionReview,
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
    sessionId: asSessionId('coord-race'),
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
  fileUpdates: FileReview[] = [];
  signals: BuildSignal[] = [];
  postFileUpdated(_sid: SessionId, _filePath: import('../../src/types.js').AbsPath, file: FileReview): void {
    // Capture a SNAPSHOT of the file at the moment of the post so later
    // mutations don't tear the assertion.
    this.fileUpdates.push({
      ...file,
      hunks: file.hunks.map((h) => {
        const cloned: HunkReview = { ...h };
        if (h.buildErrors !== undefined) cloned.buildErrors = h.buildErrors.slice();
        return cloned;
      }),
    });
  }
  postBuildSignal(_sid: SessionId, signal: BuildSignal): void {
    this.signals.push({ ...signal, projectDiagnostics: signal.projectDiagnostics.slice() });
  }
}

const fakeResolveTsconfig = vi.fn(async () => ({
  configPath: '/tmp/ws/tsconfig.json',
  useBuildMode: false,
}));

describe('BuildSignalManager — v0.5.1 LH2 coord-snapshot race', () => {
  it('intersect uses start-time coords; mid-run hunk edit does not mis-attribute the diagnostic', async () => {
    const panel = new CapturePanel();
    let resolveFn!: (r: any) => void;
    const fakeRunTsc = vi.fn((_opts: any) => new Promise<any>((r) => { resolveFn = r; }));

    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );

    // Build a session with one file, one hunk at lines 10-14 (newStart=10, newLines=5).
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    const review = makeReview([file]);

    // Kick off the manager; coord snapshot captures the original range.
    manager.start(review.sessionId, review);
    // Wait until runLoop calls runTsc (resolveTsconfig is async too).
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeRunTsc).toHaveBeenCalled();

    // Simulate handleEditHunk: mutate the live hunk's coords in-place to
    // a NEW post-edit range (lines 20-27, newLines=8). This is exactly
    // what reviewOrchestrator.ts does after a successful edit:
    //   hunk.newStart = newHunk.newStart;
    //   hunk.newLines = newHunk.newLines;
    file.hunks[0]!.newStart = 20;
    file.hunks[0]!.newLines = 8;

    // tsc now resolves with an error at line 12 (within the ORIGINAL
    // tsc-time range 10-14; OUTSIDE the post-edit range 20-27).
    const diagnostic: BuildErrorRef = {
      relPath: 'a.ts', line: 12, col: 1,
      code: 2322, severity: 'error', message: 'X is not assignable.',
    };
    resolveFn({
      kind: 'diagnostics',
      exitCode: 1,
      diagnostics: [diagnostic],
      projectDiagnostics: [],
      cached: false,
      fatalStderr: null,
      durationMs: 50,
    });

    // Let the manager's runLoop finalize.
    await new Promise((r) => setTimeout(r, 20));

    // The intersection should have matched line 12 against the SNAPSHOT
    // (10-14), not the post-edit live coords (20-27). So the hunk gets
    // the buildErrors entry.
    const updated = panel.fileUpdates[panel.fileUpdates.length - 1]!;
    expect(updated.hunks[0]!.buildErrors?.length).toBe(1);
    expect(updated.hunks[0]!.buildErrors?.[0]?.line).toBe(12);
    expect(updated.buildStatus).toBe('fail');

    // Note: the LIVE file.hunks[0] still has the mutated coords (20, 8) —
    // the snapshot lives in the manager's RunHandle, NOT on the file.
    // The orchestrator owns hunk coords; the manager only annotates errors.
    expect(file.hunks[0]!.newStart).toBe(20);
    expect(file.hunks[0]!.newLines).toBe(8);
  });

  it('without an edit, intersect produces identical results pre- and post-fix', async () => {
    // Sanity: when no edits happen, the coord snapshot equals the live
    // coords, so the fix is a no-op for the common case.
    const panel = new CapturePanel();
    let resolveFn!: (r: any) => void;
    const fakeRunTsc = vi.fn((_opts: any) => new Promise<any>((r) => { resolveFn = r; }));

    const manager = new BuildSignalManager(
      { logger, panel, runTsc: fakeRunTsc as any, resolveTsconfig: fakeResolveTsconfig as any },
      { enabled: true, timeoutMs: 5000, overrideCommand: '' },
    );

    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    const review = makeReview([file]);
    manager.start(review.sessionId, review);
    await new Promise((r) => setTimeout(r, 20));

    resolveFn({
      kind: 'diagnostics',
      exitCode: 1,
      diagnostics: [{
        relPath: 'a.ts', line: 12, col: 1,
        code: 2322, severity: 'error', message: 'X.',
      }],
      projectDiagnostics: [],
      cached: false,
      fatalStderr: null,
      durationMs: 50,
    });
    await new Promise((r) => setTimeout(r, 20));

    const updated = panel.fileUpdates[panel.fileUpdates.length - 1]!;
    expect(updated.hunks[0]!.buildErrors?.length).toBe(1);
    expect(updated.buildStatus).toBe('fail');
  });
});
