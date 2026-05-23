/**
 * v0.3 — pure helpers for keyboard-driven hunk navigation.
 *
 * The webview global keydown handler in App.tsx calls these to compute
 * the next/previous hunk position given the current (selectedFile,
 * selectedHunk) pair and the session shape. All decisions are made here;
 * the handler just dispatches the result via Zustand mutations.
 *
 * Pure functions; trivially unit-testable without DOM.
 */

import type { SessionReview } from '../../src/types';

export interface HunkPosition {
  filePath: string;
  hunkIndex: number;
}

/**
 * Find the position of the next hunk after `(currentFile, currentHunk)`.
 * Walks within the current file first, then spills into the first hunk of
 * the next file. Returns null when already at the last hunk of the last
 * file (no wrap-around — wrap-around would surprise the user).
 *
 * Called by `j` / `↓` key handler.
 */
export function nextHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'forward', () => true);
}

/**
 * Symmetric: previous hunk; spills into the last hunk of the previous file.
 * Called by `k` / `↑` key handler.
 */
export function prevHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'backward', () => true);
}

/**
 * Next hunk that carries at least one risk flag. Skips unflagged hunks.
 * Used by `Shift+J` to jump straight to the next risky review item.
 */
export function nextFlaggedHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'forward', (pos) => {
    const file = session.files.find((f) => f.filePath === pos.filePath);
    if (!file) return false;
    const hunk = file.hunks[pos.hunkIndex];
    if (!hunk) return false;
    return (hunk.flags?.length ?? 0) > 0 || (file.flags?.length ?? 0) > 0;
  });
}

/**
 * Symmetric: previous flagged hunk. Used by `Shift+K`.
 */
export function prevFlaggedHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'backward', (pos) => {
    const file = session.files.find((f) => f.filePath === pos.filePath);
    if (!file) return false;
    const hunk = file.hunks[pos.hunkIndex];
    if (!hunk) return false;
    return (hunk.flags?.length ?? 0) > 0 || (file.flags?.length ?? 0) > 0;
  });
}

/**
 * v0.5: next hunk that carries at least one build-signal error (i.e. tsc
 * flagged a line within its range). Used by `Shift+N` to jump straight to
 * the next hunk that breaks the build.
 */
export function nextBuildAffectedHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'forward', (pos) => {
    const file = session.files.find((f) => f.filePath === pos.filePath);
    if (!file) return false;
    const hunk = file.hunks[pos.hunkIndex];
    if (!hunk) return false;
    return (hunk.buildErrors?.length ?? 0) > 0;
  });
}

/** v0.5: symmetric previous. Used by `Shift+P`. */
export function prevBuildAffectedHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
): HunkPosition | null {
  return seekHunk(session, currentFile, currentHunk, 'backward', (pos) => {
    const file = session.files.find((f) => f.filePath === pos.filePath);
    if (!file) return false;
    const hunk = file.hunks[pos.hunkIndex];
    if (!hunk) return false;
    return (hunk.buildErrors?.length ?? 0) > 0;
  });
}

// --- internals --------------------------------------------------------------

type Direction = 'forward' | 'backward';
type Predicate = (pos: HunkPosition) => boolean;

/**
 * Generic hunk-iteration helper. Walks the session in the given direction
 * starting AFTER the current position; returns the first position matching
 * `predicate`. Returns null if no such position exists.
 *
 * When `currentFile === null`, starts from the first file (forward) or last
 * file (backward) — useful for "jump to first flagged hunk" with no prior
 * selection.
 */
function seekHunk(
  session: SessionReview,
  currentFile: string | null,
  currentHunk: number | null,
  direction: Direction,
  predicate: Predicate,
): HunkPosition | null {
  if (session.files.length === 0) return null;
  // Compute starting (fileIdx, hunkIdx) given the current position.
  let fileIdx: number;
  let hunkIdx: number;
  if (currentFile === null) {
    fileIdx = direction === 'forward' ? 0 : session.files.length - 1;
    const f = session.files[fileIdx]!;
    hunkIdx = direction === 'forward' ? -1 : f.hunks.length;
  } else {
    fileIdx = session.files.findIndex((f) => f.filePath === currentFile);
    if (fileIdx === -1) {
      // Stale selection — start from edge in the chosen direction.
      fileIdx = direction === 'forward' ? 0 : session.files.length - 1;
      const f = session.files[fileIdx]!;
      hunkIdx = direction === 'forward' ? -1 : f.hunks.length;
    } else {
      hunkIdx = currentHunk ?? (direction === 'forward' ? -1 : session.files[fileIdx]!.hunks.length);
    }
  }

  // Walk.
  while (fileIdx >= 0 && fileIdx < session.files.length) {
    const file = session.files[fileIdx]!;
    if (direction === 'forward') {
      hunkIdx += 1;
      while (hunkIdx < file.hunks.length) {
        const candidate: HunkPosition = { filePath: file.filePath, hunkIndex: hunkIdx };
        if (predicate(candidate)) return candidate;
        hunkIdx += 1;
      }
      fileIdx += 1;
      hunkIdx = -1; // restart at top of next file
    } else {
      hunkIdx -= 1;
      while (hunkIdx >= 0) {
        const candidate: HunkPosition = { filePath: file.filePath, hunkIndex: hunkIdx };
        if (predicate(candidate)) return candidate;
        hunkIdx -= 1;
      }
      fileIdx -= 1;
      if (fileIdx >= 0) hunkIdx = session.files[fileIdx]!.hunks.length; // restart at bottom of prev file
    }
  }
  return null;
}

/** Exported for tests only. */
export const __test = { seekHunk };
