/**
 * v0.5.1 (LH5) — pure cross-bundle constants/helpers for risk flags.
 *
 * MAINTAINER: this module is imported from BOTH bundles:
 *   - host bundle (Node runtime, vscode API): via `src/riskFlagger.ts`
 *   - webview bundle (DOM runtime, no Node): via `webview/components/FlagChip.tsx`
 *
 * Therefore it MUST stay pure:
 *   - No `node:*` imports
 *   - No `vscode` imports
 *   - No DOM globals (`document`, `window`)
 *   - Type imports only from `src/types.ts` (which is itself pure)
 *
 * Prior to v0.5.1, FlagChip imported these constants directly from
 * `src/riskFlagger.ts` — that file was de-facto pure but one stray
 * `import * as fs from 'node:fs'` would have broken the webview bundle.
 * Hoisting to `src/shared/` makes the contract explicit.
 */

import type { RiskFlag } from '../types.js';

/**
 * Severity used to pick the "primary" flag when a hunk/file carries
 * multiple. The chip shows ONE; the tooltip lists all.
 *
 * `test-file` and `lockfile` are informational (low severity) — they
 * REDUCE perceived risk, not increase it, but appear in the chip so
 * the user knows the file's nature.
 */
export const FLAG_SEVERITY: Readonly<Record<RiskFlag, number>> = {
  'sensitive-path':          100,
  'removed-error-handling':   80,
  'removed-null-check':       70,
  'deletion':                 60,
  'large-hunk':               40,
  'test-file':                10,
  'lockfile':                  5,
};

/** Short label shown in the chip / badge. Emoji-prefixed for quick scanning. */
export const FLAG_LABEL: Readonly<Record<RiskFlag, string>> = {
  'sensitive-path':         '🔴 sensitive',
  'removed-error-handling': '⚠ error handling',
  'removed-null-check':     '⚠ null check',
  'deletion':               '🟡 deletion',
  'large-hunk':             '🟡 large',
  'test-file':              '🧪 test',
  'lockfile':               '🔒 lockfile',
};

/** Full description shown in the tooltip / aria-label. */
export const FLAG_DESCRIPTION: Readonly<Record<RiskFlag, string>> = {
  'sensitive-path':         'File path matches a sensitive pattern (env, secrets, credentials, migrations, auth). Review extra carefully.',
  'removed-error-handling': 'This hunk removes try/catch/throw/finally code. Verify the error handling change is intentional.',
  'removed-null-check':     'This hunk removes null/undefined checks. Verify the value cannot be null at this point.',
  'deletion':               'This hunk is pure deletion (no additions). Verify the removed code is unused elsewhere.',
  'large-hunk':             'This hunk changes more than 50 lines. Consider whether it could be broken into smaller reviewable pieces.',
  'test-file':              'Test/spec file. Generally lower risk than production code.',
  'lockfile':               'Generated lockfile. Usually safe to accept without line-by-line review.',
};

/**
 * Pick the highest-severity flag for chip display. Returns null if `flags`
 * is empty or undefined. UI calls this to decide what text to render in
 * the single visible chip slot.
 */
export function primaryFlag(flags: ReadonlyArray<RiskFlag> | undefined): RiskFlag | null {
  if (!flags || flags.length === 0) return null;
  let winner = flags[0]!;
  let winnerSeverity = FLAG_SEVERITY[winner];
  for (let i = 1; i < flags.length; i++) {
    const f = flags[i]!;
    const s = FLAG_SEVERITY[f];
    if (s > winnerSeverity) {
      winner = f;
      winnerSeverity = s;
    }
  }
  return winner;
}
