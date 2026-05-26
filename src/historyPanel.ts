/**
 * History panel webview manager (Phase α M9.2.8).
 *
 * Mirrors `src/reviewPanel.ts` lifecycle conventions: CSP nonce, message
 * validation, ready-gate before flushing posts. Far simpler — the panel
 * is read-mostly (no chat overlay, no per-hunk actions; the review panel
 * still owns those). v0.2 surfaces session list + turn timeline.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import type { HistoryService } from './history/historyService.js';
import type { HistoryEvent } from './history/historyEvents.js';
import type { Logger } from './logger.js';
import type { ReviewOrchestrator } from './reviewOrchestrator.js';
import type { ReviewPanelManager } from './reviewPanel.js';
import type { PendingStatusBar } from './pendingStatusBar.js';
import { InsightsAggregator } from './insights/insightsAggregator.js';
import {
  HistoryHostToWebview,
  parseHistoryWebviewMessage,
} from './messages.js';

/**
 * Test-injectable destructive-confirm hook. Default delegates to
 * `vscode.window.showWarningMessage` with `{ modal: true, detail }`. Tests
 * override with a stub that auto-accepts or auto-declines without UI.
 */
export type ConfirmDestructive = (
  title: string,
  detail: string,
  destructiveLabel: string,
) => Promise<boolean>;

export interface HistoryPanelOptions {
  context: vscode.ExtensionContext;
  logger: Logger;
  history: HistoryService;
  /**
   * β.0 (10.1.8): the History panel becomes action-capable (Resume / Rollback
   * / Delete). When these are absent the panel stays read-only — keeps unit
   * tests that exercise only listing / loading from needing to construct
   * the full host pipeline.
   */
  orchestrator?: ReviewOrchestrator;
  reviewPanel?: ReviewPanelManager;
  pendingStatusBar?: PendingStatusBar;
  /** Defaults to a vscode modal warning. Tests inject a stub. */
  confirmDestructive?: ConfirmDestructive;
  /**
   * v0.6 (A9): test-injectable insights aggregator. When absent, one is
   * lazily constructed from `history` + `logger` on first `load-insights`.
   */
  insightsAggregator?: InsightsAggregator;
}

interface PanelState {
  panel: vscode.WebviewPanel;
  pending: HistoryHostToWebview[];
  flushScheduled: boolean;
  ready: boolean;
  /**
   * Live-update wiring (2026-05-19). Set when openOrFocus subscribes to
   * HistoryService.addChangeListener; called on dispose to drop the listener.
   */
  unsubscribe?: () => void;
  /**
   * Trailing-edge debounce timer for live session-list refresh. Cleared on
   * dispose so a refresh can't fire against a torn-down panel.
   */
  refreshTimer?: NodeJS.Timeout;
  /**
   * v0.6 (A9): true once the user has opened the Insights tab at least once.
   * Gates the (heavier) live insights recompute so it never runs for users
   * who only browse the session list.
   */
  insightsRequested: boolean;
  /** Trailing-edge debounce timer for live insights recompute. */
  insightsRefreshTimer?: NodeJS.Timeout;
}

export class HistoryPanelManager {
  private panel: PanelState | undefined;

  /**
   * Debounce window for live session-list refreshes. Trailing-edge — absorbs
   * Claude's burst-write pattern (5–10 history events in <50ms during a turn)
   * and posts one fresh snapshot after the burst settles. Tuned well under
   * perceptual latency while keeping disk reads cheap.
   */
  private static readonly LIST_REFRESH_DEBOUNCE_MS = 300;

  /**
   * v0.6 (A9): insights recompute debounce. Deliberately longer than the
   * session-list refresh — insights scans many sessions, and the user does
   * not need sub-second freshness on aggregate analytics.
   */
  private static readonly INSIGHTS_REFRESH_DEBOUNCE_MS = 2000;

  /** Lazily constructed on first `load-insights` when not injected. */
  private aggregator: InsightsAggregator | undefined;

