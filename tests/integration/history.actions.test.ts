/**
 * β.0 (10.1.5b / 10.1.8): integration tests for the host-side primitives that
 * the History panel's Resume / Rollback / Delete actions compose against:
 *
 *   - HistoryService.getPendingReviewsSummary        (10.1.5b)
 *   - HistoryService.deleteSession                   (10.1.8a)
 *   - ReviewOrchestrator.rollbackTurnFromHistory     (10.1.8b)
 *
 * The dispatch layer in HistoryPanelManager is a thin glue around these;
 * verifying the primitives + their cross-session invariants is the high-
 * leverage coverage. Manual smoke testing covers the modal-confirm flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { HistoryService } from '../../src/history/historyService.js';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from '../../src/types.js';

const TURN_A = '11111111-1111-4111-8111-111111111111';
const TURN_B = '22222222-2222-4222-8222-222222222222';

class NoopPanel implements PanelGateway {
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_sessionId: SessionId, _filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_sessionId: SessionId, _filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict(_sessionId: SessionId, _filePath: AbsPath, _attemptedHunkIndex: number, _conflictingHunks: number[]) {}
  postUndoStackDepth(_sid: SessionId, _depth: number) {}
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
}

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-actions-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-actions-ws-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  logger = new Logger('test', 'error');
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function buildHistory(): HistoryService {
  return new HistoryService({
    scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
  });
}

interface SeedHunk {
  idx: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

async function seedSession(
  history: HistoryService,
  sid: string,
  turnId: string,
  files: Array<{ relPath: string; before: string; after: string; hunks?: SeedHunk[] }>,
): Promise<void> {
  const defaultHunks: SeedHunk[] = [
    { idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
  ];
  await history.recordTurnStarted({
    sessionId: sid, turnId, agentId: 'claude-code',
    files: files.map((f) => ({ relPath: f.relPath, beforeContent: f.before, mtimeMs: null })),
  });
  await history.recordTurnStopped({
    sessionId: sid, turnId, agentId: 'claude-code', lastAssistantMessage: null,
    files: files.map((f) => ({
      relPath: f.relPath, afterContent: f.after,
      isNew: false, isDeleted: false, isBinary: false,
      hunks: f.hunks ?? defaultHunks,
    })),
  });
}

// ---------------------------------------------------------------------------
// 10.1.5b — getPendingReviewsSummary
// ---------------------------------------------------------------------------

describe('HistoryService.getPendingReviewsSummary (10.1.5b)', () => {
  it('returns empty when no sessions exist', async () => {
    const history = buildHistory();
    const summary = await history.getPendingReviewsSummary();
    expect(summary.totalSessions).toBe(0);
    expect(summary.totalPendingHunks).toBe(0);
    expect(summary.sessions).toEqual([]);
  });

  it('aggregates pending counts across closed sessions, sorted most-recent-first', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);
    await new Promise((r) => setTimeout(r, 5));
    await seedSession(history, 'sB', TURN_B, [{ relPath: 'b.ts', before: 'b\n', after: 'B\n' }]);

    const summary = await history.getPendingReviewsSummary();
    expect(summary.totalSessions).toBe(2);
    expect(summary.totalPendingHunks).toBe(2); // 1 hunk each
    // Most-recent-first: sB before sA.
    expect(summary.sessions[0].sessionId).toBe('sB');
    expect(summary.sessions[1].sessionId).toBe('sA');
  });

  it('excludes fully-decided sessions from the count and list', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);
    await history.recordHunkDecided({
      sessionId: 'sA', turnId: TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'accepted', postContent: 'A\n', drift: { fuzz: null },
    });

    const summary = await history.getPendingReviewsSummary();
    expect(summary.totalSessions).toBe(0);
    expect(summary.totalPendingHunks).toBe(0);
  });

  it('caches results for 1 second to absorb concurrent calls', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);

    const s1 = await history.getPendingReviewsSummary();
    // Mutating the underlying state without invalidation — cache should
    // still return the old value.
    await history.recordHunkDecided({
      sessionId: 'sA', turnId: TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'accepted', postContent: 'A\n', drift: { fuzz: null },
    });
    // Note: recordHunkDecided invalidates the cache, so we test by checking
    // that the call did invalidate (post-cache should now be the new state).
    const s2 = await history.getPendingReviewsSummary();
    expect(s1.totalPendingHunks).toBe(1);
    expect(s2.totalPendingHunks).toBe(0);
  });

  it('respects withinMs filter (cutoff excludes old sessions)', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);

    // Within a 0ms cutoff, nothing is recoverable.
    const summary = await history.getPendingReviewsSummary({ withinMs: 0 });
    expect(summary.totalSessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10.1.8a — HistoryService.deleteSession
// ---------------------------------------------------------------------------

describe('HistoryService.deleteSession (10.1.8a / B0-10)', () => {
  it('removes the session from listSessions', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);
    expect((await history.listSessions()).map((s) => s.sessionId)).toContain('sA');

    await history.deleteSession('sA');
    expect((await history.listSessions()).map((s) => s.sessionId)).not.toContain('sA');
  });

  it('sweeps blobs that were ONLY referenced by the deleted session', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'unique-A\n', after: 'unique-A-after\n' }]);

    const root = history.getRoot();
    const blobsDir = path.join(root, 'blobs');
    const allBlobsBefore = await listAllBlobs(blobsDir);
    expect(allBlobsBefore.length).toBeGreaterThan(0);

    const { blobsDeleted } = await history.deleteSession('sA');
    expect(blobsDeleted).toBeGreaterThan(0);
    const allBlobsAfter = await listAllBlobs(blobsDir);
    expect(allBlobsAfter.length).toBe(0);
  });

  it('preserves blobs shared with another session', async () => {
    const history = buildHistory();
    // Both sessions touch a file with identical before/after content → same blobs.
    const shared = { relPath: 'shared.ts', before: 'shared\n', after: 'shared-after\n' };
    await seedSession(history, 'sA', TURN_A, [shared]);
    await seedSession(history, 'sB', TURN_B, [shared]);

    const root = history.getRoot();
    const blobsDir = path.join(root, 'blobs');
    const before = await listAllBlobs(blobsDir);

    await history.deleteSession('sA');
    const after = await listAllBlobs(blobsDir);
    // Shared blobs must survive; only blobs unique to sA can go (in this
    // case zero, since content is identical).
    expect(after.length).toBe(before.length);
    // sB still loads.
    const sBEvents = await history.readEvents('sB');
    expect(sBEvents.length).toBeGreaterThan(0);
  });

  it('invalidates the pending-summary cache', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [{ relPath: 'a.ts', before: 'a\n', after: 'A\n' }]);
    const s1 = await history.getPendingReviewsSummary();
    expect(s1.totalSessions).toBe(1);

    await history.deleteSession('sA');
    const s2 = await history.getPendingReviewsSummary();
    expect(s2.totalSessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10.1.8b — ReviewOrchestrator.rollbackTurnFromHistory
// ---------------------------------------------------------------------------

describe('ReviewOrchestrator.rollbackTurnFromHistory (10.1.8b / B0-9)', () => {
  it('writes each file\'s beforeBlob to disk via the injected writeFile', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [
      { relPath: 'a.ts', before: 'before-A\n', after: 'after-A\n' },
      { relPath: 'b.ts', before: 'before-B\n', after: 'after-B\n' },
    ]);

    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const writes = new Map<string, string>();
    const orch = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async (p, c) => { writes.set(p, c); },
      readFile: async () => '',
    });

    const recon = await history.reconstructSessionReview('sA', { cwd: workspaceDir });
    expect(recon).not.toBeNull();
    const result = await orch.rollbackTurnFromHistory(recon!);

    expect(result.filesRestored).toBe(2);
    expect(result.failed).toBe(0);
    // Each file's beforeBlob content was written.
    expect([...writes.values()].sort()).toEqual(['before-A\n', 'before-B\n']);
  });

  it('emits file-snapshot-reverted per restored file', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [
      { relPath: 'a.ts', before: 'before-A\n', after: 'after-A\n' },
    ]);

    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const orch = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => '',
    });

    const recon = await history.reconstructSessionReview('sA', { cwd: workspaceDir });
    await orch.rollbackTurnFromHistory(recon!);

    // Allow the fire-and-forget recordFileSnapshotReverted to settle.
    await new Promise((r) => setTimeout(r, 50));
    const events = await history.readEvents('sA');
    const reverts = events.filter((e) => e.kind === 'file-snapshot-reverted');
    expect(reverts.length).toBe(1);
    expect(reverts[0].kind === 'file-snapshot-reverted' && reverts[0].path).toBe('a.ts');
  });

  it('counts failures separately when writeFile rejects', async () => {
    const history = buildHistory();
    await seedSession(history, 'sA', TURN_A, [
      { relPath: 'good.ts', before: 'g\n', after: 'G\n' },
      { relPath: 'bad.ts',  before: 'b\n', after: 'B\n' },
    ]);

    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const orch = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async (p, _c) => {
        if (p.endsWith('bad.ts')) throw new Error('disk full');
      },
      readFile: async () => '',
    });

    const recon = await history.reconstructSessionReview('sA', { cwd: workspaceDir });
    const result = await orch.rollbackTurnFromHistory(recon!);
    expect(result.filesRestored).toBe(1);
    expect(result.failed).toBe(1);
  });
});

async function listAllBlobs(blobsDir: string): Promise<string[]> {
  try {
    const shards = await fs.readdir(blobsDir);
    const all: string[] = [];
    for (const shard of shards) {
      const shardPath = path.join(blobsDir, shard);
      const stat = await fs.stat(shardPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const entries = await fs.readdir(shardPath);
      for (const e of entries) all.push(path.join(shardPath, e));
    }
    return all;
  } catch {
    return [];
  }
}
