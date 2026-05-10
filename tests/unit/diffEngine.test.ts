import { describe, it, expect } from 'vitest';
import * as Diff from 'diff';
import { computeDiff, revertHunk, detectEol, __test } from '../../src/diffEngine.js';
import { asAbsPath } from '../../src/types.js';

const P = asAbsPath('/x/file.ts');
const NUL = String.fromCharCode(0);

describe('diffEngine — computeDiff', () => {
  it('produces zero hunks for identical content', () => {
    const d = computeDiff(P, 'a\nb\n', 'a\nb\n');
    expect(d.hunks.length).toBe(0);
    expect(d.isNew).toBe(false);
    expect(d.isDeleted).toBe(false);
  });

  it('flags new files', () => {
    const d = computeDiff(P, '', 'hello\n');
    expect(d.isNew).toBe(true);
    expect(d.hunks.length).toBeGreaterThan(0);
  });

  it('flags deleted files', () => {
    const d = computeDiff(P, 'hello\n', '');
    expect(d.isDeleted).toBe(true);
  });

  it('produces a hunk for a single-line change', () => {
    const d = computeDiff(P, 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(d.hunks.length).toBe(1);
    expect(d.hunks[0].lines.some((l) => l.startsWith('-two'))).toBe(true);
    expect(d.hunks[0].lines.some((l) => l.startsWith('+TWO'))).toBe(true);
  });

  it('detects binary files via NUL byte', () => {
    const withNul = `foo${NUL}bar`;
    const d = computeDiff(P, withNul, withNul + 'x');
    expect(d.isBinary).toBe(true);
    expect(d.hunks.length).toBe(0);
  });

  it('handles CRLF input by normalising before diffing', () => {
    const before = 'a\r\nb\r\nc\r\n';
    const after  = 'a\r\nB\r\nc\r\n';
    const d = computeDiff(P, before, after);
    expect(d.hunks.length).toBe(1);
    expect(d.isBinary).toBe(false);
  });

  it('handles unicode content', () => {
    const before = 'héllo 世界\n';
    const after  = 'hello 世界\n';
    const d = computeDiff(P, before, after);
    expect(d.hunks.length).toBe(1);
  });

  it('handles whitespace-only changes', () => {
    const d = computeDiff(P, 'foo  bar\n', 'foo bar\n');
    expect(d.hunks.length).toBe(1);
  });
});

describe('diffEngine — detectEol', () => {
  it('returns LF when no CR present', () => {
    expect(detectEol('a\nb\n')).toBe('\n');
  });

  it('returns CRLF when dominant', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
  });

  it('returns LF when mixed but LF dominant', () => {
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
  });
});

describe('diffEngine — revertHunk (round-trip)', () => {
  it('reverts a single hunk back to the original', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after  = 'one\nTWO\nthree\nfour\nfive\n';
    const d = computeDiff(P, before, after);
    expect(d.hunks.length).toBe(1);
    const result = revertHunk(after, d.hunks[0]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newContent).toBe(before);
  });

  it('reverts only one hunk when multiple exist', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';
    const after  = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n';
    const d = computeDiff(P, before, after);
    expect(d.hunks.length).toBe(2);
    const result = revertHunk(after, d.hunks[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent.includes('\nb\n')).toBe(true);
      expect(result.newContent.includes('\nJ\n')).toBe(true);
    }
  });

  it('property: applyPatch(before, computeDiff().patch) === after for random edits', () => {
    for (let trial = 0; trial < 50; trial++) {
      const lines = 20;
      const beforeArr = Array.from({ length: lines }, (_, i) => `line ${i}`);
      const afterArr = beforeArr.slice();
      const edits = 1 + Math.floor(Math.random() * 5);
      for (let e = 0; e < edits; e++) {
        const idx = Math.floor(Math.random() * lines);
        afterArr[idx] = afterArr[idx] + ' mutated';
      }
      const before = beforeArr.join('\n') + '\n';
      const after  = afterArr.join('\n') + '\n';
      const d = computeDiff(P, before, after);
      const patchObj = {
        oldFileName: 'a', newFileName: 'b', oldHeader: '', newHeader: '',
        hunks: d.hunks.map((h) => ({
          oldStart: h.oldStart, oldLines: h.oldLines,
          newStart: h.newStart, newLines: h.newLines,
          lines: h.lines,
        })),
      };
      const applied = Diff.applyPatch(before, patchObj);
      expect(applied).toBe(after);
    }
  });
});

describe('diffEngine — internal helpers', () => {
  it('toLF only rewrites when CRLF present', () => {
    expect(__test.toLF('a\nb\n')).toBe('a\nb\n');
    expect(__test.toLF('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('containsNul detects NUL byte', () => {
    expect(__test.containsNul('safe')).toBe(false);
    expect(__test.containsNul(`un${NUL}safe`)).toBe(true);
  });
});
