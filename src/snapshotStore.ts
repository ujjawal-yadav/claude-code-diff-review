import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SessionId, AbsPath, SessionData } from './types.js';
import { asAbsPath } from './types.js';

/**
 * Per-session before-snapshots and touched-file tracking (TRD §5.4).
 *
 * Concurrency model
 * -----------------
 * Snapshots are captured during `PreToolUse` hooks, which can fire in
 * parallel for multiple files (sub-agent edits). Two concurrency hazards:
 *
 *   1. Same (session, path) captured twice → both might `fs.readFile`.
 *      Resolved with a per-(session,path) async mutex that ensures the
 *      *first* write wins (TRD FR-3.3).
 *
 *   2. Different paths in the same session captured in parallel → must
 *      run concurrently for throughput.
 *
 * Budget enforcement
 * ------------------
 * `MAX_SESSION_BYTES` and `MAX_FILES_PER_SESSION` are tracked as running
 * counters; once exceeded, the session is flagged `overBudget` and further
 * snapshot reads are skipped (touched tracking continues so the user still
 * sees the file in the review UI with a "snapshot truncated" warning).
 *
 * Path resolution
 * ---------------
 * `cwd + tool_input.file_path` is resolved through `path.resolve` and then
 * `path.relative` to verify the result stays within `cwd` (path-traversal
 * guard, TRD §14.2).
 */

export interface SnapshotStoreOptions {
  maxSessionBytes:    number;
  maxFilesPerSession: number;
  /** Per-file read cap (bytes). Defaults to 25 MB. */
  maxFileBytes?:      number;
}

export class SnapshotStore {
  private readonly sessions = new Map<SessionId, SessionData>();
  /** Promise-chain mutex per (sid::path). */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly opts: Required<SnapshotStoreOptions>;

  constructor(opts: SnapshotStoreOptions) {
    this.opts = { maxFileBytes: 25 * 1024 * 1024, ...opts };
  }

