/**
 * v0.3 — riskFlagger heuristic tests.
 *
 * Verifies each flag class fires on its target pattern and (critically)
 * does NOT false-positive on identifier-like names that share substrings.
 * The "no false positives" tests are the load-bearing ones — a noisy
 * flag is worse than no flag.
 */

import { describe, it, expect } from 'vitest';
import {
  flagFile,
  flagHunk,
  primaryFlag,
  FLAG_SEVERITY,
  FLAG_LABEL,
  FLAG_DESCRIPTION,
} from '../../src/riskFlagger.js';
import { asAbsPath, RiskFlag } from '../../src/types.js';
import type { FileReview, HunkReview } from '../../src/types.js';

// Test helpers ---------------------------------------------------------------

function mkFile(relPath: string): FileReview {
  return {
    filePath: asAbsPath('/work/' + relPath),
    relPath,
    before: '', after: '',
    hunks: [],
    status: 'pending',
    isNew: false, isDeleted: false, isBinary: false,
    warnings: [],
  };
}

function mkHunk(lines: string[]): HunkReview {
  return {
    index: 0,
    oldStart: 1, oldLines: 1,
    newStart: 1, newLines: 1,
    header: '@@',
    lines,
    status: 'pending',
  };
}

// flagFile -------------------------------------------------------------------

describe('flagFile', () => {
  it('flags .env files as sensitive-path', () => {
    expect(flagFile(mkFile('.env'))).toContain('sensitive-path');
    expect(flagFile(mkFile('.env.local'))).toContain('sensitive-path');
    expect(flagFile(mkFile('config/.env.production'))).toContain('sensitive-path');
  });

  it('flags secrets / credentials paths as sensitive-path', () => {
    expect(flagFile(mkFile('src/secrets/loader.ts'))).toContain('sensitive-path');
    expect(flagFile(mkFile('credentials.json'))).toContain('sensitive-path');
    expect(flagFile(mkFile('app/credential.ts'))).toContain('sensitive-path');
  });

  it('flags migrations paths as sensitive-path', () => {
    expect(flagFile(mkFile('migrations/001_init.sql'))).toContain('sensitive-path');
    expect(flagFile(mkFile('db/migration/add_users.rb'))).toContain('sensitive-path');
  });

  it('flags auth paths as sensitive-path', () => {
    expect(flagFile(mkFile('src/auth/jwt.ts'))).toContain('sensitive-path');
    expect(flagFile(mkFile('app/auth.ts'))).toContain('sensitive-path');
    expect(flagFile(mkFile('lib/auth-helpers.ts'))).toContain('sensitive-path');
  });

  it('flags crypto / cert paths as sensitive-path', () => {
    expect(flagFile(mkFile('src/crypto.ts'))).toContain('sensitive-path');
    expect(flagFile(mkFile('certs/ca.pem'))).toContain('sensitive-path');
    expect(flagFile(mkFile('private-key.pem'))).toContain('sensitive-path');
  });

  it('does NOT false-positive on identifier names that share substrings', () => {
    // 'keys' in 'keyboard.ts' — regex anchored to path segments
    expect(flagFile(mkFile('webview/keyboard.ts'))).not.toContain('sensitive-path');
    // 'auth' in 'author.ts'
    expect(flagFile(mkFile('models/author.ts'))).not.toContain('sensitive-path');
    // 'auth' as a substring inside a longer non-auth-related word
    expect(flagFile(mkFile('lib/authorize-printer.ts'))).not.toContain('sensitive-path');
    // 'crypto' as identifier in non-crypto file
    expect(flagFile(mkFile('docs/cryptocurrency-design.md'))).not.toContain('sensitive-path');
  });

  it('flags lockfiles correctly', () => {
    expect(flagFile(mkFile('package-lock.json'))).toContain('lockfile');
    expect(flagFile(mkFile('yarn.lock'))).toContain('lockfile');
    expect(flagFile(mkFile('pnpm-lock.yaml'))).toContain('lockfile');
    expect(flagFile(mkFile('Cargo.lock'))).toContain('lockfile');
    expect(flagFile(mkFile('go.sum'))).toContain('lockfile');
    expect(flagFile(mkFile('apps/web/package-lock.json'))).toContain('lockfile');
  });

  it('does NOT flag non-lockfile JSON', () => {
    expect(flagFile(mkFile('package.json'))).not.toContain('lockfile');
    expect(flagFile(mkFile('config.json'))).not.toContain('lockfile');
  });

  it('flags test files', () => {
    expect(flagFile(mkFile('tests/foo.ts'))).toContain('test-file');
    expect(flagFile(mkFile('src/utils.test.ts'))).toContain('test-file');
    expect(flagFile(mkFile('src/utils.spec.tsx'))).toContain('test-file');
    expect(flagFile(mkFile('__tests__/utils.ts'))).toContain('test-file');
    expect(flagFile(mkFile('spec/models/user.rb'))).toContain('test-file');
    expect(flagFile(mkFile('pkg/foo_test.go'))).toContain('test-file');
    expect(flagFile(mkFile('app/foo_test.py'))).toContain('test-file');
  });

  it('does NOT flag production files', () => {
    expect(flagFile(mkFile('src/main.ts'))).toEqual([]);
    expect(flagFile(mkFile('lib/helpers.ts'))).toEqual([]);
    expect(flagFile(mkFile('README.md'))).toEqual([]);
  });

  it('returns empty array for unflaggable file', () => {
    expect(flagFile(mkFile('src/components/Button.tsx'))).toEqual([]);
  });

  it('composes multiple file-level flags', () => {
    // A test file inside an auth folder — both test-file and sensitive-path
    const flags = flagFile(mkFile('src/auth/jwt.test.ts'));
    expect(flags).toContain('test-file');
    expect(flags).toContain('sensitive-path');
  });
});

