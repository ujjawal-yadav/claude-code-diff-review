import * as Diff from 'diff';

import type { AbsPath, ComputedDiff, RevertResult, StructuredHunk } from './types.js';

/**
 * Diff computation and hunk-level revert (TRD §5.5, §9).
 *
 * Pre-processing
 * --------------
 *  - Detect dominant EOL on `before` (LF vs CRLF).
 *  - Normalise both inputs to LF for diff computation.
 *  - Reject inputs containing NUL bytes — binary files are out of scope
 *    for hunk-level review (TRD §9.1). The caller sees `isBinary: true`
 *    and skips diff rendering for that file.
 *
 * Algorithm
 * ---------
 *   computeDiff: jsdiff `structuredPatch` with context: 3.
 *   revertHunk:  build single-hunk patch -> `reversePatch` -> `applyPatch`,
 *                with one `fuzzFactor: 2` retry on strict failure.
 *
 * The functions are pure (no I/O, no globals); safe to call from a worker
 * if the file count ever exceeds the perf budget for the main thread.
 */

const NUL_CHAR_CODE = 0;

function containsNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === NUL_CHAR_CODE) return true;
  }
  return false;
}

export function computeDiff(filePath: AbsPath, before: string, after: string): ComputedDiff {
  if (containsNul(before) || containsNul(after)) {
    return {
      filePath,
      before, after,
      hunks: [],
      isNew: before === '' && after !== '',
      isDeleted: after === '' && before !== '',
      isBinary: true,
    };
  }

  const beforeLF = toLF(before);
  const afterLF  = toLF(after);

  const isNew     = before === '' && after !== '';
  const isDeleted = after === '' && before !== '';

  const sp = Diff.structuredPatch(filePath, filePath, beforeLF, afterLF, '', '', { context: 3 });

  const hunks: StructuredHunk[] = sp.hunks.map((h, i) => ({
    index:    i,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    header:   `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    lines:    h.lines.slice(),
  }));

  return { filePath, before, after, hunks, isNew, isDeleted, isBinary: false };
}

export function revertHunk(currentContent: string, hunk: StructuredHunk): RevertResult {
  const singleHunk = {
    oldFileName: 'a',
    newFileName: 'b',
    oldHeader: '',
    newHeader: '',
    hunks: [{
      oldStart: hunk.oldStart, oldLines: hunk.oldLines,
      newStart: hunk.newStart, newLines: hunk.newLines,
      lines: hunk.lines.slice(),
    }],
  };
  const reversed = Diff.reversePatch(singleHunk);

  const tryApply = (fuzz?: number): string | false => {
    const opts = fuzz != null ? { fuzzFactor: fuzz } : undefined;
    return Diff.applyPatch(currentContent, reversed, opts);
  };

  let applied = tryApply();
  if (applied === false) applied = tryApply(2);
  if (applied === false) {
    return { ok: false, reason: 'fuzz-failed' };
  }
  return { ok: true, newContent: applied };
}

/** Detect dominant EOL of a file content. */
export function detectEol(content: string): '\n' | '\r\n' {
  if (!content.includes('\r')) return '\n';
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 0x0a /* \n */) {
      if (i > 0 && content.charCodeAt(i - 1) === 0x0d /* \r */) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

function toLF(s: string): string {
  return s.includes('\r\n') ? s.replace(/\r\n/g, '\n') : s;
}

/** Exported for tests. */
export const __test = { toLF, containsNul };
