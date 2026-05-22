/**
 * v0.4 (A8 cheap) — unit tests for the rename heuristic.
 *
 * Coverage:
 *   - single-token rename detected (positive)
 *   - multi-token swap rejected (negative)
 *   - same-token-on-both-sides rejected (no symmetric difference)
 *   - tokens shorter than 3 chars excluded (noise filter)
 *   - group size < 3 dropped (positive examples coalesce only with ≥3 members)
 *   - groups with mixed renames cluster by (old, new) pair
 */

import { describe, it, expect } from 'vitest';
import { detectRename, groupRenames } from '../../src/renameGrouper.js';
import { asAbsPath, asSessionId, type HunkReview, type SessionReview } from '../../src/types.js';

function makeHunk(lines: string[], index = 0): HunkReview {
  return {
    index,
    oldStart: 1,
    oldLines: lines.filter((l) => l.startsWith('-') || l.startsWith(' ')).length,
    newStart: 1,
    newLines: lines.filter((l) => l.startsWith('+') || l.startsWith(' ')).length,
    header: `@@ -1 +1 @@`,
    lines,
    status: 'pending',
  };
}

function makeSession(hunks: HunkReview[][]): SessionReview {
  return {
    sessionId: asSessionId('test-session'),
    agentId: 'claude-code',
    cwd: '/tmp/ws',
    startedAt: 0,
    openedAt: 0,
    lastAssistantMessage: null,
    state: 'open',
    metrics: { totalHunks: 0, acceptedHunks: 0, rejectedHunks: 0, bytesSnapshotted: 0 },
    files: hunks.map((hList, fi) => ({
      filePath: asAbsPath(`/tmp/ws/file${fi}.ts`),
      relPath: `file${fi}.ts`,
      before: '',
      after: '',
      hunks: hList,
      status: 'pending',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      warnings: [],
    })),
  };
}

describe('detectRename', () => {
  it('detects a single-token rename', () => {
    const h = makeHunk([
      '-foo(bar)',
      '+baz(bar)',
    ]);
    expect(detectRename(h)).toEqual({ oldToken: 'foo', newToken: 'baz' });
  });

  it('rejects multi-token swap', () => {
    const h = makeHunk([
      '-foo(alpha)',
      '+baz(beta)',
    ]);
    expect(detectRename(h)).toBeNull();
  });

  it('rejects when the same token appears on both sides', () => {
    const h = makeHunk([
      '-foo(bar)',
      '+foo(baz)',
    ]);
    // `foo` is on both sides → not in symmetric difference; only `bar`/`baz`
    // differ → that's a valid single-token rename (bar→baz).
    expect(detectRename(h)).toEqual({ oldToken: 'bar', newToken: 'baz' });
  });

  it('excludes 2-character tokens (noise filter)', () => {
    const h = makeHunk([
      '-fn(xy)',
      '+gn(xy)',
    ]);
    // `fn`/`gn` both length 2 → filtered → no single-token rename → null
    expect(detectRename(h)).toBeNull();
  });

  it('returns null when one side has zero distinct tokens', () => {
    const h = makeHunk([
      '-x = 1',
      '+x = 1',
    ]);
    expect(detectRename(h)).toBeNull();
  });
});

describe('groupRenames', () => {
  it('returns groups with ≥3 members keyed by old->new', () => {
    const session = makeSession([
      [
        makeHunk(['-foo(a)', '+bar(a)'], 0),
        makeHunk(['-foo(b)', '+bar(b)'], 1),
      ],
      [
        makeHunk(['-foo(c)', '+bar(c)'], 0),
      ],
    ]);
    const groups = groupRenames(session);
    expect(groups['foo->bar']).toBeDefined();
    expect(groups['foo->bar']!.length).toBe(3);
  });

  it('drops groups with fewer than 3 members', () => {
    const session = makeSession([
      [makeHunk(['-foo()', '+bar()'], 0)],
      [makeHunk(['-foo()', '+bar()'], 0)],
    ]);
    const groups = groupRenames(session);
    expect(groups['foo->bar']).toBeUndefined();
  });

  it('separates groups by distinct (old, new) tuples', () => {
    const session = makeSession([
      [
        makeHunk(['-foo()', '+bar()'], 0),
        makeHunk(['-foo()', '+bar()'], 1),
        makeHunk(['-foo()', '+bar()'], 2),
      ],
      [
        makeHunk(['-alpha()', '+beta()'], 0),
        makeHunk(['-alpha()', '+beta()'], 1),
        makeHunk(['-alpha()', '+beta()'], 2),
      ],
    ]);
    const groups = groupRenames(session);
    expect(groups['foo->bar']?.length).toBe(3);
    expect(groups['alpha->beta']?.length).toBe(3);
  });
});
