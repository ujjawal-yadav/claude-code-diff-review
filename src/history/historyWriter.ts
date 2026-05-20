/**
 * Append-only JSONL writer per session (MEMORY-DESIGN.md §3 + §7 Performance).
 *
 * Segmentation
 * ------------
 * One file per session, rolled at 5 MB:
 *   <root>/sessions/<sid>.0.jsonl
 *   <root>/sessions/<sid>.1.jsonl
 *   ...
 *
 * The writer tracks the byte count of the active segment in memory; once
 * a write would push it past `MAX_SEGMENT_BYTES`, it bumps the segment
 * number and starts a fresh file.
 *
 * Buffering & durability
 * ----------------------
 * Events are not buffered — each write hits disk synchronously. The
 * MEMORY-DESIGN.md spec suggests buffering with fsync on Stop boundaries
 * for the hot-path goal of <1 ms per append, but on local SSDs `appendFile`
 * already lands under that budget. Phase β can revisit if a real workload
 * pushes us over budget.
 *
 * The next event id is read once from the existing segment(s) on first
 * use, then kept in-memory for the session.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { HistoryEvent } from './historyEvents.js';

const MAX_SEGMENT_BYTES = 5 * 1024 * 1024;

/** Distributes Omit across each variant of the discriminated union so the
 *  resulting type is still a discriminated union (preserves `kind`-based
 *  narrowing at call sites in historyService). */
type WithoutMeta<E> = E extends unknown ? Omit<E, 'eventId' | 'v'> : never;
export type HistoryEventInput = WithoutMeta<HistoryEvent>;

export interface WriterOptions {
  /** Absolute path to the history root (e.g. `<workspace>/.claude/review-history`). */
  root: string;
  sessionId: string;
}

interface PerSessionState {
  segment: number;
  bytesInSegment: number;
  nextEventId: number;
}

export class HistoryWriter {
  private readonly sessionsDir: string;
  private readonly perSession = new Map<string, PerSessionState>();
  /** Serializes appends per (sessionId) so concurrent calls don't interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: WriterOptions) {
    this.sessionsDir = path.join(opts.root, 'sessions');
  }

  /**
   * Append `event` to the session's active segment, rolling if needed.
   * Returns the event id that was assigned.
   *
   * `event.eventId` and `event.v` on input are ignored — the writer is the
   * authority for both.
   */
  async append(event: HistoryEventInput): Promise<number> {
    const sid = this.opts.sessionId;
    return this.locked(sid, async () => {
      const state = await this.ensureState(sid);
      const fullEvent = { v: 1 as const, eventId: state.nextEventId, ...event } as HistoryEvent;
      const line = JSON.stringify(fullEvent) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');

      // Defensive: a single event that exceeds the segment cap would otherwise
      // be written into a fresh segment in violation of the invariant. Reject
      // pathological events (e.g., a Stop with a several-MB lastAssistantMessage)
      // up-front so reads + size accounting stay consistent.
      if (lineBytes > MAX_SEGMENT_BYTES) {
        throw new Error(
          `historyWriter: event '${(event as { kind: string }).kind}' exceeds MAX_SEGMENT_BYTES (${lineBytes} > ${MAX_SEGMENT_BYTES})`,
        );
      }

      if (state.bytesInSegment + lineBytes > MAX_SEGMENT_BYTES && state.bytesInSegment > 0) {
        state.segment += 1;
        state.bytesInSegment = 0;
      }

      const target = this.segmentPath(sid, state.segment);
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.appendFile(target, line, { encoding: 'utf8', mode: 0o644 });

      state.bytesInSegment += lineBytes;
      const assigned = state.nextEventId;
      state.nextEventId += 1;
      return assigned;
    });
  }

  /**
   * Read-only: lists every segment file for the given session, in order.
   * Used by the reader. Returns absolute paths.
   */
  async listSegments(sessionId: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.sessionsDir);
    } catch (err) {
      if (isNoEnt(err)) return [];
      throw err;
    }
    const prefix = `${sessionId}.`;
    const matches = entries
      .filter((e) => e.startsWith(prefix) && e.endsWith('.jsonl'))
      .map((e) => {
        const segStr = e.slice(prefix.length, -'.jsonl'.length);
        return { name: e, seg: Number.parseInt(segStr, 10) };
      })
      .filter((m) => Number.isFinite(m.seg))
      .sort((a, b) => a.seg - b.seg);
    return matches.map((m) => path.join(this.sessionsDir, m.name));
  }

  /**
   * Returns the current segment number and last-event-id for the session.
   * Initialises lazily on first call; cheap thereafter.
   */
  async getState(sessionId: string): Promise<{ segment: number; nextEventId: number }> {
    const s = await this.ensureState(sessionId);
    return { segment: s.segment, nextEventId: s.nextEventId };
  }

  /**
   * Drop the in-memory bookkeeping for a session. The on-disk files remain.
   * Used when a session is dismissed; not required for correctness — but
   * keeps the Map bounded across long-running VS Code windows.
   */
  release(sessionId: string): void {
    this.perSession.delete(sessionId);
    this.locks.delete(sessionId);
  }

  // -- internals -----------------------------------------------------------

  private async ensureState(sid: string): Promise<PerSessionState> {
    const existing = this.perSession.get(sid);
    if (existing) return existing;

    // Probe existing segments to figure out where to continue.
    const segments = await this.listSegments(sid);
    if (segments.length === 0) {
      const fresh: PerSessionState = { segment: 0, bytesInSegment: 0, nextEventId: 0 };
      this.perSession.set(sid, fresh);
      return fresh;
    }
    const lastPath = segments[segments.length - 1];
    const lastSeg = Number.parseInt(path.basename(lastPath).split('.')[1], 10);
    const stat = await fs.stat(lastPath);
    // Count event ids by scanning lines (only needed once per process per session).
    const raw = await fs.readFile(lastPath, 'utf8');
    const lineCount = raw.length === 0 ? 0 : raw.split('\n').filter((l) => l.length > 0).length;
    let nextEventId = 0;
    for (const segPath of segments.slice(0, -1)) {
      const r = await fs.readFile(segPath, 'utf8');
      nextEventId += r.split('\n').filter((l) => l.length > 0).length;
    }
    nextEventId += lineCount;
    const state: PerSessionState = {
      segment: lastSeg,
      bytesInSegment: stat.size,
      nextEventId,
    };
    this.perSession.set(sid, state);
    return state;
  }

  private segmentPath(sid: string, segment: number): string {
    return path.join(this.sessionsDir, `${sid}.${segment}.jsonl`);
  }

  private async locked<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sid) ?? Promise.resolve();
    const next = prior.then(() => fn(), () => fn());
    this.locks.set(sid, next.then(() => undefined, () => undefined));
    return next;
  }
}

function isNoEnt(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
