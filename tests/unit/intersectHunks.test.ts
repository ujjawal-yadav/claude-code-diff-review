/**
 * v0.5 — unit tests for `intersectDiagnosticsWithHunks`.
 *
 * Coverage:
 *   - hunk-line-range intersection (post-edit coords)
 *   - file-level 'pass' when no diagnostics target the file
 *   - file-level 'fail' only when at least one ERROR-severity diagnostic
 *     (warnings alone leave the file as 'pass')
 *   - errors in unchanged context (no hunk match) still flip the file
 *   - re-running clears stale per-hunk buildErrors
 */

import { describe, it, expect } from 'vitest';
import { intersectDiagnosticsWithHunks } from '../../src/buildSignal/intersectHunks.js';
import type { BuildErrorRef, FileReview, HunkReview } from '../../src/types.js';
import { asAbsPath } from '../../src/types.js';

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

function makeErr(opts: { relPath: string; line: number; severity?: 'error' | 'warning' }): BuildErrorRef {
  return {
    relPath: opts.relPath,
    line: opts.line,
    col: 1,
    code: 2322,
    severity: opts.severity ?? 'error',
    message: 'Some diagnostic.',
  };
}

describe('intersectDiagnosticsWithHunks', () => {
  it('marks file pass when no diagnostics target it', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 3 })]);
    intersectDiagnosticsWithHunks([file], []);
    expect(file.buildStatus).toBe('pass');
    expect(file.hunks[0]?.buildErrors).toBeUndefined();
  });

  it('attaches a single diagnostic to the hunk whose range contains its line', () => {
    const file = makeFile('a.ts', [
      makeHunk({ index: 0, newStart: 10, newLines: 5 }),
      makeHunk({ index: 1, newStart: 50, newLines: 5 }),
    ]);
    intersectDiagnosticsWithHunks([file], [makeErr({ relPath: 'a.ts', line: 12 })]);
    expect(file.buildStatus).toBe('fail');
    expect(file.hunks[0]?.buildErrors?.length).toBe(1);
    expect(file.hunks[1]?.buildErrors).toBeUndefined();
  });

  it('handles multiple diagnostics across multiple hunks', () => {
    const file = makeFile('a.ts', [
      makeHunk({ index: 0, newStart: 10, newLines: 5 }),
      makeHunk({ index: 1, newStart: 30, newLines: 5 }),
    ]);
    intersectDiagnosticsWithHunks([file], [
      makeErr({ relPath: 'a.ts', line: 11 }),
      makeErr({ relPath: 'a.ts', line: 32 }),
    ]);
    expect(file.buildStatus).toBe('fail');
    expect(file.hunks[0]?.buildErrors?.length).toBe(1);
    expect(file.hunks[1]?.buildErrors?.length).toBe(1);
  });

  it('errors in unchanged context (no hunk match) still flip file to fail', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    intersectDiagnosticsWithHunks([file], [makeErr({ relPath: 'a.ts', line: 100 })]);
    expect(file.buildStatus).toBe('fail');
    expect(file.hunks[0]?.buildErrors).toBeUndefined();
  });

  it('warnings alone leave the file as pass', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    intersectDiagnosticsWithHunks([file], [
      makeErr({ relPath: 'a.ts', line: 11, severity: 'warning' }),
    ]);
    expect(file.buildStatus).toBe('pass');
    // But still attached to the hunk for visibility.
    expect(file.hunks[0]?.buildErrors?.length).toBe(1);
  });

  it('mixed warning + error → file fails, both attached', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    intersectDiagnosticsWithHunks([file], [
      makeErr({ relPath: 'a.ts', line: 11, severity: 'warning' }),
      makeErr({ relPath: 'a.ts', line: 12, severity: 'error' }),
    ]);
    expect(file.buildStatus).toBe('fail');
    expect(file.hunks[0]?.buildErrors?.length).toBe(2);
  });

  it('hunk with newLines: 0 (delete-only) never matches', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 0 })]);
    intersectDiagnosticsWithHunks([file], [makeErr({ relPath: 'a.ts', line: 10 })]);
    expect(file.hunks[0]?.buildErrors).toBeUndefined();
    // File still fails because the diagnostic targets a.ts.
    expect(file.buildStatus).toBe('fail');
  });

  it('multi-file: diagnostics partition correctly by relPath', () => {
    const fileA = makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })]);
    const fileB = makeFile('b.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })]);
    intersectDiagnosticsWithHunks([fileA, fileB], [
      makeErr({ relPath: 'a.ts', line: 2 }),
    ]);
    expect(fileA.buildStatus).toBe('fail');
    expect(fileB.buildStatus).toBe('pass');
  });

  it('re-running clears stale per-hunk buildErrors', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 10, newLines: 5 })]);
    // First run: error → buildErrors attached.
    intersectDiagnosticsWithHunks([file], [makeErr({ relPath: 'a.ts', line: 12 })]);
    expect(file.hunks[0]?.buildErrors?.length).toBe(1);
    // Second run: clean → buildErrors must be cleared.
    intersectDiagnosticsWithHunks([file], []);
    expect(file.hunks[0]?.buildErrors).toBeUndefined();
    expect(file.buildStatus).toBe('pass');
  });

  it('project-level diagnostics (empty relPath) are ignored at file level', () => {
    const file = makeFile('a.ts', [makeHunk({ index: 0, newStart: 1, newLines: 5 })]);
    intersectDiagnosticsWithHunks([file], [makeErr({ relPath: '', line: 0 })]);
    expect(file.buildStatus).toBe('pass');
  });
});
