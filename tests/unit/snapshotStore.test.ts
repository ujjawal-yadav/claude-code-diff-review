import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotStore, resolveSafe, __test } from '../../src/snapshotStore.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-store-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeStore(overrides: Partial<ConstructorParameters<typeof SnapshotStore>[0]> = {}): SnapshotStore {
  return new SnapshotStore({
    maxSessionBytes: 50 * 1024 * 1024,
    maxFilesPerSession: 200,
    maxFileBytes: 25 * 1024 * 1024,
    ...overrides,
  });
}

describe('snapshotStore — resolveSafe', () => {
  it('resolves relative paths under cwd', () => {
    const out = resolveSafe('/work', 'src/foo.ts');
    expect(out).toMatch(/[\\/]work[\\/]src[\\/]foo\.ts$/i);
  });

  it('rejects paths that escape cwd', () => {
    expect(resolveSafe('/work', '../etc/passwd')).toBeNull();
    expect(resolveSafe('/work', '../../../etc/passwd')).toBeNull();
  });

  it('accepts absolute paths inside cwd', () => {
    const out = resolveSafe('/work', '/work/src/foo.ts');
    expect(out).not.toBeNull();
  });

  it('rejects absolute paths outside cwd', () => {
    expect(resolveSafe('/work', '/etc/passwd')).toBeNull();
  });

  it('normaliseDriveCase upper-cases Windows drive letter', () => {
    if (process.platform === 'win32') {
      expect(__test.normaliseDriveCase('c:\\foo')).toBe('C:\\foo');
    }
  });
});

describe('snapshotStore — captureOriginal', () => {
  it('reads file content on first capture', async () => {
    const file = path.join(tmp, 'a.ts');
    await fs.writeFile(file, 'hello');
    const store = makeStore();
    const resolved = await store.captureOriginal('sid', tmp, 'a.ts');
    expect(resolved).not.toBeNull();
    const session = store.get('sid')!;
    expect(session.originals.size).toBe(1);
    expect([...session.originals.values()][0]).toBe('hello');
  });

  it('records empty string for non-existent files', async () => {
    const store = makeStore();
    const resolved = await store.captureOriginal('sid', tmp, 'newfile.ts');
    expect(resolved).not.toBeNull();
    const session = store.get('sid')!;
    expect([...session.originals.values()][0]).toBe('');
  });

  it('first-snapshot wins: subsequent captures are no-ops', async () => {
    const file = path.join(tmp, 'a.ts');
    await fs.writeFile(file, 'first');
    const store = makeStore();
    await store.captureOriginal('sid', tmp, 'a.ts');
    await fs.writeFile(file, 'second');
    await store.captureOriginal('sid', tmp, 'a.ts');
    const session = store.get('sid')!;
    expect([...session.originals.values()][0]).toBe('first');
  });

  it('rejects path-traversal attempts', async () => {
    const store = makeStore();
    const result = await store.captureOriginal('sid', tmp, '../../etc/passwd');
    expect(result).toBeNull();
    expect(store.get('sid')?.originals.size ?? 0).toBe(0);
  });

  it('concurrent captures of same path → only one read', async () => {
    const file = path.join(tmp, 'a.ts');
    await fs.writeFile(file, 'content');
    const store = makeStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.captureOriginal('sid', tmp, 'a.ts')),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    expect(store.get('sid')!.originals.size).toBe(1);
  });

  it('concurrent captures of different paths run in parallel', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `f${i}.ts`), `content-${i}`);
    }
    const store = makeStore();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.captureOriginal('sid', tmp, `f${i}.ts`)),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    expect(store.get('sid')!.originals.size).toBe(5);
  });

  it('flags overBudget when file count cap exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `f${i}.ts`), 'x');
    }
    const store = makeStore({ maxFilesPerSession: 3 });
    for (let i = 0; i < 5; i++) {
      await store.captureOriginal('sid', tmp, `f${i}.ts`);
    }
    expect(store.get('sid')!.overBudget).toBe(true);
    expect(store.get('sid')!.originals.size).toBe(3);
  });

  it('flags overBudget when byte cap exceeded', async () => {
    await fs.writeFile(path.join(tmp, 'big.ts'), 'x'.repeat(2000));
    const store = makeStore({ maxSessionBytes: 1000 });
    await store.captureOriginal('sid', tmp, 'big.ts');
    expect(store.get('sid')!.overBudget).toBe(true);
    expect(store.get('sid')!.originals.size).toBe(0);
  });
});

describe('snapshotStore — recordTouched / lifecycle', () => {
  it('recordTouched adds path to set', () => {
    const store = makeStore();
    const r = store.recordTouched('sid', tmp, 'a.ts');
    expect(r).not.toBeNull();
    expect(store.get('sid')!.touched.size).toBe(1);
  });

  it('recordTouched rejects path traversal', () => {
    const store = makeStore();
    const r = store.recordTouched('sid', tmp, '../escape.ts');
    expect(r).toBeNull();
    expect(store.get('sid')).toBeUndefined();
  });

  it('release drops session entirely', async () => {
    const store = makeStore();
    await store.captureOriginal('sid', tmp, 'a.ts');
    expect(store.size()).toBe(1);
    store.release('sid');
    expect(store.size()).toBe(0);
  });

  it('totalBytes sums across sessions', async () => {
    const store = makeStore();
    await fs.writeFile(path.join(tmp, 'a.ts'), 'aaa');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'bb');
    await store.captureOriginal('s1', tmp, 'a.ts');
    await store.captureOriginal('s2', tmp, 'b.ts');
    expect(store.totalBytes()).toBe(5);
  });

  it('different sessions are isolated', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'aaa');
    const store = makeStore();
    await store.captureOriginal('s1', tmp, 'a.ts');
    await store.captureOriginal('s2', tmp, 'a.ts');
    expect(store.get('s1')!.originals.size).toBe(1);
    expect(store.get('s2')!.originals.size).toBe(1);
    expect(store.size()).toBe(2);
  });
});
