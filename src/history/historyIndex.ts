/**
 * Index maintenance for the history root (MEMORY-DESIGN.md §3 + §7).
 *
 * Lives at `<root>/index.json`. Updated on session boundaries (start /
 * stop) — the index is a hot-path-free aggregate; reads scan segments
 * directly via `historyReader.ts`. The index is a small map that lets
 * the History panel render the session list without reading every JSONL.
 *
 * Phase α scope
 * -------------
 * - `sessions[]` carries id + status + first/last-event timestamps + agent
 * - Phase β extends with `fileToSessions` map + prompt index for search
 *
 * Writes are atomic (tmp + rename).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type { SessionIndexEntry, HistoryIndex } from './historyTypes.js';
import type { HistoryIndex, SessionIndexEntry } from './historyTypes.js';

export interface IndexOptions {
  root: string;
}

export class HistoryIndexFile {
  private readonly indexPath: string;
  private cache: HistoryIndex | null = null;

  constructor(opts: IndexOptions) {
    this.indexPath = path.join(opts.root, 'index.json');
  }

  async read(): Promise<HistoryIndex> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as HistoryIndex;
      if (parsed && parsed.v === 1 && Array.isArray(parsed.sessions)) {
        this.cache = parsed;
        return parsed;
      }
    } catch (err) {
      if (!isNoEnt(err)) throw err;
    }
    this.cache = { v: 1, sessions: [] };
    return this.cache;
  }

  /**
   * Serialises concurrent `update` calls. Without this, two callers each
   * read the same in-memory snapshot, both mutate, and the second write
   * silently clobbers the first's mutations. Promise-chain pattern is
   * the same shape `historyWriter.ts:locked()` uses.
   */
  private writeLock: Promise<void> = Promise.resolve();

  /**
   * Apply a mutation to the index and persist atomically. Caller passes
   * a mutator that returns the new state (or mutates in place and returns
   * undefined). Throws if the write fails — caller decides whether to
   * surface or swallow.
   */
  async update(mutate: (idx: HistoryIndex) => HistoryIndex | void): Promise<void> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      const idx = await this.read();
      const next = mutate(idx) ?? idx;
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
      const tmp = `${this.indexPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
      await fs.rename(tmp, this.indexPath);
      this.cache = next;
    } finally {
      release();
    }
  }

  /** Helper: upsert by sessionId. */
  async upsertSession(entry: SessionIndexEntry): Promise<void> {
    await this.update((idx) => {
      const i = idx.sessions.findIndex((s) => s.sessionId === entry.sessionId);
      if (i === -1) idx.sessions.push(entry);
      else          idx.sessions[i] = entry;
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.update((idx) => {
      idx.sessions = idx.sessions.filter((s) => s.sessionId !== sessionId);
    });
  }
}

function isNoEnt(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
