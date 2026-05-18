/**
 * Streaming JSONL reader with tolerant decode (MEMORY-DESIGN.md §7 +
 * Phase α §3.5 T1-A4).
 *
 * The reader streams a session's segments line-by-line so even very long
 * sessions don't blow heap. Unknown event kinds and malformed lines are
 * skipped with a debug log — the on-disk log is the source of truth and
 * we never want to refuse to load a session over a forward-compat issue.
 */

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';

import { decodeEvent, HistoryEvent, TurnStartedEvent, TurnStoppedEvent } from './historyEvents.js';

export interface ReaderOptions {
  /** Absolute path to the history root. */
  root: string;
}

export interface ResumeCandidate {
  sessionId: string;
  /** Most recent event's ts. */
  lastEventAt: number;
  /** Whether a `turn-stopped` event closes the most recent turn. */
  hasOpenTurn: boolean;
  /** Most recent turn-started for the open turn (null when closed). */
  openTurnStarted: TurnStartedEvent | null;
  /** Most recent turn-stopped (the closed-turn reference, if any). */
  lastTurnStopped: TurnStoppedEvent | null;
}

export class HistoryReader {
  private readonly sessionsDir: string;

  constructor(opts: ReaderOptions) {
    this.sessionsDir = path.join(opts.root, 'sessions');
  }

  /**
   * Stream every event for a session in order. Skips malformed/unknown
   * lines silently (caller can wrap with a logger).
   */
  async *readSession(sessionId: string): AsyncGenerator<HistoryEvent> {
    const segments = await this.segmentsFor(sessionId);
    for (const segPath of segments) {
      const stream = createReadStream(segPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          let raw: unknown;
          try { raw = JSON.parse(line); }
          catch { continue; }
          const decoded = decodeEvent(raw);
          if (decoded) yield decoded;
        }
      } finally {
        rl.close();
        stream.close();
      }
    }
  }

  /** Convenience: collect every event into an array. Use only for small logs. */
  async readAll(sessionId: string): Promise<HistoryEvent[]> {
    const out: HistoryEvent[] = [];
    for await (const ev of this.readSession(sessionId)) out.push(ev);
    return out;
  }

  /** List session ids present on disk. */
  async listSessions(): Promise<string[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.sessionsDir); }
    catch (err) {
      if (isNoEnt(err)) return [];
      throw err;
    }
    const ids = new Set<string>();
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const m = /^(.+)\.\d+\.jsonl$/.exec(e);
      if (m) ids.add(m[1]);
    }
    return Array.from(ids);
  }

  /**
   * Scan every session and return candidates whose most recent turn is
   * still open (turn-started without matching turn-stopped). Used at
   * activation for crash-recovery prompts.
   */
  async findResumeCandidates(opts: { withinMs: number; nowMs?: number }): Promise<ResumeCandidate[]> {
    const now = opts.nowMs ?? Date.now();
    const sessions = await this.listSessions();
    const out: ResumeCandidate[] = [];
    for (const sid of sessions) {
      const events = await this.readAll(sid);
      if (events.length === 0) continue;
      const last = events[events.length - 1];
      if (now - last.ts > opts.withinMs) continue;

      // Walk in reverse to find the most recent turn-started and whether
      // it was closed by a turn-stopped of the same turnId.
      let openTurnStarted: TurnStartedEvent | null = null;
      let lastTurnStopped: TurnStoppedEvent | null = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!openTurnStarted && ev.kind === 'turn-started') {
          // Was there a turn-stopped for THIS turnId later?
          const stopped = events.slice(i + 1).find(
            (e) => e.kind === 'turn-stopped' && e.turnId === ev.turnId,
          );
          if (!stopped) openTurnStarted = ev;
          if (!lastTurnStopped && stopped) lastTurnStopped = stopped as TurnStoppedEvent;
          break;
        }
        if (!lastTurnStopped && ev.kind === 'turn-stopped') {
          lastTurnStopped = ev;
        }
      }
      out.push({
        sessionId: sid,
        lastEventAt: last.ts,
        hasOpenTurn: openTurnStarted != null,
        openTurnStarted,
        lastTurnStopped,
      });
    }
    return out;
  }

  // -- internals -----------------------------------------------------------

  private async segmentsFor(sessionId: string): Promise<string[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.sessionsDir); }
    catch (err) {
      if (isNoEnt(err)) return [];
      throw err;
    }
    const prefix = `${sessionId}.`;
    return entries
      .filter((e) => e.startsWith(prefix) && e.endsWith('.jsonl'))
      .map((e) => ({ name: e, seg: Number.parseInt(e.slice(prefix.length, -'.jsonl'.length), 10) }))
      .filter((m) => Number.isFinite(m.seg))
      .sort((a, b) => a.seg - b.seg)
      .map((m) => path.join(this.sessionsDir, m.name));
  }
}

function isNoEnt(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
