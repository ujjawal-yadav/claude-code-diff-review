import * as Diff from 'diff';

import type { HunkSetState, RenderResult, StructuredHunk } from '../types.js';

/**
 * Set-based reversibility (Phase α Track 6 — PHASE-ALPHA-IMMEDIATE.md §8).
 *
 * Render a file's content as `originalSnapshot + applied_hunk_set`. Every
 * Accept/Reject is a set-membership update; we re-render from the snapshot
 * each time, so toggling the same hunk N times produces byte-identical
 * output every time. No drift.
 *
 * Algorithm
 * ---------
 *   1. Binary guard: NUL bytes in the snapshot → `snapshot-binary`.
 *   2. Empty set short-circuit: no hunks applied → return the snapshot.
 *   3. Sort the accepted hunks by `oldStart` ascending.
 *   4. Build a single multi-hunk patch and try strict apply.
 *   5. If strict fails, retry with `fuzzFactor: 2` (matches `diffEngine.ts`
 *      `revertHunk` behaviour — tolerates formatter drift in context lines).
 *   6. On still-failure: identify conflicting hunks by single-hunk-on-snapshot
 *      probes. Return `set-conflict` with offending indices.
 *
 * EOL handling
 * ------------
 * Matches `diffEngine.ts revertHunk`: applies hunks to the snapshot as-is.
 * Hunks emitted by `computeDiff` are LF-relative (computeDiff normalises),
 * so on Windows CRLF snapshots the fuzz factor smooths over the EOL
 * mismatch in context lines. The existing 173-test baseline confirms this
 * is correct on both platforms.
 *
 * Purity
 * ------
 * No I/O, no globals. Safe to call from a worker if perf demands it.
 */

const NUL_CHAR_CODE = 0;

function containsNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === NUL_CHAR_CODE) return true;
  }
  return false;
}

export function renderFileFromHunkSet(state: HunkSetState): RenderResult {
  if (containsNul(state.originalSnapshot)) {
    return { ok: false, reason: 'snapshot-binary' };
  }
  if (state.acceptedSet.size === 0) {
    return { ok: true, content: state.originalSnapshot };
  }

  const sortedIndices = sortedAcceptedIndices(state);
  // v0.4 (A4): for each index, substitute editedHunks[idx] if present.
  // Substitution preserves oldStart/oldLines so the patch still locates;
  // only the `+` block + newLines count differs. Unedited hunks pass
  // through untouched.
  const resolveHunk = (i: number): StructuredHunk => state.editedHunks.get(i) ?? state.allHunks[i];
  const patch = makeMultiHunkPatch(sortedIndices.map(resolveHunk));

  // Strict first.
  let applied = Diff.applyPatch(state.originalSnapshot, patch);
  if (applied === false) {
    applied = Diff.applyPatch(state.originalSnapshot, patch, { fuzzFactor: 2 });
  }

  if (typeof applied === 'string') {
    return { ok: true, content: applied };
  }

  // Conflict: identify which hunks are non-applicable in isolation.
  // Per-hunk probes against the original snapshot. A hunk that fails alone
  // is a genuine conflict (e.g. the snapshot already differs). A hunk that
  // succeeds alone but fails in combination is an interaction conflict — we
  // attribute that to the last-sorted index as a deterministic fallback so
  // the UI has something specific to highlight.
  //
  // v0.4: probes also use the substituted hunk so an edit that itself
  // introduces a conflict is attributed to the right index, not Claude's
  // original.
  const conflictingHunks: number[] = [];
  for (const idx of sortedIndices) {
    const probe = makeMultiHunkPatch([resolveHunk(idx)]);
    const r = Diff.applyPatch(state.originalSnapshot, probe, { fuzzFactor: 2 });
    if (r === false) conflictingHunks.push(idx);
  }
  if (conflictingHunks.length === 0) {
    // Pure interaction conflict — flag the last hunk in oldStart order.
    conflictingHunks.push(sortedIndices[sortedIndices.length - 1]);
  }
  return { ok: false, reason: 'set-conflict', conflictingHunks };
}

function sortedAcceptedIndices(state: HunkSetState): number[] {
  const arr: number[] = [];
  for (const idx of state.acceptedSet) {
    if (idx >= 0 && idx < state.allHunks.length) arr.push(idx);
  }
  arr.sort((a, b) => state.allHunks[a].oldStart - state.allHunks[b].oldStart);
  return arr;
}

function makeMultiHunkPatch(hunks: StructuredHunk[]): Diff.ParsedDiff {
  return {
    oldFileName: 'a',
    newFileName: 'b',
    oldHeader: '',
    newHeader: '',
    hunks: hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines.slice(),
    })),
  };
}

/**
 * Build an initial `HunkSetState` from a computed diff's hunks where ALL
 * hunks are considered applied. Calling `renderFileFromHunkSet` on the
 * result produces content byte-identical to the on-disk `after` state
 * (i.e. Claude's edit). This is the migration entry point for v0.1.0
 * sessions — no user-visible behaviour change at session open.
 */
export function initialHunkSetState(
  filePath: HunkSetState['filePath'],
  originalSnapshot: string,
  allHunks: StructuredHunk[],
): HunkSetState {
  const acceptedSet = new Set<number>();
  for (let i = 0; i < allHunks.length; i++) acceptedSet.add(i);
  return { filePath, originalSnapshot, allHunks, acceptedSet, editedHunks: new Map() };
}

/** Exported for unit tests. */
export const __test = { containsNul, sortedAcceptedIndices, makeMultiHunkPatch };
