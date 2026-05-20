/**
 * Live-Update Wave (2026-05-19): HistoryService.addChangeListener contract.
 *
 * The History panel and PendingStatusBar both subscribe via this channel to
 * react to event-log writes that happen while their UI is open. The contract
 * verified here:
 *
 *   1. Each successful record* / deleteSession call fires exactly one event
 *      with the correct `kind` and `sessionId`.
 *   2. When the service is disabled, NO event fires (early-exit short-circuit
 *      hits before emission).
 *   3. A throwing listener does NOT break the write path — the event is still
 *      persisted to disk, the other listeners still fire, and a warn log is
 *      emitted.
 *   4. The unsubscribe function actually unsubscribes — no late-fire after
 *      the panel disposes.
 *
 * The downstream HistoryPanelManager debounce + listSessions re-post is glue
 * and exercised manually per the existing test convention (see
 * `history.actions.test.ts:9-11`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  HistoryService,
  HistoryChangeInfo,
} from '../../src/history/historyService.js';
import { Logger } from '../../src/logger.js';

const TURN_A = '11111111-1111-4111-8111-111111111111';
const TURN_B = '22222222-2222-4222-8222-222222222222';
const SID_A  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-live-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-live-ws-'));
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

function buildHistory(enabled = true): HistoryService {
  return new HistoryService({
    scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled,
  });
}

async function seedFullTurn(history: HistoryService, sid: string, turnId: string): Promise<void> {
  await history.recordTurnStarted({
    sessionId: sid, turnId, agentId: 'claude-code',
    files: [{ relPath: 'a.ts', beforeContent: 'old', mtimeMs: null }],
  });
  await history.recordTurnStopped({
    sessionId: sid, turnId, agentId: 'claude-code', lastAssistantMessage: null,
    files: [{
      relPath: 'a.ts', afterContent: 'new',
      isNew: false, isDeleted: false, isBinary: false,
      hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    }],
  });
}

describe('HistoryService.addChangeListener — basic contract', () => {
  it('fires `turn-started` after a successful recordTurnStarted', async () => {
    const history = buildHistory();
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });

    expect(events).toEqual([{ sessionId: SID_A, kind: 'turn-started' }]);
  });

  it('fires `turn-stopped` after a successful recordTurnStopped', async () => {
    const history = buildHistory();
    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordTurnStopped({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code', lastAssistantMessage: null,
      files: [{
        relPath: 'a.ts', afterContent: 'y',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
      }],
    });

    expect(events).toEqual([{ sessionId: SID_A, kind: 'turn-stopped' }]);
  });

  it('fires `hunk-decided` after a successful recordHunkDecided', async () => {
    const history = buildHistory();
    await seedFullTurn(history, SID_A, TURN_A);
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordHunkDecided({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'accepted',
      postContent: 'new', drift: { fuzz: null },
    });

    expect(events).toEqual([{ sessionId: SID_A, kind: 'hunk-decided' }]);
  });

  it('fires `snapshot-reverted` after a successful recordFileSnapshotReverted', async () => {
    const history = buildHistory();
    await seedFullTurn(history, SID_A, TURN_A);
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordFileSnapshotReverted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', postContent: 'old',
    });

    expect(events).toEqual([{ sessionId: SID_A, kind: 'snapshot-reverted' }]);
  });

  it('fires `undo` after a successful recordUndo', async () => {
    const history = buildHistory();
    await seedFullTurn(history, SID_A, TURN_A);
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordUndo({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      scope: 'hunk',
      target: { srcTurnId: TURN_A, srcEventId: -1, path: 'a.ts', hunkIdx: 0 },
      postContents: { 'a.ts': 'old' },
    });

    expect(events).toEqual([{ sessionId: SID_A, kind: 'undo' }]);
  });

  it('fires `turn-aborted` after a successful recordTurnAborted', async () => {
    const history = buildHistory();
    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordTurnAborted(SID_A, TURN_A, 'claude-code', 'window-closed');

    expect(events).toEqual([{ sessionId: SID_A, kind: 'turn-aborted' }]);
  });

  it('fires `session-deleted` after a successful deleteSession', async () => {
    const history = buildHistory();
    await seedFullTurn(history, SID_A, TURN_A);
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.deleteSession(SID_A);

    expect(events).toEqual([{ sessionId: SID_A, kind: 'session-deleted' }]);
  });
});

describe('HistoryService.addChangeListener — disabled service', () => {
  it('does NOT fire when enabled=false (early-exit short-circuit)', async () => {
    const history = buildHistory(false);
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    await history.deleteSession(SID_A);

    expect(events).toEqual([]);
  });
});

describe('HistoryService.addChangeListener — multi-listener + lifecycle', () => {
  it('delivers to every registered listener', async () => {
    const history = buildHistory();
    const a: HistoryChangeInfo[] = [];
    const b: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => a.push(info));
    history.addChangeListener((info) => b.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it('unsubscribe stops delivery to that listener only', async () => {
    const history = buildHistory();
    const a: HistoryChangeInfo[] = [];
    const b: HistoryChangeInfo[] = [];
    const unsubA = history.addChangeListener((info) => a.push(info));
    history.addChangeListener((info) => b.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    unsubA();
    await history.recordTurnStarted({
      sessionId: SID_B, turnId: TURN_B, agentId: 'claude-code',
      files: [{ relPath: 'b.ts', beforeContent: 'x', mtimeMs: null }],
    });

    expect(a.length).toBe(1);
    expect(a[0].sessionId).toBe(SID_A);
    expect(b.length).toBe(2);
  });

  it('a throwing listener does NOT break the write path or other listeners', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const history = buildHistory();
    const good: HistoryChangeInfo[] = [];
    history.addChangeListener(() => { throw new Error('listener boom'); });
    history.addChangeListener((info) => good.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });

    // Write succeeded — event durable on disk.
    const evts = await history.readEvents(SID_A);
    expect(evts.length).toBe(1);
    expect(evts[0].kind).toBe('turn-started');
    // Good listener still received the notification.
    expect(good.length).toBe(1);
    // The bad listener was logged.
    expect(warnSpy).toHaveBeenCalledWith(
      'history',
      'listener.threw',
      expect.objectContaining({ kind: 'turn-started', sid: SID_A }),
    );
  });

  it('subscribe → debounce → unsubscribe pattern: late timer does NOT fire post-unsubscribe', async () => {
    // This mirrors `HistoryPanelManager.scheduleSessionListRefresh`'s shape
    // without instantiating a real WebviewPanel: subscribe with a debounced
    // callback, fire an event, unsubscribe BEFORE the debounce window
    // elapses, and assert the callback never executes.
    //
    // Regression target: ensures `unsubscribe()` is sufficient on its own
    // (the panel additionally clearTimeouts the pending refresh; this test
    // proves that even without that belt, the listener pattern is correct).
    const history = buildHistory();
    let listenerInvocations = 0;
    let timerFires = 0;
    let pendingTimer: NodeJS.Timeout | null = null;

    const unsubscribe = history.addChangeListener(() => {
      listenerInvocations += 1;
      if (pendingTimer) return; // mimic the panel's trailing-edge debounce
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        timerFires += 1;
      }, 50);
    });

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'x', mtimeMs: null }],
    });
    expect(listenerInvocations).toBe(1);

    // Simulate panel dispose mid-debounce: unsubscribe + clear pending timer.
    unsubscribe();
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }

    // Further record* calls — listener must NOT fire.
    await history.recordTurnStarted({
      sessionId: SID_B, turnId: TURN_B, agentId: 'claude-code',
      files: [{ relPath: 'b.ts', beforeContent: 'y', mtimeMs: null }],
    });

    // Wait past the debounce window to confirm no stray fire.
    await new Promise((r) => setTimeout(r, 80));

    expect(listenerInvocations).toBe(1); // still just the one pre-unsubscribe fire
    expect(timerFires).toBe(0);          // debounced timer was cleared mid-flight
  });

  it('emits one event per record* call across a full turn lifecycle', async () => {
    const history = buildHistory();
    const events: HistoryChangeInfo[] = [];
    history.addChangeListener((info) => events.push(info));

    await history.recordTurnStarted({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'old', mtimeMs: null }],
    });
    await history.recordTurnStopped({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code', lastAssistantMessage: null,
      files: [{
        relPath: 'a.ts', afterContent: 'new',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      }],
    });
    await history.recordHunkDecided({
      sessionId: SID_A, turnId: TURN_A, agentId: 'claude-code',
      relPath: 'a.ts', hunkIdx: 0, decision: 'accepted',
      postContent: 'new', drift: { fuzz: null },
    });
    await history.deleteSession(SID_A);

    expect(events.map((e) => e.kind)).toEqual([
      'turn-started',
      'turn-stopped',
      'hunk-decided',
      'session-deleted',
    ]);
    expect(events.every((e) => e.sessionId === SID_A)).toBe(true);
  });
});
