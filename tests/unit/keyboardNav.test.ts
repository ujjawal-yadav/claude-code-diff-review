/**
 * v0.3 — keyboardNav helpers unit tests.
 *
 * Pure-function tests over synthetic sessions. The webview's key-routing
 * (App.tsx event handler) is verified manually in smoke tests; this file
 * locks in the navigation arithmetic.
 */

import { describe, it, expect } from 'vitest';
import {
  nextHunk,
  prevHunk,
  nextFlaggedHunk,
  prevFlaggedHunk,
} from '../../webview/utils/keyboardNav.js';
import type { SessionReview, FileReview, HunkReview, RiskFlag } from '../../src/types';
import { asSessionId, asAbsPath } from '../../src/types';

// Test helpers ---------------------------------------------------------------

function mkHunk(index: number, flags?: RiskFlag[]): HunkReview {
  return {
    index, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    header: '@@', lines: [], status: 'pending',
    ...(flags ? { flags } : {}),
  };
}

function mkFile(relPath: string, hunkCount: number, flagged: number[] = [], fileFlags?: RiskFlag[]): FileReview {
  const hunks: HunkReview[] = [];
  for (let i = 0; i < hunkCount; i++) {
    hunks.push(mkHunk(i, flagged.includes(i) ? ['deletion'] : undefined));
  }
  return {
    filePath: asAbsPath('/work/' + relPath),
    relPath,
    before: '', after: '',
    hunks,
    status: 'pending',
    isNew: false, isDeleted: false, isBinary: false,
    warnings: [],
    ...(fileFlags ? { flags: fileFlags } : {}),
  };
}

function mkSession(files: FileReview[]): SessionReview {
  return {
    agentId: 'claude-code',
    sessionId: asSessionId('sid'),
    cwd: '/work',
    startedAt: 0, openedAt: 0,
    lastAssistantMessage: null,
    files,
    state: 'open',
    metrics: { totalHunks: 0, acceptedHunks: 0, rejectedHunks: 0, bytesSnapshotted: 0 },
  };
}

// --- nextHunk ---------------------------------------------------------------

describe('nextHunk', () => {
  it('returns null for empty session', () => {
    const s = mkSession([]);
    expect(nextHunk(s, null, null)).toBeNull();
  });

  it('starts at first hunk of first file when no selection', () => {
    const s = mkSession([mkFile('a.ts', 3)]);
    expect(nextHunk(s, null, null)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });

  it('advances within current file', () => {
    const s = mkSession([mkFile('a.ts', 3)]);
    expect(nextHunk(s, '/work/a.ts', 0)).toEqual({ filePath: '/work/a.ts', hunkIndex: 1 });
    expect(nextHunk(s, '/work/a.ts', 1)).toEqual({ filePath: '/work/a.ts', hunkIndex: 2 });
  });

  it('spills to first hunk of next file at end of current file', () => {
    const s = mkSession([mkFile('a.ts', 3), mkFile('b.ts', 2)]);
    expect(nextHunk(s, '/work/a.ts', 2)).toEqual({ filePath: '/work/b.ts', hunkIndex: 0 });
  });

  it('returns null at last hunk of last file (no wrap-around)', () => {
    const s = mkSession([mkFile('a.ts', 2), mkFile('b.ts', 2)]);
    expect(nextHunk(s, '/work/b.ts', 1)).toBeNull();
  });

  it('skips files with zero hunks', () => {
    const s = mkSession([mkFile('a.ts', 2), mkFile('empty.ts', 0), mkFile('c.ts', 1)]);
    expect(nextHunk(s, '/work/a.ts', 1)).toEqual({ filePath: '/work/c.ts', hunkIndex: 0 });
  });

  it('handles stale selectedFile (file no longer in session) by starting from first', () => {
    const s = mkSession([mkFile('a.ts', 2)]);
    expect(nextHunk(s, '/work/gone.ts', 0)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });
});

// --- prevHunk ---------------------------------------------------------------

describe('prevHunk', () => {
  it('returns null for empty session', () => {
    expect(prevHunk(mkSession([]), null, null)).toBeNull();
  });

  it('starts at last hunk of last file when no selection', () => {
    const s = mkSession([mkFile('a.ts', 2), mkFile('b.ts', 3)]);
    expect(prevHunk(s, null, null)).toEqual({ filePath: '/work/b.ts', hunkIndex: 2 });
  });

  it('walks backward within current file', () => {
    const s = mkSession([mkFile('a.ts', 3)]);
    expect(prevHunk(s, '/work/a.ts', 2)).toEqual({ filePath: '/work/a.ts', hunkIndex: 1 });
    expect(prevHunk(s, '/work/a.ts', 1)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });

  it('spills to last hunk of previous file', () => {
    const s = mkSession([mkFile('a.ts', 2), mkFile('b.ts', 3)]);
    expect(prevHunk(s, '/work/b.ts', 0)).toEqual({ filePath: '/work/a.ts', hunkIndex: 1 });
  });

  it('returns null at first hunk of first file', () => {
    const s = mkSession([mkFile('a.ts', 2)]);
    expect(prevHunk(s, '/work/a.ts', 0)).toBeNull();
  });

  it('skips empty files in reverse', () => {
    const s = mkSession([mkFile('a.ts', 1), mkFile('empty.ts', 0), mkFile('c.ts', 2)]);
    expect(prevHunk(s, '/work/c.ts', 0)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });
});

// --- nextFlaggedHunk / prevFlaggedHunk --------------------------------------

describe('nextFlaggedHunk', () => {
  it('returns null when no hunks are flagged', () => {
    const s = mkSession([mkFile('a.ts', 3)]);
    expect(nextFlaggedHunk(s, null, null)).toBeNull();
  });

  it('returns first flagged hunk when no selection', () => {
    // file with hunks at indices 0,1,2 — flag only index 1
    const s = mkSession([mkFile('a.ts', 3, [1])]);
    expect(nextFlaggedHunk(s, null, null)).toEqual({ filePath: '/work/a.ts', hunkIndex: 1 });
  });

  it('skips unflagged hunks within and across files', () => {
    const s = mkSession([mkFile('a.ts', 3), mkFile('b.ts', 3, [2])]);
    expect(nextFlaggedHunk(s, '/work/a.ts', 0)).toEqual({ filePath: '/work/b.ts', hunkIndex: 2 });
  });

  it('considers file-level flags too', () => {
    // file a.ts has no per-hunk flags but a file-level flag
    const s = mkSession([mkFile('a.ts', 2, [], ['sensitive-path'])]);
    expect(nextFlaggedHunk(s, null, null)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });

  it('returns null when all flagged hunks are behind current position', () => {
    const s = mkSession([mkFile('a.ts', 3, [0])]);
    expect(nextFlaggedHunk(s, '/work/a.ts', 0)).toBeNull();
  });
});

describe('prevFlaggedHunk', () => {
  it('finds previous flagged hunk', () => {
    const s = mkSession([mkFile('a.ts', 2, [0]), mkFile('b.ts', 3, [2])]);
    expect(prevFlaggedHunk(s, '/work/b.ts', 2)).toEqual({ filePath: '/work/a.ts', hunkIndex: 0 });
  });

  it('returns null when no earlier flagged hunk exists', () => {
    const s = mkSession([mkFile('a.ts', 3, [2])]);
    expect(prevFlaggedHunk(s, '/work/a.ts', 2)).toBeNull();
  });
});
