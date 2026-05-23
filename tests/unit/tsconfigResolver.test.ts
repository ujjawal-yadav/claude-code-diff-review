/**
 * v0.5 — unit tests for tsconfigResolver.
 *
 * Verifies the discovery chain (tsconfig.build.json preferred over
 * tsconfig.json), JSONC comment-stripping, and composite/references
 * detection that drives `tsc -b` mode selection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../src/logger.js';
import { resolveTsconfig, __test as priv } from '../../src/buildSignal/tsconfigResolver.js';

const logger = new Logger('test', 'error');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tsconfig-res-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('stripJsonComments', () => {
  it('strips line comments', () => {
    const input = '{\n  "x": 1 // trailing comment\n}';
    const out = priv.stripJsonComments(input);
    expect(out).not.toContain('//');
    expect(out).not.toContain('trailing comment');
    expect(JSON.parse(out)).toEqual({ x: 1 });
  });

  it('strips block comments', () => {
    const input = '{ /* block */ "x": 1 }';
    expect(priv.stripJsonComments(input).trim()).toBe('{  "x": 1 }');
  });

  it('strips trailing commas', () => {
    const input = '{ "x": 1, "y": 2, }';
    expect(priv.stripJsonComments(input)).toBe('{ "x": 1, "y": 2 }');
  });

  it('handles a realistic tsconfig with mixed JSONC', () => {
    const raw = [
      '{',
      '  // Editor config',
      '  "compilerOptions": {',
      '    /* strict mode */',
      '    "strict": true,',
      '  },',
      '}',
    ].join('\n');
    const parsed = JSON.parse(priv.stripJsonComments(raw));
    expect(parsed).toEqual({ compilerOptions: { strict: true } });
  });
});

describe('resolveTsconfig — discovery chain', () => {
  it('returns null when no tsconfig exists at root', async () => {
    const result = await resolveTsconfig(dir, logger);
    expect(result).toBeNull();
  });

  it('finds tsconfig.json when only that file exists', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }');
    const result = await resolveTsconfig(dir, logger);
    expect(result).not.toBeNull();
    expect(result!.configPath).toBe(join(dir, 'tsconfig.json'));
    expect(result!.useBuildMode).toBe(false);
  });

  it('prefers tsconfig.build.json over tsconfig.json when both exist', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, 'tsconfig.build.json'), '{}');
    const result = await resolveTsconfig(dir, logger);
    expect(result!.configPath).toBe(join(dir, 'tsconfig.build.json'));
  });
});

describe('resolveTsconfig — composite / references detection', () => {
  it('useBuildMode=false for a vanilla single-project tsconfig', async () => {
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true } }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(false);
  });

  it('useBuildMode=true when composite is true on compilerOptions', async () => {
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "compilerOptions": { "composite": true } }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(true);
  });

  it('useBuildMode=true when references[] is non-empty', async () => {
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "references": [{ "path": "./packages/a" }] }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(true);
  });

  it('useBuildMode=false when references is empty array', async () => {
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "references": [] }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(false);
  });

  it('tolerates JSONC comments in the resolved file', async () => {
    const raw = [
      '{',
      '  // composite project',
      '  "compilerOptions": {',
      '    "composite": true,',
      '  },',
      '}',
    ].join('\n');
    await writeFile(join(dir, 'tsconfig.json'), raw);
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(true);
  });

  it('returns useBuildMode=false on malformed JSON (falls back gracefully)', async () => {
    await writeFile(join(dir, 'tsconfig.json'), 'not valid json');
    const result = await resolveTsconfig(dir, logger);
    // Still returns the file path (it exists), but useBuildMode is false
    // because we couldn't parse it.
    expect(result).not.toBeNull();
    expect(result!.useBuildMode).toBe(false);
  });
});

describe('resolveTsconfig — extends chain', () => {
  it('inherits composite from a base config via extends', async () => {
    await writeFile(
      join(dir, 'base.json'),
      '{ "compilerOptions": { "composite": true } }',
    );
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "extends": "./base.json" }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(true);
  });

  it('handles array-form extends (TS 5.0+)', async () => {
    await writeFile(
      join(dir, 'a.json'),
      '{ "compilerOptions": { "strict": true } }',
    );
    await writeFile(
      join(dir, 'b.json'),
      '{ "compilerOptions": { "composite": true } }',
    );
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "extends": ["./a.json", "./b.json"] }',
    );
    const result = await resolveTsconfig(dir, logger);
    expect(result!.useBuildMode).toBe(true);
  });

  it('cycle-safe: caps recursion at depth 5', async () => {
    // Self-referencing extends — would loop without the depth cap.
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "extends": "./tsconfig.json" }',
    );
    const result = await resolveTsconfig(dir, logger);
    // No error; recursion bottoms out at the cap.
    expect(result).not.toBeNull();
    expect(result!.useBuildMode).toBe(false);
  });
});
