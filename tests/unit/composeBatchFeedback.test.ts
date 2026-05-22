/**
 * v0.4 (A5) — unit tests for `composeBatchFeedbackMessage`.
 *
 * The function is pure-text composition; we lock the shape so downstream
 * consumers (Insights panel, end-to-end E2E tests) can stably assert
 * against it later.
 */

import { describe, it, expect } from 'vitest';
import { composeBatchFeedbackMessage } from '../../src/chatService.js';

describe('composeBatchFeedbackMessage', () => {
  it('header pluralises with N=1 vs N>1', () => {
    expect(composeBatchFeedbackMessage([
      { relPath: 'a.ts', hunkIdx: 0, reason: 'x' },
    ]).startsWith('I rejected 1 hunk ')).toBe(true);
    expect(composeBatchFeedbackMessage([
      { relPath: 'a.ts', hunkIdx: 0, reason: 'x' },
      { relPath: 'b.ts', hunkIdx: 0, reason: 'y' },
    ]).startsWith('I rejected 2 hunks ')).toBe(true);
  });

  it('1-indexes hunk numbers and quotes reason text', () => {
    const out = composeBatchFeedbackMessage([
      { relPath: 'src/foo.ts', hunkIdx: 2, reason: 'broke null check' },
    ]);
    expect(out).toContain('src/foo.ts hunk 3');
    expect(out).toContain('"broke null check"');
  });

  it('collapses multi-line reasons to a single line', () => {
    const out = composeBatchFeedbackMessage([
      { relPath: 'a.ts', hunkIdx: 0, reason: 'line1\n  line2\n\nline3' },
    ]);
    expect(out).toContain('"line1 line2 line3"');
    expect(out.split('\n').filter((l) => l.startsWith('•')).length).toBe(1);
  });

  it('emits one bullet per draft', () => {
    const out = composeBatchFeedbackMessage([
      { relPath: 'a.ts', hunkIdx: 0, reason: 'r1' },
      { relPath: 'b.ts', hunkIdx: 1, reason: 'r2' },
      { relPath: 'c.ts', hunkIdx: 2, reason: 'r3' },
    ]);
    expect(out.split('\n').filter((l) => l.startsWith('•')).length).toBe(3);
  });
});
