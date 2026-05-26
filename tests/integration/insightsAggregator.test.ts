/**
 * v0.6 (A9): integration tests for InsightsAggregator against a real
 * HistoryService seeded via record* methods (matches history.service.test.ts).
 * Exercises the I/O path: streaming events, resolving reason blobs, the
 * per-session memo, and the window filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryService } from '../../src/history/historyService.js';
import { InsightsAggregator, MAIN_SENTINEL } from '../../src/insights/insightsAggregator.js';
import { Logger } from '../../src/logger.js';

const TURN_A = '11111111-1111-4111-8111-111111111111';
const TURN_B = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;
let svc: HistoryService;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-ins-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-ins-ws-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  logger = new Logger('test', 'error');
  svc = new HistoryService({ scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true });
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

/** Seed S1 (a.ts: hunk0 accepted; hunk1 accepted→undo→rejected + reason) and
 *  S2 (b.ts: hunk0 accepted under a sub-agent). */
async function seed(): Promise<void> {
  await svc.recordTurnStarted({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    files: [{ relPath: 'a.ts', beforeContent: 'before', mtimeMs: null }],
  });
  await svc.recordHunkDecided({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    relPath: 'a.ts', hunkIdx: 0, decision: 'accepted', postContent: 'x', drift: { fuzz: null },
  });
  await svc.recordHunkDecided({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    relPath: 'a.ts', hunkIdx: 1, decision: 'accepted', postContent: 'y', drift: { fuzz: null },
  });
  await svc.recordUndo({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    scope: 'hunk', target: { srcTurnId: TURN_A, srcEventId: -1, path: 'a.ts', hunkIdx: 1 },
    postContents: {},
  });
  await svc.recordHunkDecided({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    relPath: 'a.ts', hunkIdx: 1, decision: 'rejected', postContent: 'z', drift: { fuzz: null },
  });
  await svc.recordRejectionReason({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code',
    relPath: 'a.ts', hunkIdx: 1, reason: 'logic is wrong',
  });
  await svc.recordTurnStopped({
    sessionId: 's1', turnId: TURN_A, agentId: 'claude-code', lastAssistantMessage: 'done',
    files: [{ relPath: 'a.ts', afterContent: 'x', isNew: false, isDeleted: false, isBinary: false, hunks: [] }],
  });

  await svc.recordTurnStarted({
    sessionId: 's2', turnId: TURN_B, agentId: 'claude-code',
    files: [{ relPath: 'b.ts', beforeContent: 'b', mtimeMs: null }],
  });
  await svc.recordHunkDecided({
    sessionId: 's2', turnId: TURN_B, agentId: 'claude-code', subagentId: 'refactor-auth',
    relPath: 'b.ts', hunkIdx: 0, decision: 'accepted', postContent: 'b2', drift: { fuzz: null },
  });
}

describe('InsightsAggregator.compute — end to end', () => {
  it('aggregates rates, undo, reasons, and subagents across sessions', async () => {
    await seed();
    const agg = new InsightsAggregator({ history: svc, logger });
    const report = await agg.compute();

    expect(report.sessionsScanned).toBe(2);

    const a = report.fileRates.find((f) => f.path === 'a.ts')!;
    expect(a.accepted).toBe(1); // hunk0
    expect(a.rejected).toBe(1); // hunk1 final = rejected (undo-aware)
    const b = report.fileRates.find((f) => f.path === 'b.ts')!;
    expect(b.accepted).toBe(1);
    expect(b.rejected).toBe(0);

    const subIds = report.subagentRates.map((s) => s.subagentId);
    expect(subIds).toContain('refactor-auth');
    expect(subIds).toContain(MAIN_SENTINEL);

    expect(report.trend.length).toBe(30);
    expect(report.reasons.total).toBe(1);
    expect(report.reasons.groups[0]?.reason).toContain('logic');
    expect(report.empty).toBe(false);
  });

  it('memoises closed sessions — a second compute does not re-stream them', async () => {
    await seed();
    const agg = new InsightsAggregator({ history: svc, logger });
    await agg.compute();
    const spy = vi.spyOn(svc, 'readSessionStream');
    await agg.compute();
    // No new writes between computes ⇒ identical memo keys ⇒ no rescans.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('excludes sessions outside the window', async () => {
    await seed();
    // Clock 40 days in the future with a 30-day window ⇒ every (now-ish)
    // session falls before the cutoff and is excluded.
    const agg = new InsightsAggregator({ history: svc, logger, now: () => Date.now() + 40 * DAY });
    const report = await agg.compute({ windowMs: 30 * DAY });
    expect(report.sessionsScanned).toBe(0);
    expect(report.empty).toBe(true);
  });
});
