import * as vscode from 'vscode';

import { ReviewOrchestrator } from './reviewOrchestrator.js';
import { FileReview, HunkReview, SessionReview } from './types.js';

/**
 * Inline gutter Accept / Reject lenses (TRD §5.10, M5).
 *
 * Behaviour
 * ---------
 *  - For the active text document, find the first session that contains a
 *    matching FileReview. (Multi-session same-file is rare; first wins.)
 *  - For each pending hunk, render two CodeLenses anchored on the new-side
 *    line range (post-edit positions) — `hunk.newStart..newStart+newLines`.
 *  - Decided hunks render a single read-only "✓ accepted" / "✗ rejected"
 *    lens so the developer can still see what they decided.
 *
 * Refresh cadence
 * ---------------
 *  - `onDidChangeActiveTextEditor`        ⇒ re-eval target file
 *  - orchestrator's `onChange`            ⇒ refresh fired by the host
 *  - `onDidChangeTextDocument` (debounced) is NOT used here; the
 *    orchestrator's debounced re-diff path drives that via `onChange`.
 *
 * Performance
 * -----------
 *  - O(hunks) per provideCodeLenses call. For the largest sessions
 *    permitted by the TRD §15 caps (5,000 hunks) this is well within
 *    VS Code's CodeLens budget. We do not materialise lenses for hunks
 *    that don't intersect the visible range — VS Code already culls.
 */

export const ACCEPT_HUNK_AT = 'claudeReview.acceptHunkAt';
export const REJECT_HUNK_AT = 'claudeReview.rejectHunkAt';

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly orchestrator: ReviewOrchestrator) {}

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const filePath = document.uri.fsPath;
    const match = findHunksForFile(this.orchestrator, filePath);
    if (!match) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const hunk of match.file.hunks) {
      const range = hunkRange(document, hunk);
      if (hunk.status === 'pending') {
        lenses.push(new vscode.CodeLens(range, {
          title: '✓ Accept',
          tooltip: `Accept hunk ${hunk.index + 1}`,
          command: ACCEPT_HUNK_AT,
          arguments: [match.session.sessionId, filePath, hunk.index],
        }));
        lenses.push(new vscode.CodeLens(range, {
          title: '✗ Reject',
          tooltip: `Reject hunk ${hunk.index + 1}`,
          command: REJECT_HUNK_AT,
          arguments: [match.session.sessionId, filePath, hunk.index],
        }));
      } else {
        lenses.push(new vscode.CodeLens(range, {
          title: hunk.status === 'accepted' ? '✓ accepted' : '✗ rejected',
          // No-op command (showing the read-only badge); use a noop command id.
          command: '',
        }));
      }
    }
    return lenses;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function findHunksForFile(
  orchestrator: ReviewOrchestrator,
  filePath: string,
): { session: SessionReview; file: FileReview } | null {
  // Fast path: O(1) cross-session lookup against the orchestrator's index.
  const direct = orchestrator.findFile(filePath);
  if (direct) return direct;

  // Fallback only for the Win32 path-shape mismatch corner case (mixed
  // slashes / drive letter case). With the orchestrator already normalising
  // via `resolveSafe` this should be rare; we keep the slow path as a
  // safety net rather than rebuild the index lazily.
  for (const sessionId of orchestrator.listSessionIds()) {
    const session = orchestrator.getSession(sessionId);
    if (!session) continue;
    const file = session.files.find((f) => pathsEqual(f.filePath, filePath));
    if (file) return { session, file };
  }
  return null;
}

function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  // Windows paths sometimes round-trip with mixed slash + drive case.
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Build the editor range a CodeLens is anchored to. The CodeLens itself
 * sits *above* the line of the first character in the range, so we always
 * anchor at the start of `newStart` (1-indexed in jsdiff, 0-indexed in
 * VS Code).
 */
function hunkRange(document: vscode.TextDocument, hunk: HunkReview): vscode.Range {
  const startLine = Math.max(0, hunk.newStart - 1);
  const safeStart = Math.min(startLine, Math.max(0, document.lineCount - 1));
  const lineRange = document.lineAt(safeStart).range;
  return new vscode.Range(lineRange.start, lineRange.start);
}

/** Exported for tests. */
export const __test = { findHunksForFile, pathsEqual };
