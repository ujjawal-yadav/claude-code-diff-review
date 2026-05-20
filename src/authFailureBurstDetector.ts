/**
 * Auth-failure burst detector (2026-05-19).
 *
 * Surfaces an actionable toast when ≥`threshold` 401 responses from the
 * loopback hook server land within a `windowMs` sliding window. Designed to
 * be the *signal* that replaces the unconditional activation toast — fires
 * only when alignment actually breaks (stale terminal, expired token,
 * external-process auth mismatch), so the user never sees a spurious
 * "reopen terminals" prompt after a clean reload.
 *
 * Failure-mode this targets
 * --------------------------
 * The most common pattern is the PreToolUse + PostToolUse + Stop trio from
 * a single Claude turn all failing back-to-back. Threshold=3, window=10s
 * matches that pattern exactly without false-positiving on a single
 * transient race.
 *
 * After a toast fires, the detector enters a `cooldownMs` window during
 * which further failures don't re-toast — prevents carpeting the user
 * with notifications while they're mid-recovery (e.g., they just clicked
 * `Open New Terminal` and the OLD terminal is still firing 401s).
 *
 * Test seams
 * ----------
 * `showToast` and `executeAction` are injected so unit tests can drive
 * the detector deterministically without spinning up vscode's UI layer.
 * Defaults call `vscode.window.showWarningMessage` and
 * `vscode.commands.executeCommand`.
 */

import * as vscode from 'vscode';

import type { Logger } from './logger.js';

export type BurstAction = 'open-new-terminal' | 'show-logs' | 'rotate-token' | 'dismiss';

export interface AuthFailureBurstDetectorOptions {
  logger: Logger;
  /** Default 3 — failures required within `windowMs` to trigger. */
  threshold?: number;
  /** Default 10 000 ms. */
  windowMs?: number;
  /** Default 60 000 ms — silences re-fires after a toast is shown. */
  cooldownMs?: number;
  /**
   * Test seam — defaults to `vscode.window.showWarningMessage`. Return type
   * uses `PromiseLike` so the default vscode `Thenable` and test stubs
   * returning native Promises both fit.
   */
  showToast?: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  /** Test seam — defaults to executing the action via the real vscode API. */
  executeAction?: (action: BurstAction) => void;
  /** Test seam — wraps `Date.now()` so fake-timer tests stay deterministic. */
  now?: () => number;
}

const DEFAULTS = {
  threshold: 3,
  windowMs: 10_000,
  cooldownMs: 60_000,
};

const LABELS = {
  OPEN_NEW_TERMINAL: 'Open New Terminal',
  SHOW_LOGS:         'Show Logs',
  ROTATE_TOKEN:      'Rotate Token',
} as const;

export class AuthFailureBurstDetector {
  private readonly logger: Logger;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly showToast: NonNullable<AuthFailureBurstDetectorOptions['showToast']>;
  private readonly executeAction: NonNullable<AuthFailureBurstDetectorOptions['executeAction']>;
  private readonly now: () => number;

  private timestamps: number[] = [];
  private cooldownUntil = 0;
  private disposed = false;

  constructor(opts: AuthFailureBurstDetectorOptions) {
    this.logger = opts.logger;
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.now = opts.now ?? (() => Date.now());
    this.showToast = opts.showToast ?? defaultShowToast;
    this.executeAction = opts.executeAction ?? defaultExecuteAction;
  }

  /**
   * Record an auth failure. Cheap — drops stale timestamps from the sliding
   * window and triggers `fire` only when the threshold is crossed AND we're
   * outside the cooldown window. Safe to call from inside the server's
   * onRequest hook (no async work performed synchronously).
   */
  record(): void {
    if (this.disposed) return;
    const t = this.now();
    this.timestamps.push(t);
    // Drop timestamps that have fallen out of the sliding window.
    const cutoff = t - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.threshold && t >= this.cooldownUntil) {
      this.cooldownUntil = t + this.cooldownMs;
      // Fire-and-forget — the toast resolution drives the action handler.
      void this.fire();
    }
  }

  private async fire(): Promise<void> {
    this.logger.info('authBurst', 'fired', {
      countInWindow: this.timestamps.length,
      windowMs: this.windowMs,
    });
    const choice = await this.showToast(
      'Claude Code Review: hook calls are returning 401 (unauthorized). The terminal running Claude likely has a stale auth token.',
      LABELS.OPEN_NEW_TERMINAL,
      LABELS.SHOW_LOGS,
      LABELS.ROTATE_TOKEN,
    );
    const action = labelToAction(choice);
    if (action === 'dismiss') return;
    this.executeAction(action);
  }

  dispose(): void {
    this.disposed = true;
    this.timestamps.length = 0;
  }
}

function labelToAction(label: string | undefined): BurstAction {
  switch (label) {
    case LABELS.OPEN_NEW_TERMINAL: return 'open-new-terminal';
    case LABELS.SHOW_LOGS:         return 'show-logs';
    case LABELS.ROTATE_TOKEN:      return 'rotate-token';
    default:                       return 'dismiss';
  }
}

function defaultShowToast(message: string, ...actions: string[]): PromiseLike<string | undefined> {
  return vscode.window.showWarningMessage(message, ...actions);
}

function defaultExecuteAction(action: BurstAction): void {
  switch (action) {
    case 'open-new-terminal':
      void vscode.commands.executeCommand('workbench.action.terminal.new');
      return;
    case 'show-logs':
      // Surface the extension's own output channel. The Logger exposes
      // `show()` but the detector doesn't hold a direct reference — use
      // the dedicated command so behaviour aligns with what users get
      // from the command palette.
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      return;
    case 'rotate-token':
      void vscode.commands.executeCommand('claudeReview.rotateBearerToken');
      return;
    case 'dismiss':
      return;
  }
}

/** Exported for tests only. */
export const __test = { labelToAction, LABELS };