  constructor(private readonly opts: HistoryPanelOptions) {
    this.aggregator = opts.insightsAggregator;
  }

  async openOrFocus(): Promise<void> {
    if (this.panel) {
      this.panel.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const wp = vscode.window.createWebviewPanel(
      'claudeReview.history',
      'Claude Code Review · History',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.opts.context.extensionUri, 'dist', 'webview', 'history'),
        ],
      },
    );

    const state: PanelState = {
      panel: wp,
      pending: [],
      flushScheduled: false,
      ready: false,
      insightsRequested: false,
    };
    this.panel = state;

    // Live-update subscription: any record* write on the HistoryService
    // schedules a debounced re-post of the session list. Stored on state so
    // disposal can drop it cleanly (preventing leaks across panel reopens).
    // v0.6: also schedule an insights recompute, but only once the user has
    // opened the Insights tab (gated on insightsRequested) and on a longer
    // debounce so analytics don't churn on every burst write.
    state.unsubscribe = this.opts.history.addChangeListener(() => {
      this.scheduleSessionListRefresh();
      if (this.panel?.insightsRequested) this.scheduleInsightsRecompute();
    });

    wp.webview.html = this.renderHtml(wp.webview);

    wp.webview.onDidReceiveMessage(
      async (raw) => {
        const msg = parseHistoryWebviewMessage(raw);
        if (!msg) {
          this.opts.logger.warn('historyPanel', 'message.invalid', { raw });
          return;
        }
        await this.dispatch(msg);
      },
      undefined,
      this.opts.context.subscriptions,
    );

    wp.onDidDispose(
      () => {
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        if (state.insightsRefreshTimer) clearTimeout(state.insightsRefreshTimer);
        state.unsubscribe?.();
        this.panel = undefined;
      },
      undefined,
      this.opts.context.subscriptions,
    );

    // Build the init payload (session list) eagerly so it's ready when the
    // webview signals ready.
    try {
      const sessions = await this.opts.history.listSessions();
      this.post({ type: 'init', sessions, root: this.opts.history.getRoot() });
    } catch (err) {
      this.opts.logger.warn('historyPanel', 'init.listSessions.failed', { err: String(err) });
      this.post({ type: 'error', message: `Failed to load sessions: ${(err as Error).message}` });
    }
  }

  private async dispatch(msg: import('./messages.js').HistoryWebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this.panel) {
          this.panel.ready = true;
          this.scheduleFlush();
        }
        return;
      case 'load-session': {
        try {
          const events = await this.opts.history.readEvents(msg.sessionId);
          this.post({ type: 'session-loaded', sessionId: msg.sessionId, events });
        } catch (err) {
          this.post({ type: 'error', message: `Failed to load session ${msg.sessionId}: ${(err as Error).message}` });
        }
        return;
      }
      case 'log':
        if (msg.level === 'warn') this.opts.logger.warn('historyWebview', msg.msg);
        else if (msg.level === 'info') this.opts.logger.info('historyWebview', msg.msg);
        else this.opts.logger.debug('historyWebview', msg.msg);
        return;
      case 'resume-session':
        await this.handleResume(msg.sessionId);
        return;
      case 'rollback-turn':
        await this.handleRollback(msg.sessionId);
        return;
      case 'delete-session':
        await this.handleDelete(msg.sessionId);
        return;
      case 'load-insights':
        if (this.panel) this.panel.insightsRequested = true;
        await this.handleLoadInsights(msg.windowMs);
        return;
    }
  }

  /**
   * v0.6 (A9): compute the cross-session insights report and post it. Lazily
   * constructs the aggregator on first use (unless one was injected for tests).
   * The aggregator's per-session memo means repeated computes only rescan
   * sessions whose `lastEventAt` changed.
   */
  private async handleLoadInsights(windowMs?: number): Promise<void> {
    try {
      const aggregator = this.getAggregator();
      const report = await aggregator.compute(
        windowMs !== undefined ? { windowMs } : undefined,
      );
      this.post({ type: 'insights-report', report });
    } catch (err) {
      const message = (err as Error).message;
      this.opts.logger.warn('historyPanel', 'insights.failed', { err: message });
      this.post({ type: 'insights-error', message });
    }
  }

  private getAggregator(): InsightsAggregator {
    if (!this.aggregator) {
      this.aggregator = new InsightsAggregator({
        history: this.opts.history,
        logger: this.opts.logger,
      });
    }
    return this.aggregator;
  }

  /**
   * β.0 (10.1.8): if the requested session is already live in memory,
   * decision #12 says focus the existing panel rather than re-adopt.
   * Otherwise reconstruct → adopt → open.
   */
  private async handleResume(sessionId: string): Promise<void> {
    const { orchestrator, reviewPanel, history } = this.opts;
    if (!orchestrator || !reviewPanel) {
      this.opts.logger.warn('historyPanel', 'resume.unwired', { sessionId });
      this.post({ type: 'session-action-result', sessionId, action: 'resume', ok: false, error: 'panel-not-wired' });
      return;
    }
    try {
      const existing = orchestrator.getSession(sessionId);
      if (existing) {
        await reviewPanel.openOrFocus(existing);
        this.post({ type: 'session-action-result', sessionId, action: 'resume', ok: true });
        return;
      }
      const recon = await history.reconstructSessionReview(sessionId);
      if (!recon) {
        this.post({
          type: 'session-action-result',
          sessionId, action: 'resume', ok: false,
          error: 'reconstruction returned null (session may have no events)',
        });
        return;
      }
      orchestrator.adoptReconstructed(recon);
      const review = orchestrator.getSession(sessionId);
      if (review) await reviewPanel.openOrFocus(review);
      this.opts.pendingStatusBar?.scheduleRefresh();
      this.post({ type: 'session-action-result', sessionId, action: 'resume', ok: true });
    } catch (err) {
      const message = (err as Error).message;
      this.opts.logger.warn('historyPanel', 'resume.failed', { sessionId, err: message });
      this.post({ type: 'session-action-result', sessionId, action: 'resume', ok: false, error: message });
    }
  }

  private async handleRollback(sessionId: string): Promise<void> {
    const { orchestrator, history } = this.opts;
    if (!orchestrator) {
      this.post({ type: 'session-action-result', sessionId, action: 'rollback', ok: false, error: 'orchestrator-not-wired' });
      return;
    }
    const confirm = this.opts.confirmDestructive ?? defaultConfirmDestructive;
    const confirmed = await confirm(
      'Rollback this turn',
      `Restore every file in session ${sessionId.slice(0, 8)} to its pre-edit content. This will overwrite current on-disk content for those files. Cannot be undone.`,
      'Rollback',
    );
    if (!confirmed) return;
    try {
      const recon = await history.reconstructSessionReview(sessionId);
      if (!recon) {
        this.post({ type: 'session-action-result', sessionId, action: 'rollback', ok: false, error: 'reconstruction returned null' });
        return;
      }
      const result = await orchestrator.rollbackTurnFromHistory(recon);
      this.opts.pendingStatusBar?.scheduleRefresh();
      this.opts.logger.info('historyPanel', 'rollback.applied', { sessionId, ...result });
      this.post({ type: 'session-action-result', sessionId, action: 'rollback', ok: true });
    } catch (err) {
      const message = (err as Error).message;
      this.opts.logger.warn('historyPanel', 'rollback.failed', { sessionId, err: message });
      this.post({ type: 'session-action-result', sessionId, action: 'rollback', ok: false, error: message });
    }
  }

  private async handleDelete(sessionId: string): Promise<void> {
    const confirm = this.opts.confirmDestructive ?? defaultConfirmDestructive;
    const confirmed = await confirm(
      'Delete from history',
      `Permanently remove session ${sessionId.slice(0, 8)} from the event log. The on-disk files (current state) are NOT affected. Cannot be undone.`,
      'Delete',
    );
    if (!confirmed) return;
    try {
      const { blobsDeleted } = await this.opts.history.deleteSession(sessionId);
      this.opts.pendingStatusBar?.scheduleRefresh();
      this.opts.logger.info('historyPanel', 'delete.applied', { sessionId, blobsDeleted });
      // Re-emit the session list so the webview refreshes the visible state.
      const sessions = await this.opts.history.listSessions();
      this.post({ type: 'init', sessions, root: this.opts.history.getRoot() });
      this.post({ type: 'session-action-result', sessionId, action: 'delete', ok: true });
    } catch (err) {
      const message = (err as Error).message;
      this.opts.logger.warn('historyPanel', 'delete.failed', { sessionId, err: message });
      this.post({ type: 'session-action-result', sessionId, action: 'delete', ok: false, error: message });
    }
  }

  /**
   * Trailing-edge debounce: any HistoryService change schedules a single
   * `listSessions → post(init)` after LIST_REFRESH_DEBOUNCE_MS. Subsequent
   * changes inside the debounce window coalesce into the same refresh.
   *
   * Safe across disposal: the timer is cleared in `onDidDispose`, and the
   * fired callback re-checks `this.panel` before touching the webview.
   */
  private scheduleSessionListRefresh(): void {
    const state = this.panel;
    if (!state) return;
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(async () => {
      const s = this.panel;
      if (s) delete s.refreshTimer;
      if (!this.panel) return;
      try {
        const sessions = await this.opts.history.listSessions();
        if (!this.panel) return;
        this.post({ type: 'init', sessions, root: this.opts.history.getRoot() });
      } catch (err) {
        this.opts.logger.warn('historyPanel', 'liveRefresh.failed', { err: String(err) });
      }
    }, HistoryPanelManager.LIST_REFRESH_DEBOUNCE_MS);
  }

  /**
   * v0.6 (A9): trailing-edge debounce for live insights recompute. Only armed
   * after the user has opened the Insights tab (caller gates on
   * `insightsRequested`). Recomputes and posts a fresh report; the aggregator's
   * memo keeps the cost to rescanning only changed sessions.
   */
  private scheduleInsightsRecompute(): void {
    const state = this.panel;
    if (!state) return;
    if (state.insightsRefreshTimer) return;
    state.insightsRefreshTimer = setTimeout(() => {
      const s = this.panel;
      if (s) delete s.insightsRefreshTimer;
      if (!this.panel) return;
      void this.handleLoadInsights();
    }, HistoryPanelManager.INSIGHTS_REFRESH_DEBOUNCE_MS);
  }

  private post(msg: HistoryHostToWebview): void {
    if (!this.panel) return;
    this.panel.pending.push(msg);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    const state = this.panel;
    if (!state || state.flushScheduled || !state.ready) return;
    state.flushScheduled = true;
    setImmediate(() => {
      const s = this.panel;
      if (!s) return;
      s.flushScheduled = false;
      const queue = s.pending.slice();
      s.pending.length = 0;
      for (const msg of queue) {
        s.panel.webview.postMessage(msg);
      }
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.opts.context.extensionUri, 'dist', 'webview', 'history', 'index.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src 'none'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Claude Code Review · History</title>
</head>
<body>
  <div id="root">Loading history…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // Helpers exposed for tests / future panels.
  /** Returns the most recently emitted events for a session (test helper). */
  async getEventsForTest(sessionId: string): Promise<HistoryEvent[]> {
    return this.opts.history.readEvents(sessionId);
  }
}

/**
 * β.0 (10.1.8c): default destructive-confirm implementation. Uses VS Code's
 * native modal warning dialog. Tests override via `HistoryPanelOptions.confirmDestructive`
 * to avoid the modal entirely.
 */
const defaultConfirmDestructive: ConfirmDestructive = async (title, detail, destructiveLabel) => {
  const choice = await vscode.window.showWarningMessage(
    title,
    { modal: true, detail },
    destructiveLabel,
  );
  return choice === destructiveLabel;
};