// flagHunk -------------------------------------------------------------------

describe('flagHunk', () => {
  it('flags pure-deletion hunks', () => {
    const flags = flagHunk(mkHunk(['-old line 1', '-old line 2']));
    expect(flags).toContain('deletion');
  });

  it('does NOT flag hunks with both additions and deletions', () => {
    const flags = flagHunk(mkHunk(['-old', '+new']));
    expect(flags).not.toContain('deletion');
  });

  it('does NOT flag context-only hunks', () => {
    const flags = flagHunk(mkHunk([' context1', ' context2']));
    expect(flags).not.toContain('deletion');
  });

  it('flags large hunks (>50 lines)', () => {
    const lines = Array.from({ length: 51 }, (_, i) => i < 25 ? `-line ${i}` : `+line ${i}`);
    expect(flagHunk(mkHunk(lines))).toContain('large-hunk');
  });

  it('does NOT flag exactly-50-line hunks', () => {
    const lines = Array.from({ length: 50 }, (_, i) => i < 25 ? `-line ${i}` : `+line ${i}`);
    expect(flagHunk(mkHunk(lines))).not.toContain('large-hunk');
  });

  it('flags hunks that remove error-handling code', () => {
    const flags = flagHunk(mkHunk([
      ' function foo() {',
      '-  try {',
      '-    doStuff();',
      '-  } catch (err) {',
      '-    log(err);',
      '-  }',
      '+  doStuff();',
      ' }',
    ]));
    expect(flags).toContain('removed-error-handling');
  });

  it('flags Python except blocks removal', () => {
    const flags = flagHunk(mkHunk([
      '-except ValueError as e:',
      '-    raise',
    ]));
    expect(flags).toContain('removed-error-handling');
  });

  it('flags hunks that remove null checks', () => {
    const flags = flagHunk(mkHunk([
      '-  if (user != null) {',
      '-    return user.name;',
      '-  }',
      '+  return user.name;',
    ]));
    expect(flags).toContain('removed-null-check');
  });

  it('flags removal of optional chaining', () => {
    expect(flagHunk(mkHunk([
      '-  return data?.name;',
      '+  return data.name;',
    ]))).toContain('removed-null-check');
  });

  it('flags removal of nullish coalescing', () => {
    expect(flagHunk(mkHunk([
      '-  const v = x ?? 0;',
      '+  const v = x || 0;',
    ]))).toContain('removed-null-check');
  });

  it('does NOT flag pure additions (no removed text to scan)', () => {
    const flags = flagHunk(mkHunk(['+new line']));
    expect(flags).not.toContain('removed-error-handling');
    expect(flags).not.toContain('removed-null-check');
    expect(flags).not.toContain('deletion');
  });

  it('composes multiple hunk-level flags', () => {
    // A large hunk that's pure deletion AND removes error handling
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`-old ${i}`);
    lines.push('-try { something(); } catch (e) {}');
    for (let i = 0; i < 20; i++) lines.push(`-more ${i}`);
    const flags = flagHunk(mkHunk(lines));
    expect(flags).toContain('large-hunk');
    expect(flags).toContain('deletion');
    expect(flags).toContain('removed-error-handling');
  });

  it('returns empty array for trivial hunks', () => {
    expect(flagHunk(mkHunk([' just context']))).toEqual([]);
  });
});

// primaryFlag + severity ordering -------------------------------------------

describe('primaryFlag', () => {
  it('returns null for empty or undefined input', () => {
    expect(primaryFlag(undefined)).toBeNull();
    expect(primaryFlag([])).toBeNull();
  });

  it('returns single flag unchanged', () => {
    expect(primaryFlag(['deletion'])).toBe('deletion');
  });

  it('picks highest severity from multiple', () => {
    // sensitive-path (100) > deletion (60)
    expect(primaryFlag(['deletion', 'sensitive-path'])).toBe('sensitive-path');
    // removed-error-handling (80) > large-hunk (40)
    expect(primaryFlag(['large-hunk', 'removed-error-handling'])).toBe('removed-error-handling');
    // test-file (10) loses to deletion (60)
    expect(primaryFlag(['test-file', 'deletion'])).toBe('deletion');
  });

  it('breaks ties deterministically (first occurrence wins)', () => {
    // Same severity is unusual but handled — first wins
    expect(primaryFlag(['test-file', 'lockfile'])).toBe('test-file');
  });
});

// Constants integrity -------------------------------------------------------

describe('flag constants', () => {
  it('every RiskFlag has a severity, label, and description', () => {
    const flags: RiskFlag[] = [
      'sensitive-path', 'deletion', 'removed-error-handling',
      'removed-null-check', 'large-hunk', 'lockfile', 'test-file',
    ];
    for (const f of flags) {
      expect(FLAG_SEVERITY[f]).toBeGreaterThanOrEqual(0);
      expect(FLAG_LABEL[f]).toBeTruthy();
      expect(FLAG_DESCRIPTION[f].length).toBeGreaterThan(20);
    }
  });

  it('severity values are unique (no ties in the canonical ordering)', () => {
    const values = Object.values(FLAG_SEVERITY);
    expect(new Set(values).size).toBe(values.length);
  });
});
