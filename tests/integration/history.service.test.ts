/**
 * T1-A7: HistoryService.sweep removes expired sessions and their
 * unreferenced blobs while preserving live sessions' blobs.
 *
 * Also covers the resolveHistoryRoot path scheme (Q6) and the
 * end-to-end record* → readEvents round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryService, resolveHistoryRoot } from '../../src/history/historyService.js';
import { Logger } from '../../src/logger.js';

const FAKE_TURN_A = '11111111-1111-4111-8111-111111111111';
const FAKE_TURN_B = '22222222-2222-4222-8222-222222222222';

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-svc-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-svc-ws-'));
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

describe('resolveHistoryRoot — Q6 path scheme', () => {
  it('user scope returns ~/.claude/review-history/<workspace-hash>/', () => {
    const root = resolveHistoryRoot('user', workspaceDir);
    expect(root.startsWith(path.join(homeDir, '.claude', 'review-history'))).toBe(true);
    const parts = root.split(path.sep);
    const hash = parts[parts.length - 1];
    expect(hash.length).toBe(16);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  it('user scope is deterministic for the same workspace', () => {
    expect(resolveHistoryRoot('user', workspaceDir)).toBe(resolveHistoryRoot('user', workspaceDir));
  });

  it('user scope is workspace-scoped (different workspaces → different roots)', () => {
    expect(resolveHistoryRoot('user', workspaceDir)).not.toBe(resolveHistoryRoot('user', workspaceDir + '_other'));
  });

  it('workspace scope returns <workspaceRoot>/.claude/review-history', () => {
    expect(resolveHistoryRoot('workspace', workspaceDir)).toBe(path.join(workspaceDir, '.claude', 'review-history'));
  });
});

describe('HistoryService — end-to-end record + read', () => {
  it('round-trips turn-started → hunk-decided → turn-stopped', async () => {
    const svc = new HistoryService({ scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true });
    const sid = 'roundtrip';
    await svc.recordTurnStarted({
      sessionId: sid, turnId: FAKE_TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'before', mtimeMs: null }],
    });
    await svc.recordHunkDecided({
      sessionId: sid, turnId: FAKE_TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0,
      decision: 'accepted', postContent: 'after',
      drift: { fuzz: null },
    });
    await svc.recordTurnStopped({
      sessionId: sid, turnId: FAKE_TURN_A, agentId: 'claude-code',
      lastAssistantMessage: 'all done',
      files: [{
        relPath: 'a.ts', afterContent: 'after',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      }],
    });

    const events = await svc.readEvents(sid);
    expect(events.length).toBe(3);
    expect(events.map((e) => e.kind)).toEqual(['turn-started', 'hunk-decided', 'turn-stopped']);
  });

  it('listSessions returns the indexed sessions', async () => {
    const svc = new HistoryService({ scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true });
    await svc.recordTurnStarted({
      sessionId: 'sid-1', turnId: FAKE_TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: null, mtimeMs: null }],
    });
    await svc.recordTurnStarted({
      sessionId: 'sid-2', turnId: FAKE_TURN_B, agentId: 'opencode',
      files: [{ relPath: 'b.ts', beforeContent: 'b', mtimeMs: null }],
    });
    const sessions = await svc.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions.find((s) => s.sessionId === 'sid-1')?.agentId).toBe('claude-code');
    expect(sessions.find((s) => s.sessionId === 'sid-2')?.agentId).toBe('opencode');
  });

  it('respects enabled=false (writes become no-ops)', async () => {
    const svc = new HistoryService({ scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: false });
    await svc.recordTurnStarted({
      sessionId: 'sid', turnId: FAKE_TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    expect(await svc.listSessions()).toEqual([]);
  });
});

describe('HistoryService.sweep — T1-A7 retention', () => {
  it('removes expired sessions and blobs they exclusively referenced', async () => {
    const svc = new HistoryService({ scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true });

    // Old session (we'll fast-forward its index entry mtime).
    await svc.recordTurnStarted({
      sessionId: 'old', turnId: FAKE_TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'old.ts', beforeContent: 'old-content', mtimeMs: null }],
    });

    // Recent session — different content so its blob is distinct.
    await svc.recordTurnStarted({
      sessionId: 'recent', turnId: FAKE_TURN_B, agentId: 'claude-code',
      files: [{ relPath: 'recent.ts', beforeContent: 'recent-content', mtimeMs: null }],
    });

    // Backdate the old session's index entry so retention selects it.
    const idxPath = path.join(svc.getRoot(), 'index.json');
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf8')) as {
      sessions: Array<{ sessionId: string; lastEventAt: number }>;
    };
    const ancient = Date.now() - 100 * 24 * 60 * 60 * 1000;
    for (const s of idx.sessions) if (s.sessionId === 'old') s.lastEventAt = ancient;
    await fs.writeFile(idxPath, JSON.stringify(idx, null, 2) + '\n');

    // Construct a fresh service so the IndexFile in-memory cache reflects the
    // edited file. (The original instance still holds a stale cache.)
    const sweeperSvc = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const result = await sweeperSvc.sweep(30);
    expect(result.sessions).toBe(1);
    expect(result.blobs).toBeGreaterThanOrEqual(1);

    // The old session's segment should be gone; the recent one intact.
    const sessionsDir = path.join(svc.getRoot(), 'sessions');
    const remaining = await fs.readdir(sessionsDir);
    expect(remaining.some((f) => f.startsWith('old.'))).toBe(false);
    expect(remaining.some((f) => f.startsWith('recent.'))).toBe(true);
  });
});
