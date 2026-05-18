/**
 * T1-A1: schema validation. The Zod-backed `decodeEvent` accepts every
 * known shape and tolerantly rejects malformed/unknown lines.
 */

import { describe, it, expect } from 'vitest';
import { decodeEvent, HistoryEvent } from '../../src/history/historyEvents.js';

const FAKE_SHA = 'a'.repeat(64);
const FAKE_TURN = '11111111-1111-4111-8111-111111111111';

describe('historyEvents — T1-A1 schema decode', () => {
  it('decodes a turn-started event', () => {
    const raw: HistoryEvent = {
      v: 1, eventId: 0, ts: 1, turnId: FAKE_TURN, agentId: 'claude-code',
      kind: 'turn-started',
      files: [{ path: 'src/foo.ts', beforeBlob: FAKE_SHA, mtimeBeforeMs: 1234 }],
    };
    expect(decodeEvent(raw)).toEqual(raw);
  });

  it('decodes a turn-stopped event', () => {
    const raw: HistoryEvent = {
      v: 1, eventId: 1, ts: 2, turnId: FAKE_TURN, agentId: 'claude-code',
      kind: 'turn-stopped',
      lastAssistantMessage: 'done',
      files: [{
        path: 'src/foo.ts',
        afterBlob: FAKE_SHA,
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }],
      }],
    };
    expect(decodeEvent(raw)).toEqual(raw);
  });

  it('decodes a hunk-decided event', () => {
    const raw: HistoryEvent = {
      v: 1, eventId: 2, ts: 3, turnId: FAKE_TURN, agentId: 'opencode',
      kind: 'hunk-decided',
      path: 'src/foo.ts', hunkIdx: 0,
      decision: 'accepted', postBlob: FAKE_SHA,
      drift: { fuzz: null },
    };
    expect(decodeEvent(raw)).toEqual(raw);
  });

  it('decodes a file-snapshot-reverted event', () => {
    const raw: HistoryEvent = {
      v: 1, eventId: 3, ts: 4, turnId: FAKE_TURN, agentId: 'claude-code',
      kind: 'file-snapshot-reverted',
      path: 'src/foo.ts', postBlob: FAKE_SHA,
    };
    expect(decodeEvent(raw)).toEqual(raw);
  });

  it('decodes a turn-aborted event', () => {
    const raw: HistoryEvent = {
      v: 1, eventId: 4, ts: 5, turnId: FAKE_TURN, agentId: 'claude-code',
      kind: 'turn-aborted',
      reason: 'window-closed',
    };
    expect(decodeEvent(raw)).toEqual(raw);
  });

  it('returns null on unknown kind', () => {
    const raw = { v: 1, eventId: 0, ts: 1, turnId: FAKE_TURN, agentId: 'claude-code', kind: 'never-heard-of-this' };
    expect(decodeEvent(raw)).toBeNull();
  });

  it('returns null on shape mismatch', () => {
    const raw = { kind: 'turn-started' /* missing required fields */ };
    expect(decodeEvent(raw)).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(decodeEvent(null)).toBeNull();
    expect(decodeEvent(42)).toBeNull();
    expect(decodeEvent('string')).toBeNull();
  });
});