  /**
   * Capture the original (pre-edit) content of a file. Idempotent per
   * (sessionId, absPath): subsequent calls are no-ops once a value exists.
   *
   * Returns the resolved AbsPath, or null if the path failed validation.
   */
  async captureOriginal(
    sessionId: string,
    cwd: string,
    rawPath: string,
  ): Promise<AbsPath | null> {
    const resolved = resolveSafe(cwd, rawPath);
    if (resolved == null) return null;

    const session = this.getOrCreateSession(sessionId as SessionId, cwd);
    const lockKey = `${session.sessionId}::${resolved}`;

    const prior = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((res) => { release = res; });
    this.locks.set(lockKey, prior.then(() => lock));

    try {
      await prior;

      if (session.originals.has(resolved)) {
        return resolved; // first-wins
      }

      if (session.overBudget) {
        return resolved; // flag the file as touched, but don't snapshot
      }

      if (session.originals.size >= this.opts.maxFilesPerSession) {
        session.overBudget = true;
        return resolved;
      }

      let content: string;
      try {
        const stat = await fs.stat(resolved);
        if (stat.size > this.opts.maxFileBytes) {
          session.overBudget = true;
          return resolved;
        }
        content = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // New file — record an empty 'before'.
          content = '';
        } else {
          throw err;
        }
      }

      const projectedBytes = totalBytesOf(session) + Buffer.byteLength(content, 'utf8');
      if (projectedBytes > this.opts.maxSessionBytes) {
        session.overBudget = true;
        return resolved;
      }

      session.originals.set(resolved, content);
      session.lastEventAt = Date.now();
      return resolved;
    } finally {
      this.locks.delete(lockKey);
      release();
    }
  }

  /**
   * Mark a file as touched in this session. No I/O.
   */
  recordTouched(sessionId: string, cwd: string, rawPath: string): AbsPath | null {
    const resolved = resolveSafe(cwd, rawPath);
    if (resolved == null) return null;
    const session = this.getOrCreateSession(sessionId as SessionId, cwd);
    session.touched.add(resolved);
    session.lastEventAt = Date.now();
    return resolved;
  }

  get(sessionId: string): SessionData | undefined {
    return this.sessions.get(sessionId as SessionId);
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId as SessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  totalBytes(): number {
    let sum = 0;
    for (const s of this.sessions.values()) sum += totalBytesOf(s);
    return sum;
  }

  /**
   * Returns the current turn id, minting a new one if none is active
   * (Phase α — PHASE-ALPHA-IMMEDIATE.md §3.4). Called from `PreToolUse`
   * hook so every edit lands inside a turn. Idempotent within a turn.
   *
   * `freshlyMinted` lets the caller emit a `turn-started` event into the
   * Memory Design log on first edit of a new turn without having to track
   * turn boundaries themselves.
   *
   * Concurrency: writes to a single session are safe because (a) we read
   * before writing in the same microtask, and (b) the first writer wins
   * via a `setIfAbsent` pattern. Concurrent PreToolUse calls for the same
   * session race only on which UUID gets minted; once set, the read path
   * returns the live value.
   */
  beginTurnIfNeeded(sessionId: string, cwd: string): { turnId: string; freshlyMinted: boolean } {
    const session = this.getOrCreateSession(sessionId as SessionId, cwd);
    if (session.currentTurnId == null) {
      session.currentTurnId = crypto.randomUUID();
      session.turnStartedAt = Date.now();
      return { turnId: session.currentTurnId, freshlyMinted: true };
    }
    return { turnId: session.currentTurnId, freshlyMinted: false };
  }

  /**
   * Mark the active turn ended (Phase α — Memory Design boundary). Called
   * from the Stop handler. Idempotent: subsequent `Stop`s without an
   * intervening PreToolUse are no-ops.
   */
  endTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId as SessionId);
    if (!session) return;
    // Phase β.0 (FR-B0.7): retain the closed turn id so any post-Stop history
    // emission (e.g., per-hunk Undo fired after the review panel opens) can
    // still attach to a valid turn. Idempotent: a Stop without an intervening
    // turn is a no-op (currentTurnId is already null, lastTurnId preserved).
    if (session.currentTurnId != null) {
      session.lastTurnId = session.currentTurnId;
    }
    session.currentTurnId = null;
    session.turnStartedAt = null;
  }

  /**
   * Phase β.0 (10.1.4): seed a session's snapshot state from reconstructed
   * history. Used by `ReviewOrchestrator.adoptReconstructed` to make a
   * resumed session indistinguishable from one that was observed live.
   *
   * Critical ordering: must run BEFORE any new PreToolUse for the session
   * lands. Otherwise `captureOriginal` reads already-mutated disk content
   * and the re-diff is silently wrong.
   */
  injectSession(input: {
    sessionId: string;
    cwd: string;
    originals: ReadonlyMap<AbsPath, string>;
    currentTurnId: string | null;
    lastTurnId: string | null;
    turnStartedAt: number | null;
    touched?: ReadonlySet<AbsPath>;
    startedAt?: number;
  }): void {
    const sid = input.sessionId as SessionId;
    const now = Date.now();
    const session: SessionData = {
      sessionId: sid,
      cwd: input.cwd,
      startedAt: input.startedAt ?? now,
      originals: new Map(input.originals),
      touched: new Set(input.touched ?? input.originals.keys()),
      lastEventAt: now,
      overBudget: false,
      currentTurnId: input.currentTurnId,
      turnStartedAt: input.turnStartedAt,
      lastTurnId: input.lastTurnId,
    };
    this.sessions.set(sid, session);
  }

  private getOrCreateSession(sessionId: SessionId, cwd: string): SessionData {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const fresh: SessionData = {
      sessionId,
      cwd,
      startedAt: Date.now(),
      originals: new Map(),
      touched: new Set(),
      lastEventAt: Date.now(),
      overBudget: false,
      currentTurnId: null,
      turnStartedAt: null,
      lastTurnId: null,
    };
    this.sessions.set(sessionId, fresh);
    return fresh;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Resolves a path under cwd; refuses traversal escapes. */
export function resolveSafe(cwd: string, rawPath: string): AbsPath | null {
  const absRaw = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  const resolved = path.resolve(absRaw);
  const relativeToCwd = path.relative(path.resolve(cwd), resolved);
  if (relativeToCwd.startsWith('..') || path.isAbsolute(relativeToCwd)) {
    return null;
  }
  return asAbsPath(normaliseDriveCase(resolved));
}

function normaliseDriveCase(p: string): string {
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

function totalBytesOf(session: SessionData): number {
  let sum = 0;
  for (const v of session.originals.values()) sum += Buffer.byteLength(v, 'utf8');
  return sum;
}

/** Exported for tests. */
export const __test = { resolveSafe, normaliseDriveCase };
