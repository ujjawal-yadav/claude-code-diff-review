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
import {
  HistoryHostToWebview,
  parseHistoryWebviewMessage,
} from './messages.js';

export interface HistoryPanelOptions {
  context: vscode.ExtensionContext;
  logger: Logger;
  history: HistoryService;
}

interface PanelState {
  panel: vscode.WebviewPanel;
  pending: HistoryHostToWebview[];
  flushScheduled: boolean;
  ready: boolean;
}

export class HistoryPanelManager {
  private panel: PanelState | undefined;

  constructor(private readonly opts: HistoryPanelOptions) {}

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
    };
    this.panel = state;

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
      () => { this.panel = undefined; },
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
    }
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
