/**
 * Content-addressed blob store (MEMORY-DESIGN.md §3 + Phase α §3.5 T1-A3).
 *
 * Storage layout
 * --------------
 *   <root>/blobs/7a/7a3f9b…1c.txt
 *
 * Two-level shard keyed on the first 2 hex chars of the SHA-256. Keeps any
 * directory below ~250 entries per workspace at typical Phase β usage.
 *
 * The `.txt` suffix is intentional — users can `cat` blobs for forensics
 * without having to teach `file` about an opaque extension.
 *
 * Atomicity & idempotency
 * -----------------------
 * Writes go to `<final>.<rand>.tmp`, then `fs.rename` (atomic on every
 * supported platform when source and target share a volume). Repeated
 * writes of the same content are no-ops once `has(sha)` returns true.
 *
 * Concurrency
 * -----------
 * Two writers racing the same novel blob: both write to distinct tmp paths;
 * the second rename overwrites the first byte-for-byte (content is
 * SHA-identified, so it's the same payload). Safe.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface BlobStoreOptions {
  /** Absolute path to the history root (e.g. `<workspace>/.claude/review-history`). */
  root: string;
}

export class BlobStore {
  private readonly blobsDir: string;
  /**
   * v0.6.1: in-process set of SHAs we've already persisted this session, to
   * short-circuit the dedup without a filesystem probe. Bounded by the number
   * of distinct blobs written in a session (turn before/after content); each
   * entry is a 64-char hex string. Not a correctness store — purely a syscall
   * cache; cross-process duplicates are still handled by the rename race path.
   */
  private readonly knownShas = new Set<string>();

  constructor(opts: BlobStoreOptions) {
    this.blobsDir = path.join(opts.root, 'blobs');
  }

  /**
   * Write `content` and return its SHA-256 hex digest. Idempotent: returns
   * the existing path immediately if the blob is already on disk.
   *
   * Returns the hex digest the caller can use to reference the blob in
   * event records.
   */
  async write(content: string): Promise<string> {
    const sha = sha256Hex(content);
    // v0.6.1: in-process dedup. The previous `exists()` stat ran on EVERY
    // write but almost always missed (most turn blobs are novel content), so
    // it was a wasted syscall on the hot write path. We skip it: known SHAs
    // short-circuit here, and novel SHAs go straight to write+rename. The
    // rename-race handler below still covers the cross-process duplicate case.
    if (this.knownShas.has(sha)) return sha;
    const target = this.pathFor(sha);

    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      // Race: another writer (or process) landed the same blob. Blobs are
      // content-addressed so the existing file's content is identical; clean
      // up our tmp and treat as success. If the target genuinely isn't there,
      // surface the error — never silently lose a write.
      if (await this.exists(target)) {
        await fs.unlink(tmp).catch(() => undefined);
        this.knownShas.add(sha);
        return sha;
      }
      throw err;
    }
    this.knownShas.add(sha);
    return sha;
  }

  async read(sha: string): Promise<string> {
    return fs.readFile(this.pathFor(sha), 'utf8');
  }

  async has(sha: string): Promise<boolean> {
    return this.exists(this.pathFor(sha));
  }

  async delete(sha: string): Promise<void> {
    await fs.unlink(this.pathFor(sha)).catch((err) => {
      if (!isNoEnt(err)) throw err;
    });
  }

  /**
   * Iterate every blob SHA currently on disk. Used by the retention
   * sweeper. Yields shas as it walks the shard directories.
   */
  async *list(): AsyncGenerator<{ sha: string; size: number; mtimeMs: number }> {
    let shards: string[];
    try {
      shards = await fs.readdir(this.blobsDir);
    } catch (err) {
      if (isNoEnt(err)) return;
      throw err;
    }
    for (const shard of shards) {
      if (shard.length !== 2) continue;
      const dir = path.join(this.blobsDir, shard);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (err) {
        if (isNoEnt(err)) continue;
        throw err;
      }
      for (const entry of entries) {
        // Skip tmp files (someone may be mid-write).
        if (entry.endsWith('.tmp')) continue;
        if (!entry.endsWith('.txt')) continue;
        const sha = entry.slice(0, -4); // strip .txt
        if (sha.length !== 64) continue;
        const full = path.join(dir, entry);
        let stat: { size: number; mtimeMs: number };
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        yield { sha, size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  }

  pathFor(sha: string): string {
    const shard = sha.slice(0, 2);
    return path.join(this.blobsDir, shard, `${sha}.txt`);
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch (err) {
      if (isNoEnt(err)) return false;
      throw err;
    }
  }
}

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function isNoEnt(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
