/**
 * v0.4 (A4) — unit tests for `buildEditedHunk` + `extractHunkAfterView`.
 *
 * The pair forms the round-trip primitive for in-place hunk edits:
 *   - extractHunkAfterView(hunk) → pre-populates the textarea
 *   - buildEditedHunk(original, editedText) → produces the substitution
 *     consumed by `renderFileFromHunkSet` via `editedHunks`.
 */

import { describe, it, expect } from 'vitest';
import { buildEditedHunk, extractHunkAfterView } from '../../src/reviewOrchestrator.js';
import { renderFileFromHunkSet } from '../../src/core/hunkSet.js';
import { computeDiff } from '../../src/diffEngine.js';
import { asAbsPath, type HunkSetState, type StructuredHunk } from '../../src/types.js';

const ABS = asAbsPath('/test/edit.ts');

function diffHunks(before: string, after: string): StructuredHunk[] {
  return computeDiff(ABS, before, after).hunks;
}

describe('extractHunkAfterView', () => {
  it('strips diff prefixes and joins context + add lines', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'a\nB\nc\nD\ne\n';
    const [h] = diffHunks(before, after);
    expect(h).toBeDefined();
    const view = extractHunkAfterView(h);
    // After view = context lines + `+` lines, no `-`.
    expect(view).not.toContain('\n-');
    expect(view.includes('B')).toBe(true);
    expect(view.includes('D')).toBe(true);
  });

  it('returns just `+` lines for a pure-addition hunk', () => {
    const before = 'a\nb\n';
    const after  = 'a\nb\nc\nd\n';
    const [h] = diffHunks(before, after);
    expect(h).toBeDefined();
    const view = extractHunkAfterView(h);
    expect(view.includes('c')).toBe(true);
    expect(view.includes('d')).toBe(true);
  });
});

describe('buildEditedHunk', () => {
  it('preserves oldStart and oldLines exactly', () => {
    const before = 'x\ny\nz\nw\n';
    const after  = 'x\nY\nz\nw\n';
    const [h] = diffHunks(before, after);
    expect(h).toBeDefined();
    const edited = buildEditedHunk(h, 'CUSTOM');
    expect(edited.oldStart).toBe(h.oldStart);
    expect(edited.oldLines).toBe(h.oldLines);
  });

  it('replaces the entire hunk after-view with the user content (no implicit context preservation)', () => {
    // Semantic: buildEditedHunk treats the user input as a wholesale
    // replacement of EVERY line in the hunk's range — including context.
    // If the user wants line A and line C preserved, they type them
    // explicitly. This matches "user edits what they see in the textarea".
    const before = 'line A\nline B\nline C\n';
    const after  = 'line A\nLINE B\nline C\n';
    const hunks = diffHunks(before, after);
    expect(hunks.length).toBe(1);
    const original = hunks[0]!;

    // User keeps the surrounding context manually:
    const userText = 'line A\nUSER EDIT\nline C';
    const edited = buildEditedHunk(original, userText);

    const state: HunkSetState = {
      filePath: ABS,
      originalSnapshot: before,
      allHunks: [original],
      acceptedSet: new Set([0]),
      editedHunks: new Map([[0, edited]]),
    };
    const result = renderFileFromHunkSet(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('USER EDIT');
      expect(result.content).not.toContain('LINE B');
      const lines = result.content.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual(['line A', 'USER EDIT', 'line C']);
    }
  });

  it('multi-line user content produces correct newLines count', () => {
    // synthesize a minimal hunk from a one-line change
    const hunks = diffHunks('header\nbody1\nfooter\n', 'header\nNEWBODY\nfooter\n');
    const original = hunks[0]!;
    const edited = buildEditedHunk(original, 'one\ntwo\nthree');
    expect(edited.newLines).toBe(3);
    // count `+` lines in body
    const plusCount = edited.lines.filter((l) => l.startsWith('+')).length;
    expect(plusCount).toBe(3);
  });

  it('empty user content produces newLines=0 (delete-only hunk)', () => {
    const before = 'keep\ndrop\nkeep2\n';
    const after  = 'keep\nMOD\nkeep2\n';
    const [h] = diffHunks(before, after);
    expect(h).toBeDefined();
    const edited = buildEditedHunk(h, '');
    expect(edited.newLines).toBe(0);
    expect(edited.lines.filter((l) => l.startsWith('+')).length).toBe(0);
  });

  it('substituted hunk renders even when user content is shorter than original', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after  = 'a\nB\nC\nD\ne\n'; // 3-line change in middle
    const [h] = diffHunks(before, after);
    expect(h).toBeDefined();
    const edited = buildEditedHunk(h, 'X'); // collapse 3-line change to 1 line
    const state: HunkSetState = {
      filePath: ABS,
      originalSnapshot: before,
      allHunks: [h],
      acceptedSet: new Set([0]),
      editedHunks: new Map([[0, edited]]),
    };
    const result = renderFileFromHunkSet(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.includes('X')).toBe(true);
      expect(result.content.includes('B')).toBe(false);
    }
  });
});
