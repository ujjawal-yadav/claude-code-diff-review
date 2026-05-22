/**
 * v0.3 — heuristic risk-flag triage for review surfaces.
 *
 * Pure functions over already-built `FileReview` / `HunkReview` shapes; no
 * I/O. Called at `openReview` time from `src/reviewOrchestrator.ts` after
 * `toFileReview`. Output is surfaced as `file.flags` and `hunk.flags`.
 *
 * Design intent (per PM review framing: decision support > mechanics): when
 * Claude makes 50 edits, the user doesn't want to eyeball each hunk blind.
 * These heuristics prioritise the riskiest 5-10% so the user can focus
 * review attention there and bulk-accept the rest with more confidence.
 *
 * Heuristics are intentionally conservative — over-flag (cost: small visual
 * chip), under-flag (cost: missed regression). Tuning is empirical: refine
 * if false-positive rate is high in real use.
 */

import type { FileReview, HunkReview, RiskFlag } from './types.js';

/**
 * Path component patterns indicating sensitive content. Anchored to path
 * separators or boundaries so identifier names (e.g. `keyboard.ts` or
 * `tokens.ts` used unrelatedly) don't false-positive. Each clause matches
 * a path SEGMENT or filename pattern, not bare substring.
 */
const SENSITIVE_PATH_RE = new RegExp(
  [
    String.raw`(?:^|[\\/])\.env`,                        // .env, .env.local, etc.
    String.raw`(?:^|[\\/])secrets?(?:[\\/]|$|\.)`,        // /secrets/, /secret/, /secret.json
    String.raw`(?:^|[\\/])credentials?(?:[\\/]|$|\.)`,    // /credentials/, /credential.json
    String.raw`(?:^|[\\/])migrations?(?:[\\/]|$)`,        // /migrations/
    String.raw`(?:^|[\\/])passwords?(?:[\\/]|$|\.)`,
    String.raw`(?:^|[\\/])(?:access|refresh|api)[_-]?tokens?(?:[\\/]|$|\.)`, // access-token, refreshtoken
    String.raw`(?:^|[\\/])auth(?:[\\/]|$|[._-])`,         // /auth/, auth.ts, auth-helpers.ts, but NOT author.ts
    String.raw`(?:^|[\\/])private[_-]?keys?(?:[\\/]|$|\.)`,
    String.raw`(?:^|[\\/])certs?(?:[\\/]|$|\.)`,
    String.raw`(?:^|[\\/])crypto(?:[\\/]|$|[._-])`,
  ].join('|'),
  'i',
);

/** Generated lockfiles — typically safe to bulk-accept. */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'go.sum',
  'pubspec.lock',
  'mix.lock',
]);

/** Test/spec files. Lower risk than production code. */
const TEST_FILE_RE = new RegExp(
  [
    String.raw`(?:^|[\\/])tests?[\\/]`,         // /tests/, /test/
    String.raw`(?:^|[\\/])__tests__[\\/]`,      // /__tests__/
    String.raw`(?:^|[\\/])spec[\\/]`,           // /spec/
    String.raw`\.(?:test|spec)\.[jt]sx?$`,      // foo.test.ts, foo.spec.tsx
    String.raw`_test\.py$`,                     // foo_test.py
    String.raw`_test\.go$`,                     // foo_test.go
  ].join('|'),
  'i',
);

const ERROR_HANDLING_RE = /\b(?:try|catch|throw|finally|raise|except)\b/;
const NULL_CHECK_RE = /(?:!=\s*null|!==\s*null|!=\s*undefined|!==\s*undefined|\?\.|\?\?|isnil|is\s+None)/i;

/** A hunk changing more than this many lines is flagged as `large-hunk`. */
const LARGE_HUNK_THRESHOLD = 50;

/**
 * Flag a file based on its path. Computes file-level flags only — for
 * hunk-level flags see `flagHunk`. Returns an empty array if no flags
 * apply (caller should treat this as "no risk surfacing").
 */
export function flagFile(file: FileReview): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const basename = (file.relPath.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (LOCKFILE_NAMES.has(basename)) flags.push('lockfile');
  if (SENSITIVE_PATH_RE.test(file.relPath)) flags.push('sensitive-path');
  if (TEST_FILE_RE.test(file.relPath)) flags.push('test-file');
  return flags;
}

/**
 * Flag a hunk based on its diff content. Hunk-level flags are independent
 * of file-level flags; both surface to the user in the UI.
 */
export function flagHunk(hunk: HunkReview): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (hunk.lines.length > LARGE_HUNK_THRESHOLD) {
    flags.push('large-hunk');
  }
  let addCount = 0;
  let delCount = 0;
  const removedTexts: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      addCount++;
    } else if (line.startsWith('-')) {
      delCount++;
      removedTexts.push(line);
    }
  }
  if (delCount > 0 && addCount === 0) {
    flags.push('deletion');
  }
  if (removedTexts.length > 0) {
    const joined = removedTexts.join('\n');
    if (ERROR_HANDLING_RE.test(joined)) flags.push('removed-error-handling');
    if (NULL_CHECK_RE.test(joined)) flags.push('removed-null-check');
  }
  return flags;
}

/**
 * Severity ordering — higher numbers are more critical. Used by UI to
 * decide which single flag to display as the "primary" chip when a
 * file/hunk has multiple flags. Tooltip lists ALL flags regardless.
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
