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
// v0.5.1 (LH5): FLAG_SEVERITY / FLAG_LABEL / FLAG_DESCRIPTION / primaryFlag
// were moved to `src/shared/riskFlags.shared.ts` so the webview bundle can
// import them without crossing into host runtime code. Re-exported here
// for host callers that previously imported from this module.
export {
  FLAG_SEVERITY,
  FLAG_LABEL,
  FLAG_DESCRIPTION,
  primaryFlag,
} from './shared/riskFlags.shared.js';
