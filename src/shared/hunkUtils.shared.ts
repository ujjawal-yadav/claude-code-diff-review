/**
 * v0.5.1 (LH5) — pure cross-bundle hunk helpers.
 *
 * MAINTAINER: this module is imported from BOTH bundles. See
 * `src/shared/riskFlags.shared.ts` for the same contract. Keep pure —
 * type imports only from `src/types.ts`.
 */

import type { HunkReview, StructuredHunk } from '../types.js';

/**
 * Extract a hunk's after-view (post-edit content as the user sees it)
 * by stripping diff prefixes from `+` and ` ` (context) lines, joining
 * with newlines. Used to pre-populate the edit textarea AND mirrored on
 * the webview side for the same purpose without crossing the bundle
 * boundary.
 *
 * Prior to v0.5.1, this function was duplicated in
 * `src/reviewOrchestrator.ts` and `webview/components/HunkBlock.tsx`.
 * Hoisting to `src/shared/` removes the drift hazard.
 */
export function extractHunkAfterView(h: StructuredHunk | HunkReview): string {
  const out: string[] = [];
  for (const line of h.lines) {
    const tag = line.charAt(0);
    if (tag === '+' || tag === ' ') {
      out.push(line.slice(1));
    }
  }
  return out.join('\n');
}
