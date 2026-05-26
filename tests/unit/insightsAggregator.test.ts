/**
 * v0.6 (A9): unit tests for the pure `tallyInsights` aggregation. Synthetic
 * HistoryEvent arrays, inline factories — no I/O, no fixtures (matches the
 * riskFlagger.test.ts style).
 *
 * Covers the correctness traps: final-decision-after-undo, undo cascade,
 * file-snapshot-reverted, subagent bucketing (incl. unattributed), `edited`
 * accounting, trend bucketing (+ undo does NOT retract a bucket), reason
 * grouping, and the empty report.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tallyInsights, MAIN_SENTINEL } from '../../src/insights/insightsAggregator.js';
import type { HistoryEvent } from '../../src/history/historyEvents.js';

const TURN = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-05-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 30 * DAY;

let eid = 0;
beforeEach(() => {
  eid = 0;
});

function base(extra: Record<string, unknown>): HistoryEvent {
  return {
    v: 1,
    ts: NOW,
    eventId: eid++,
    turnId: TURN,
    agentId: 'claude-code',
    ...extra,
  } as unknown as HistoryEvent;
}

function decided(
  path: string,
  hunkIdx: number,
  decision: 'accepted' | 'rejected',
  opts?: { ts?: number; subagentId?: string },
): HistoryEvent {
  return base({
    kind: 'hunk-decided',
    path,
    hunkIdx,
    decision,
    postBlob: null,
    drift: { fuzz: null },
    ...(opts?.ts !== undefined ? { ts: opts.ts } : {}),
    ...(opts?.subagentId ? { subagentId: opts.subagentId } : {}),
  });
}

function edited(path: string, hunkIdx: number): HistoryEvent {
  return base({
    kind: 'hunk-edited',
    path,
    hunkIdx,
    editedAfterBlob: 'sha',
    postBlob: 'sha',
    oldHunk: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
    newHunk: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
  });
}

function undo(
  scope: 'hunk' | 'file' | 'turn',
  target: { path?: string; hunkIdx?: number },
  cascaded: Array<{ turnId: string; path: string; hunkIdx: number }> = [],
): HistoryEvent {
  return base({
    kind: 'undo',
    scope,
    target: { srcTurnId: TURN, srcEventId: -1, ...target },
    postBlobs: {},
    cascaded,
  });
}

function turnStopped(
  files: Array<{ path: string; subagentId?: string }>,
): HistoryEvent {
  return base({
    kind: 'turn-stopped',
    lastAssistantMessage: null,
    files: files.map((f) => ({
      path: f.path,
      afterBlob: 'sha',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      ...(f.subagentId ? { subagentId: f.subagentId } : {}),
      hunks: [],
    })),
  });
}

function revert(path: string): HistoryEvent {
  return base({ kind: 'file-snapshot-reverted', path, postBlob: 'sha' });
}

function run(events: HistoryEvent[], reasons: Array<{ path: string; reason: string }> = []) {
  return tallyInsights({
    sessions: [{ sessionId: 's1', events }],
    reasons,
    now: NOW,
    windowMs: WINDOW,
  });
}

describe('tallyInsights — final-decision rates (undo-aware)', () => {
  it('re-decide after undo reflects the FINAL decision, not both', () => {
    const r = run([
      decided('a.ts', 0, 'accepted'),
      undo('hunk', { path: 'a.ts', hunkIdx: 0 }),
      decided('a.ts', 0, 'rejected'),
    ]);
    const a = r.fileRates.find((f) => f.path === 'a.ts')!;
    expect(a.accepted).toBe(0);
    expect(a.rejected).toBe(1);
  });

  it('undo with no re-decide leaves the hunk contributing nothing', () => {
    const r = run([
      decided('b.ts', 0, 'accepted'),
      undo('hunk', { path: 'b.ts', hunkIdx: 0 }),
    ]);
    expect(r.fileRates.find((f) => f.path === 'b.ts')).toBeUndefined();
    expect(r.empty).toBe(true);
  });

  it('undo scope "turn" resets every cascaded key', () => {
    const r = run([
      decided('a.ts', 0, 'accepted'),
      decided('a.ts', 1, 'accepted'),
      undo('turn', {}, [
        { turnId: TURN, path: 'a.ts', hunkIdx: 0 },
        { turnId: TURN, path: 'a.ts', hunkIdx: 1 },
      ]),
    ]);
    expect(r.fileRates).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('file-snapshot-reverted drops all final states for that path', () => {
    const r = run([
      decided('a.ts', 0, 'accepted'),
      decided('a.ts', 1, 'rejected'),
      revert('a.ts'),
    ]);
    expect(r.fileRates.find((f) => f.path === 'a.ts')).toBeUndefined();
  });

  it('omits pending-only files (no terminal decision) from fileRates', () => {
    const r = run([turnStopped([{ path: 'a.ts' }])]);
    expect(r.fileRates).toEqual([]);
    expect(r.empty).toBe(true);
  });
});

describe('tallyInsights — subagent bucketing', () => {
  it('attributes explicit, turn-stopped-inherited, and unattributed decisions', () => {
    const r = run([
      turnStopped([{ path: 'b.ts', subagentId: 'task-B' }]),
      decided('b.ts', 0, 'accepted'), // inherits task-B via subagentByPath
      decided('a.ts', 0, 'accepted', { subagentId: 'task-A' }), // explicit
      decided('c.ts', 0, 'accepted'), // unattributed → __main__
    ]);
    const ids = r.subagentRates.map((s) => s.subagentId).sort();
    expect(ids).toEqual([MAIN_SENTINEL, 'task-A', 'task-B']);
    const main = r.subagentRates.find((s) => s.subagentId === MAIN_SENTINEL)!;
    expect(main.label).toBe('Main agent');
    expect(main.accepted).toBe(1);
  });
});

describe('tallyInsights — edited accounting', () => {
  it('excludes edited from the accept-rate denominator but surfaces the count', () => {
    const r = run([decided('a.ts', 0, 'accepted'), edited('a.ts', 1)]);
    const a = r.fileRates.find((f) => f.path === 'a.ts')!;
    expect(a.accepted).toBe(1);
    expect(a.rejected).toBe(0);
    expect(a.edited).toBe(1);
    expect(a.acceptRate).toBe(1); // 1/(1+0); edited not in denominator
  });
});

describe('tallyInsights — trend', () => {
  it('buckets decision events by day; exactly 30 buckets oldest→newest', () => {
    const r = run([
      decided('a.ts', 0, 'rejected', { ts: NOW }),
      decided('a.ts', 1, 'accepted', { ts: NOW }),
      decided('z.ts', 0, 'accepted', { ts: NOW - 40 * DAY }), // outside trend window
    ]);
    expect(r.trend.length).toBe(30);
    const today = r.trend[29];
    expect(today.day).toBe('2026-05-26');
    expect(today.decided).toBe(2);
    expect(today.rejected).toBe(1);
    expect(today.rejectionRate).toBeCloseTo(0.5);
    // The 40-day-old event is dropped from every bucket.
    const totalDecided = r.trend.reduce((n, b) => n + b.decided, 0);
    expect(totalDecided).toBe(2);
  });

  it('undo does NOT retract a trend bucket (trend counts activity)', () => {
    const r = run([
      decided('a.ts', 0, 'accepted', { ts: NOW }),
      decided('a.ts', 1, 'rejected', { ts: NOW }),
      undo('hunk', { path: 'a.ts', hunkIdx: 1 }),
    ]);
    expect(r.trend[29].decided).toBe(2);
  });
});

describe('tallyInsights — rejection reasons', () => {
  it('groups identical reasons, counts, and caps samples', () => {
    const r = run(
      [decided('a.ts', 0, 'rejected')],
      [
        { path: 'a.ts', reason: 'too risky' },
        { path: 'b.ts', reason: 'too risky' },
        { path: 'c.ts', reason: 'breaks API' },
      ],
    );
    expect(r.reasons.total).toBe(3);
    const risky = r.reasons.groups.find((g) => g.reason === 'too risky')!;
    expect(risky.count).toBe(2);
    expect(risky.samplePaths).toEqual(['a.ts', 'b.ts']);
  });

  it('empty reasons → total 0, no groups', () => {
    const r = run([decided('a.ts', 0, 'accepted')]);
    expect(r.reasons.total).toBe(0);
    expect(r.reasons.groups).toEqual([]);
  });
});

describe('tallyInsights — empty report', () => {
  it('no decisions anywhere → empty true, trend still 30 buckets', () => {
    const r = run([]);
    expect(r.empty).toBe(true);
    expect(r.fileRates).toEqual([]);
    expect(r.subagentRates).toEqual([]);
    expect(r.trend.length).toBe(30);
    expect(r.sessionsScanned).toBe(1);
  });
});
