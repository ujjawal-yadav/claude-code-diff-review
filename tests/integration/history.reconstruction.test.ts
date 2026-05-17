/**
 * Phase β.0 (10.1.3): HistoryService.reconstructSessionReview tests.
 *
 * Maps to PHASE-BETA-NEXT.md §6.0 acceptance IDs:
 *   B0-1: closed session reconstructs to the expected file/hunk state
 *   B0-2: respects undo events (does not replay the now-undone decision)
 *   B0-3: drift classification (clean / drifted / missing)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { HistoryService } from '../../src/history/historyService.js';
import { Logger } from '../../src/logger.js';

const FAKE_TURN = '33333333-3333-4333-8333-333333333333';

let workspaceDir: string;
let homeDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-recon-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-recon-ws-'));
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

describe('B0-1: closed session reconstruction', () => {
  it('replays turn-started → turn-stopped → hunk-decided and produces correct hunkSet state', async () => {
    const svc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const sid = 'closed-session';

    // Seed: before='before', after='after', one hunk.
    await svc.recordTurnStarted({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'before\n', mtimeMs: null }],
    });
    await svc.recordTurnStopped({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      lastAssistantMessage: 'done',
      files: [{
        relPath: 'a.ts', afterContent: 'after\n',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      }],
    });
    // User rejects hunk 0 → disk content reverts to 'before\n'.
    await svc.recordHunkDecided({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'rejected',
      postContent: 'before\n', drift: { fuzz: null },
    });

    // Reconstruct (provide disk reader so we can deterministically classify).
    const recon = await svc.reconstructSessionReview(sid, {
      cwd: workspaceDir,
      readDiskFile: async (_) => 'before\n', // disk matches reconstructed state
    });

    expect(recon).not.toBeNull();
    if (!recon) throw new Error('null');
    expect(recon.sessionId).toBe(sid);
    expect(recon.agentId).toBe('claude-code');
    expect(recon.turnId).toBe(FAKE_TURN);
    expect(recon.files.length).toBe(1);
    expect(recon.files[0].relPath).toBe('a.ts');
    expect(recon.files[0].before).toBe('before\n');
    expect(recon.files[0].after).toBe('before\n'); // last postBlob anchor
    expect(recon.files[0].hunks.length).toBe(1);
    expect(recon.files[0].hunks[0].status).toBe('rejected');

    // hunkSet: the rejected hunk is OUT of acceptedSet.
    expect(recon.hunkSets[0].acceptedSet).toEqual([]);
    expect(recon.driftPerFile['a.ts']).toBe('clean');
  });

  it('seeds acceptedSet = {all hunks} on turn-stopped when no decisions follow', async () => {
    const svc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const sid = 'all-pending';
    await svc.recordTurnStarted({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [{ relPath: 'x.ts', beforeContent: 'a\nb\nc\n', mtimeMs: null }],
    });
    await svc.recordTurnStopped({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      lastAssistantMessage: null,
      files: [{
        relPath: 'x.ts', afterContent: 'A\nb\nC\n',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [
          { idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
          { idx: 1, oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-c', '+C'] },
        ],
      }],
    });

    const recon = await svc.reconstructSessionReview(sid, {
      cwd: workspaceDir, readDiskFile: async () => 'A\nb\nC\n',
    });
    expect(recon!.hunkSets[0].acceptedSet).toEqual([0, 1]);
    expect(recon!.files[0].hunks.every((h) => h.status === 'pending')).toBe(true);
  });
});

describe('B0-2: undo events anchor the reconstructed state', () => {
  it('per-hunk undo flips the hunk back to pending and restores postBlob content', async () => {
    const svc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const sid = 'undo-anchored';

    await svc.recordTurnStarted({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'before\n', mtimeMs: null }],
    });
    await svc.recordTurnStopped({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      lastAssistantMessage: null,
      files: [{
        relPath: 'a.ts', afterContent: 'after\n',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      }],
    });
    // Reject then undo → reconstructed status should be pending.
    await svc.recordHunkDecided({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'rejected',
      postContent: 'before\n', drift: { fuzz: null },
    });
    await svc.recordUndo({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      scope: 'hunk',
      target: { srcTurnId: FAKE_TURN, srcEventId: -1, path: 'a.ts', hunkIdx: 0 },
      postContents: { 'a.ts': 'after\n' },
    });

    const recon = await svc.reconstructSessionReview(sid, {
      cwd: workspaceDir, readDiskFile: async () => 'after\n',
    });
    expect(recon!.files[0].after).toBe('after\n');
    expect(recon!.files[0].hunks[0].status).toBe('pending');
    expect(recon!.driftPerFile['a.ts']).toBe('clean');
  });
});

describe('B0-3: drift classification', () => {
  it('clean / drifted / missing classifications match disk vs reconstructed SHA-256', async () => {
    const svc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const sid = 'drift-mix';

    // Three files, all touched by one turn.
    await svc.recordTurnStarted({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [
        { relPath: 'clean.ts',   beforeContent: 'b\n', mtimeMs: null },
        { relPath: 'drifted.ts', beforeContent: 'b\n', mtimeMs: null },
        { relPath: 'gone.ts',    beforeContent: 'b\n', mtimeMs: null },
      ],
    });
    await svc.recordTurnStopped({
      sessionId: sid, turnId: FAKE_TURN, agentId: 'claude-code',
      lastAssistantMessage: null,
      files: [
        { relPath: 'clean.ts',   afterContent: 'a\n', isNew: false, isDeleted: false, isBinary: false, hunks: [] },
        { relPath: 'drifted.ts', afterContent: 'a\n', isNew: false, isDeleted: false, isBinary: false, hunks: [] },
        { relPath: 'gone.ts',    afterContent: 'a\n', isNew: false, isDeleted: false, isBinary: false, hunks: [] },
      ],
    });

    const recon = await svc.reconstructSessionReview(sid, {
      cwd: workspaceDir,
      readDiskFile: async (rel) => {
        if (rel === 'clean.ts')   return 'a\n';            // matches reconstructed
        if (rel === 'drifted.ts') return 'EXTERNAL-EDIT\n'; // diverges
        if (rel === 'gone.ts')    return null;             // missing on disk
        return null;
      },
    });
    expect(recon!.driftPerFile['clean.ts']).toBe('clean');
    expect(recon!.driftPerFile['drifted.ts']).toBe('drifted');
    expect(recon!.driftPerFile['gone.ts']).toBe('missing');
  });
});

describe('reconstructSessionReview — edge cases', () => {
  it('returns null for an empty / non-existent session', async () => {
    const svc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const recon = await svc.reconstructSessionReview('does-not-exist');
    expect(recon).toBeNull();
  });
});
