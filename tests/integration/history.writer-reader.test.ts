/**
 * T1-A2 + T1-A4: writer rolls segments at 5 MB; reader streams JSONL
 * and skips malformed lines gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryWriter } from '../../src/history/historyWriter.js';
import { HistoryReader } from '../../src/history/historyReader.js';

const FAKE_TURN = '11111111-1111-4111-8111-111111111111';
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-wr-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('HistoryWriter — T1-A2 segment rollover', () => {
  it('rolls segments when the active segment would exceed 5 MB', async () => {
    const sid = 'roll-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    // Each turn-stopped carries a 5 KB lastAssistantMessage; append enough to
    // cross the 5 MB threshold but keep test fast (~1100 appends).
    const filler = 'x'.repeat(5000);
    for (let i = 0; i < 1100; i++) {
      await writer.append({
        kind: 'turn-stopped',
        ts: Date.now(),
        turnId: FAKE_TURN,
        agentId: 'claude-code',
        lastAssistantMessage: filler,
        files: [],
      });
    }
    const segments = await writer.listSegments(sid);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('event ids are monotonic across rollovers', async () => {
    const sid = 'monoton-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await writer.append({
        kind: 'turn-aborted',
        ts: Date.now(),
        turnId: FAKE_TURN,
        agentId: 'claude-code',
        reason: 'timeout',
      });
      ids.push(id);
    }
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('HistoryReader — T1-A4 streaming + tolerance', () => {
  it('streams every event in order across segments', async () => {
    const sid = 'stream-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    for (let i = 0; i < 5; i++) {
      await writer.append({
        kind: 'hunk-decided',
        ts: i,
        turnId: FAKE_TURN,
        agentId: 'claude-code',
        path: 'src/foo.ts',
        hunkIdx: i,
        decision: 'accepted',
        postBlob: 'b'.repeat(64),
        drift: { fuzz: null },
      });
    }
    const reader = new HistoryReader({ root });
    const events: number[] = [];
    for await (const ev of reader.readSession(sid)) {
      if (ev.kind === 'hunk-decided') events.push(ev.hunkIdx);
    }
    expect(events).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips malformed lines silently', async () => {
    const sid = 'malformed-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    await writer.append({
      kind: 'turn-aborted',
      ts: 1, turnId: FAKE_TURN, agentId: 'claude-code', reason: 'timeout',
    });
    // Manually inject a garbage line between events.
    const segPath = path.join(root, 'sessions', `${sid}.0.jsonl`);
    await fs.appendFile(segPath, '{this is not json\n');
    await writer.append({
      kind: 'turn-aborted',
      ts: 2, turnId: FAKE_TURN, agentId: 'claude-code', reason: 'circuit-breaker',
    });

    const reader = new HistoryReader({ root });
    const events = await reader.readAll(sid);
    expect(events.length).toBe(2);
    expect(events.map((e) => (e.kind === 'turn-aborted' ? e.reason : null))).toEqual(['timeout', 'circuit-breaker']);
  });

  it('lists all sessions present on disk', async () => {
    const writer1 = new HistoryWriter({ root, sessionId: 'aaa' });
    await writer1.append({ kind: 'turn-aborted', ts: 1, turnId: FAKE_TURN, agentId: 'claude-code', reason: 'timeout' });
    const writer2 = new HistoryWriter({ root, sessionId: 'bbb' });
    await writer2.append({ kind: 'turn-aborted', ts: 2, turnId: FAKE_TURN, agentId: 'claude-code', reason: 'timeout' });

    const reader = new HistoryReader({ root });
    const sids = (await reader.listSessions()).sort();
    expect(sids).toEqual(['aaa', 'bbb']);
  });
});

describe('HistoryReader — T1-A8 crash recovery candidates', () => {
  it('findResumeCandidates returns open turns within the window', async () => {
    const sid = 'open-turn-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    // turn-started without matching turn-stopped → open turn
    await writer.append({
      kind: 'turn-started',
      ts: Date.now() - 1000, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [{ path: 'src/foo.ts', beforeBlob: 'a'.repeat(64), mtimeBeforeMs: null }],
    });
    const reader = new HistoryReader({ root });
    const candidates = await reader.findResumeCandidates({ withinMs: 60_000 });
    expect(candidates.length).toBe(1);
    expect(candidates[0].sessionId).toBe(sid);
    expect(candidates[0].hasOpenTurn).toBe(true);
    expect(candidates[0].openTurnStarted).not.toBeNull();
  });

  it('findResumeCandidates does not return closed turns', async () => {
    const sid = 'closed-turn-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    await writer.append({
      kind: 'turn-started',
      ts: Date.now() - 1000, turnId: FAKE_TURN, agentId: 'claude-code',
      files: [{ path: 'src/foo.ts', beforeBlob: 'a'.repeat(64), mtimeBeforeMs: null }],
    });
    await writer.append({
      kind: 'turn-stopped',
      ts: Date.now() - 500, turnId: FAKE_TURN, agentId: 'claude-code',
      lastAssistantMessage: 'done',
      files: [],
    });
    const reader = new HistoryReader({ root });
    const candidates = await reader.findResumeCandidates({ withinMs: 60_000 });
    expect(candidates.length).toBe(1);
    expect(candidates[0].hasOpenTurn).toBe(false);
  });

  it('findResumeCandidates filters by age window', async () => {
    const sid = 'old-session';
    const writer = new HistoryWriter({ root, sessionId: sid });
    await writer.append({
      kind: 'turn-aborted',
      ts: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      turnId: FAKE_TURN, agentId: 'claude-code',
      reason: 'window-closed',
    });
    const reader = new HistoryReader({ root });
    const recent = await reader.findResumeCandidates({ withinMs: 24 * 60 * 60 * 1000 });
    expect(recent.length).toBe(0);
  });
});
