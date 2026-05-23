import type { BuildErrorRef, FileReview, HunkReview } from '../types.js';

/**
 * v0.5 — annotate FileReview / HunkReview with build-signal diagnostics.
 *
 * Pure: no I/O, no globals, deterministic over inputs. Mutates the
 * `files[]` array in-place because the orchestrator owns the FileReview
 * objects and downstream consumers (panel, codeLens, store) read via
 * reference. Returns nothing — the mutation IS the result.
 *
 * Per-hunk rule (L10): a hunk "affects a failing build" iff at least one
 * tsc error's line falls within the hunk's POST-EDIT range
 * `[newStart, newStart + newLines - 1]`. We use `newStart`/`newLines`
 * (the after-side coords) because the tsc error position is reported
 * against the current file content, which reflects whatever has been
 * accepted to disk.
 *
 * v0.5.1 (LH2): the per-hunk coords are read from a SNAPSHOT taken at
 * runner-start time, NOT the live FileReview. This closes a race where
 * `handleEditHunk` mutates `hunk.newStart` / `hunk.newLines` in-place
 * while tsc is still running — without the snapshot, intersection
 * matches tsc-time diagnostic line numbers against post-edit hunk
 * ranges, mis-attributing badges. Snapshot makes the semantic honest:
 * "results reflect file state at the moment typecheck started."
 *
 * Per-file rule: `buildStatus = 'fail'` iff at least one diagnostic
 * targets this file (matched by `relPath`). The file is `'fail'` even
 * when the offending lines fall in unchanged context — the precision
 * signal is at the hunk level.
 *
 * Note: warning-severity diagnostics do NOT flip `buildStatus` to
 * `'fail'` — only `'error'` severity does. Warnings are still attached
 * to the affected hunks for visibility, but the aggregate stays `'pass'`
 * unless tsc emitted an actual error.
 */

/**
 * v0.5.1 (LH2): per-file hunk coord snapshot captured at runner-start.
 * Key is the file's `relPath` (matches tsc's diagnostic.relPath format).
 * Value is one entry per hunk with the index + the post-edit range as
 * it was when typecheck began.
 */
export type HunkCoordSnapshot = Map<string, Array<{
  index: number;
  newStart: number;
  newLines: number;
}>>;

export function intersectDiagnosticsWithHunks(
  files: FileReview[],
  diagnostics: ReadonlyArray<BuildErrorRef>,
  coords?: HunkCoordSnapshot,
): void {
  // Index diagnostics by relPath for O(F + D) traversal instead of O(F * D).
  // v0.5.1 (LH7): check `isProjectLevel` explicitly. Falls back to the
  // empty-relPath sentinel for forward-compat with any caller that hand-
  // constructs BuildErrorRef without setting the flag.
  const byPath = new Map<string, BuildErrorRef[]>();
  for (const d of diagnostics) {
    if (d.isProjectLevel || !d.relPath) continue;
    const arr = byPath.get(d.relPath) ?? [];
    arr.push(d);
    byPath.set(d.relPath, arr);
  }

  for (const file of files) {
    const matches = byPath.get(file.relPath);
    if (!matches || matches.length === 0) {
      // No diagnostics for this file — mark pass; clear any prior per-hunk.
      file.buildStatus = 'pass';
      for (const h of file.hunks) {
        if (h.buildErrors !== undefined) delete h.buildErrors;
      }
      continue;
    }

    // Has at least one diagnostic. If any is severity:'error' → fail; else
    // remain pass with warnings attached.
    const hasError = matches.some((d) => d.severity === 'error');
    file.buildStatus = hasError ? 'fail' : 'pass';

    // Attribute per hunk by line-range intersection.
    // v0.5.1 (LH2): look up coords in the snapshot first; fall back to live
    // hunk coords only if no snapshot was provided (legacy callers / tests).
    const snapshotEntries = coords?.get(file.relPath);
    for (const h of file.hunks) {
      const snap = snapshotEntries?.find((e) => e.index === h.index);
      const newStart = snap?.newStart ?? h.newStart;
      const newLines = snap?.newLines ?? h.newLines;
      const hits = matches.filter((d) => containsLine(newStart, newLines, d.line));
      if (hits.length > 0) {
        h.buildErrors = hits;
      } else if (h.buildErrors !== undefined) {
        delete h.buildErrors;
      }
    }
  }
}

/** Inclusive line-range intersection. Tolerates `newLines: 0` (delete-only). */
function hunkContainsLine(hunk: HunkReview, line: number): boolean {
  if (hunk.newLines <= 0) return false;
  return line >= hunk.newStart && line < hunk.newStart + hunk.newLines;
}

/** v0.5.1 (LH2): pure variant used with snapshot coords. */
function containsLine(newStart: number, newLines: number, line: number): boolean {
  if (newLines <= 0) return false;
  return line >= newStart && line < newStart + newLines;
}

/** Exported for tests. */
export const __test = { hunkContainsLine, containsLine };
