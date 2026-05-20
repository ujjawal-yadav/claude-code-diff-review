/**
 * Auth-failure burst detector (2026-05-19) — unit tests.
 *
 * Contract:
 *   1. Fewer than threshold failures within windowMs → no toast.
 *   2. threshold failures within windowMs → toast fired once with three actions.
 *   3. Sliding window correctly drops stale timestamps (burst spread over
 *      > windowMs does NOT fire).
 *   4. After fire, additional failures within cooldownMs → no re-fire.
 *   5. After cooldownMs elapses + new burst → toast fires again.
 *   6. Each label maps to the correct BurstAction; dismissal (undefined) is
 *      treated as 'dismiss' (no executeAction call).
 *
 * Uses injected `now()`, `showToast`, `executeAction` seams to avoid wall-
 * clock + vscode coupling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AuthFailureBurstDetector,
  BurstAction,
  __test,
} from '../../src/authFailureBurstDetector.js';
import { Logger } from '../../src/logger.js';

let logger: Logger;
beforeEach(() => {
  logger = new Logger('test', 'error');
});

function build(opts: {
  showToast?: (msg: string, ...actions: string[]) => Promise<string | undefined>;
  executeAction?: (a: BurstAction) => void;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  initialTime?: number;
}) {
  let t = opts.initialTime ?? 1_000_000;
  const advance = (ms: number) => { t += ms; };
  const detector = new AuthFailureBurstDetector({
    logger,
    threshold: opts.threshold ?? 3,
    windowMs:  opts.windowMs  ?? 10_000,
    cooldownMs: opts.cooldownMs ?? 60_000,
    now: () => t,
    showToast: opts.showToast ?? (async () => undefined),
    executeAction: opts.executeAction ?? (() => {}),
  });
  return { detector, advance, getNow: () => t };
}

describe('AuthFailureBurstDetector', () => {
  it('does NOT fire when below threshold within window', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector } = build({ showToast: toast, threshold: 3 });

    detector.record();
    detector.record();

    // Let any microtasks settle. (No actual async work — defensive.)
    await new Promise((r) => setImmediate(r));
    expect(toast).not.toHaveBeenCalled();
  });

  it('fires exactly once when threshold reached within window', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector, advance } = build({ showToast: toast, threshold: 3 });

    detector.record();
    advance(100);
    detector.record();
    advance(100);
    detector.record();

    await new Promise((r) => setImmediate(r));
    expect(toast).toHaveBeenCalledTimes(1);
    // Three actions surfaced (Open New Terminal / Show Logs / Rotate Token).
    expect(toast.mock.calls[0].length).toBe(4); // message + 3 actions
  });

  it('does NOT fire when failures are spread beyond windowMs', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector, advance } = build({ showToast: toast, threshold: 3, windowMs: 10_000 });

    detector.record();           // t=0
    advance(6_000);
    detector.record();           // t=6_000
    advance(6_000);
    detector.record();           // t=12_000 → first timestamp dropped, count=2

    await new Promise((r) => setImmediate(r));
    expect(toast).not.toHaveBeenCalled();
  });

  it('respects cooldown: re-bursting before cooldownMs does NOT re-fire', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector, advance } = build({ showToast: toast, threshold: 3, cooldownMs: 60_000 });

    detector.record(); detector.record(); detector.record();
    await new Promise((r) => setImmediate(r));
    expect(toast).toHaveBeenCalledTimes(1);

    // Another full burst inside cooldown — should be suppressed.
    advance(5_000);
    detector.record(); detector.record(); detector.record();
    await new Promise((r) => setImmediate(r));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('fires again after cooldownMs elapses', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector, advance } = build({ showToast: toast, threshold: 3, cooldownMs: 60_000, windowMs: 10_000 });

    detector.record(); detector.record(); detector.record();
    await new Promise((r) => setImmediate(r));
    expect(toast).toHaveBeenCalledTimes(1);

    advance(61_000); // past cooldown
    detector.record(); detector.record(); detector.record();
    await new Promise((r) => setImmediate(r));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('dispatches the correct BurstAction for each label', async () => {
    const labels = __test.LABELS;
    const calls: BurstAction[] = [];

    // One detector per scenario — easier than re-using state.
    for (const [label, expected] of [
      [labels.OPEN_NEW_TERMINAL, 'open-new-terminal'],
      [labels.SHOW_LOGS,         'show-logs'],
      [labels.ROTATE_TOKEN,      'rotate-token'],
    ] as Array<[string, BurstAction]>) {
      const { detector } = build({
        showToast: async () => label,
        executeAction: (a) => calls.push(a),
        threshold: 1, // fire on first record for compactness
      });
      detector.record();
      // Toast resolution is async; flush.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(calls.at(-1)).toBe(expected);
    }
  });

  it('dismissal (undefined return from toast) does NOT executeAction', async () => {
    const exec = vi.fn(() => {});
    const { detector } = build({
      showToast: async () => undefined, // user pressed Esc / dismissed
      executeAction: exec,
      threshold: 1,
    });
    detector.record();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exec).not.toHaveBeenCalled();
  });

  it('dispose() halts further recording and clears state', async () => {
    const toast = vi.fn(async () => undefined);
    const { detector } = build({ showToast: toast, threshold: 3 });

    detector.record(); detector.record();
    detector.dispose();
    detector.record(); // would have crossed threshold pre-dispose
    await new Promise((r) => setImmediate(r));
    expect(toast).not.toHaveBeenCalled();
  });

  it('labelToAction maps unknown strings to dismiss', () => {
    expect(__test.labelToAction(undefined)).toBe('dismiss');
    expect(__test.labelToAction('Random Other Label')).toBe('dismiss');
    expect(__test.labelToAction(__test.LABELS.OPEN_NEW_TERMINAL)).toBe('open-new-terminal');
  });
});
