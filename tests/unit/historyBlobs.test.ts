/**
 * T1-A3: BlobStore dedupes by SHA-256, writes atomically, lists shards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BlobStore, sha256Hex } from '../../src/history/historyBlobs.js';

let root: string;
let store: BlobStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-blob-'));
  store = new BlobStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('BlobStore — T1-A3 content-addressed storage', () => {
  it('write returns the SHA-256 hex of the content', async () => {
    const content = 'hello world';
    const expected = sha256Hex(content);
    const got = await store.write(content);
    expect(got).toBe(expected);
  });

  it('round-trips content through write/read', async () => {
    const content = 'multi\nline\ncontent\n';
    const sha = await store.write(content);
    const read = await store.read(sha);
    expect(read).toBe(content);
  });

  it('dedupes identical content (idempotent write)', async () => {
    const content = 'same';
    const sha1 = await store.write(content);
    const sha2 = await store.write(content);
    expect(sha1).toBe(sha2);
    // Only one shard directory created, and exactly one .txt blob inside.
    const shards = await fs.readdir(path.join(root, 'blobs'));
    expect(shards.length).toBe(1);
    const entries = await fs.readdir(path.join(root, 'blobs', shards[0]));
    const blobs = entries.filter((e) => e.endsWith('.txt'));
    expect(blobs.length).toBe(1);
  });

  it('stores blobs under two-level shards <sha[:2]>/<sha>.txt', async () => {
    const sha = await store.write('shard-test');
    const expected = path.join(root, 'blobs', sha.slice(0, 2), `${sha}.txt`);
    await expect(fs.stat(expected)).resolves.toBeDefined();
  });

  it('has() reports presence correctly', async () => {
    const sha = await store.write('present');
    expect(await store.has(sha)).toBe(true);
    expect(await store.has('0'.repeat(64))).toBe(false);
  });

  it('list() iterates every blob with size + mtime', async () => {
    const shas = await Promise.all([
      store.write('one'),
      store.write('two'),
      store.write('three'),
    ]);
    const seen: string[] = [];
    for await (const blob of store.list()) {
      seen.push(blob.sha);
      expect(blob.size).toBeGreaterThan(0);
      expect(blob.mtimeMs).toBeGreaterThan(0);
    }
    expect(seen.sort()).toEqual(shas.sort());
  });

  it('delete removes the blob; subsequent has() returns false', async () => {
    const sha = await store.write('to-delete');
    expect(await store.has(sha)).toBe(true);
    await store.delete(sha);
    expect(await store.has(sha)).toBe(false);
  });
});
