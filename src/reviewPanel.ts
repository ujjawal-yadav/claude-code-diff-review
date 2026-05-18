import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import { Logger } from './logger.js';
import { parseWebviewMessage, HostToWebview, WebviewToHost } from './messages.js';
import {
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from './types.js';
import { ReviewOrchestrator, PanelGateway } from './reviewOrchestrator.js';
import { ChatService } from './chatService.js';

/**
 * Webview lifecycle manager (TRD §5.7).
 *
 * One panel per `sessionId`. CSP is strict: no inline scripts, no `eval`,
 * `connect-src 'none'` so the webview cannot make network calls. Inbound
 * messages are validated against the discriminated union before any
 * side-effect.
 *
 * Streaming chat deltas (M4) are coalesced via `setImmediate` so we don't
 * saturate the structured-clone IPC channel.
 */

interface PanelEntry {
  panel: vscode.WebviewPanel;
  pendingPosts: HostToWebview[];
  flushScheduled: boolean;
  /**
   * True once the webview has signalled `{type: 'ready'}`. Until then we
   * buffer outbound messages — the browser MessageEvent does not queue,
   * so posting before the React tree's listener is registered drops the
   * message silently.
   */
  webviewReady: boolean;
}

export interface ReviewPanelOptions {
  context: vscode.ExtensionContext;
  logger: Logger;
  /** Set after construction to break the circular dep with the orchestrator. */
  orchestrator?: ReviewOrchestrator | undefined;
  defaultViewType: 'split' | 'unified';
}

export class ReviewPanelManager implements PanelGateway {
  private readonly panels = new Map<SessionId, PanelEntry>();
  private orchestrator: ReviewOrchestrator | undefined;
  private chatService: ChatService | undefined;

  constructor(private readonly opts: ReviewPanelOptions) {
    this.orchestrator = opts.orchestrator;
  }

  setOrchestrator(orchestrator: ReviewOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  setChatService(chat: ChatService): void {
    this.chatService = chat;
  }

  // PanelGateway --------------------------------------------------------------

  async openOrFocus(session: SessionReview): Promise<void> {
    const existing = this.panels.get(session.sessionId);
    if (existing) {
      existing.panel.reveal(undefined, true);
      // Drop any stale queued messages — the new init supersedes them.
      // The flush will pick up only what's relevant for the current state.
      existing.pendingPosts.length = 0;
      this.post(session.sessionId, { type: 'init', session, viewType: this.opts.defaultViewType });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      `claudeReview.session.${session.sessionId}`,
      titleFor(session),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.opts.context.extensionUri, 'dist', 'webview')],
      },
    );

    const entry: PanelEntry = { panel, pendingPosts: [], flushScheduled: false, webviewReady: false };
    this.panels.set(session.sessionId, entry);

    panel.webview.html = this.renderHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      (raw) => this.onMessage(session.sessionId, raw),
      undefined,
      this.opts.context.subscriptions,
    );

    panel.onDidDispose(
      () => this.onDispose(session.sessionId),
      undefined,
      this.opts.context.subscriptions,
    );

    // Send init after the webview has signalled `ready` (see onMessage),
    // but also queue here in case `ready` already raced past.
    entry.pendingPosts.push({ type: 'init', session, viewType: this.opts.defaultViewType });
    this.scheduleFlush(entry);
  }

  postFileUpdated(filePath: AbsPath, file: FileReview): void {
    const sid = this.findSessionForFile(filePath);
    if (!sid) return;
    this.post(sid, { type: 'file-updated', filePath, file });
  }

  postHunkApplied(filePath: AbsPath, hunkIndex: number, status: HunkStatus): void {
    const sid = this.findSessionForFile(filePath);
    if (!sid) return;
    this.post(sid, { type: 'hunk-applied', filePath, hunkIndex, action: status });
  }

  postSetConflict(filePath: AbsPath, attemptedHunkIndex: number, conflictingHunks: number[]): void {
    const sid = this.findSessionForFile(filePath);
    if (!sid) return;
    this.post(sid, { type: 'set-conflict-warning', filePath, attemptedHunkIndex, conflictingHunks });
  }

  postUndoStackDepth(sessionId: SessionId, depth: number): void {
    this.post(sessionId, { type: 'undo-stack-changed', depth });
  }

  postSessionCompleted(sessionId: SessionId, metrics: SessionMetrics): void {
    this.post(sessionId, { type: 'session-completed', sessionId, metrics });
  }

  close(sessionId: SessionId): void {
    const entry = this.panels.get(sessionId);
    if (entry) {
      entry.panel.dispose();
    }
  }

  postChatDelta(sessionId: SessionId, chatId: string, text: string): void {
    this.post(sessionId, { type: 'chat-delta', chatId, text });
  }

  postChatDone(sessionId: SessionId, chatId: string, usage: { inputTokens: number; outputTokens: number }): void {
    this.post(sessionId, { type: 'chat-done', chatId, usage });
  }

  postChatError(
    sessionId: SessionId,
    chatId: string,
    error: { kind: string; message: string; retriable: boolean },
  ): void {
    this.post(sessionId, { type: 'chat-error', chatId, error });
  }

  // -- internals ---------------------------------------------------------------

  private post(sessionId: SessionId, msg: HostToWebview): void {
    const entry = this.panels.get(sessionId);
    if (!entry) return;
    entry.pendingPosts.push(msg);
    this.scheduleFlush(entry);
  }

  private scheduleFlush(entry: PanelEntry): void {
    // The webview must have signalled `ready` before we flush — otherwise
    // the React tree's `message` listener isn't registered yet and the post
    // is dropped. The `ready` handler in `dispatch()` calls scheduleFlush
    // again to drain anything queued up to that point.
    if (!entry.webviewReady) return;
    if (entry.flushScheduled) return;
    entry.flushScheduled = true;
    setImmediate(() => {
      entry.flushScheduled = false;
      const batch = entry.pendingPosts.splice(0);
      for (const msg of batch) {
        try { entry.panel.webview.postMessage(msg); }
        catch (err) { this.opts.logger.warn('panel', 'post.failed', { err: String(err) }); }
      }
    });
  }

  private async onMessage(sessionId: SessionId, raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (!msg) {
      this.opts.logger.warn('panel', 'msg.invalid', { sessionId });
      return;
    }
    if (!this.orchestrator) return;

    try {
      await this.dispatch(sessionId, msg);
    } catch (err) {
      this.opts.logger.error('panel', 'dispatch.error', { sessionId, type: msg.type, err: String(err) });
    }
  }

  private async dispatch(sessionId: SessionId, msg: WebviewToHost): Promise<void> {
    const o = this.orchestrator!;
    switch (msg.type) {
      case 'ready': {
        // Webview is mounted and listening. Mark ready and drain anything
        // queued during the race window between panel creation and React
        // mount. If the webview reloads (e.g., user moves the tab between
        // editor groups), we'll get another `ready` and re-flush.
        const entry = this.panels.get(sessionId);
        if (entry) {
          entry.webviewReady = true;
          this.scheduleFlush(entry);
        }
        break;
      }
      case 'accept-hunk':
      case 'reject-hunk':
        await o.handleHunkAction(
          sessionId,
          msg.filePath,
          msg.hunkIndex,
          msg.type === 'accept-hunk' ? 'accept' : 'reject',
        );
        break;
      case 'accept-file':
      case 'reject-file':
        await o.handleBulk(sessionId, 'file', msg.type === 'accept-file' ? 'accept' : 'reject', msg.filePath);
        break;
      case 'accept-all':
      case 'reject-all':
        await o.handleBulk(sessionId, 'session', msg.type === 'accept-all' ? 'accept' : 'reject');
        break;
      case 'set-view-type':
        this.post(sessionId, { type: 'view-type', viewType: msg.viewType });
        break;
      case 'set-api-key':
        await vscode.commands.executeCommand('claudeReview.setApiKey');
        break;
      case 'set-oauth-token':
        await vscode.commands.executeCommand('claudeReview.setOAuthToken');
        break;
      case 'use-claude-code-auth':
        await vscode.commands.executeCommand('claudeReview.useClaudeCodeAuth');
        break;
      case 'revert-file-to-snapshot':
        await o.revertFileToSnapshot(sessionId, msg.filePath);
        break;
      case 'undo-hunk-decision':
        // Phase α M9.2.9: undo the latest decision on this hunk (flips its
        // set membership and marks the hunk back to 'pending'). Within
        // the current panel session only — cross-turn undo is Phase β.
        await o.handleUndoHunkDecision(sessionId, msg.filePath, msg.hunkIndex);
        break;
      case 'undo-last-action':
        // Option A: editor-style Ctrl+Z over the action history.
        await o.handleUndoLastAction(sessionId);
        break;
      case 'log':
        this.opts.logger[msg.level]('webview', 'log', { msg: msg.msg });
        break;
      case 'chat-message':
        if (!this.chatService) {
          this.opts.logger.warn('panel', 'chat.no-service');
          return;
        }
        await this.chatService.start({
          sessionId,
          filePath: msg.filePath,
          hunkIndex: msg.hunkIndex,
          message: msg.message,
          chatId: msg.chatId,
        });
        break;
      case 'chat-cancel':
        this.chatService?.cancel(msg.chatId);
        break;
    }
  }

  private onDispose(sessionId: SessionId): void {
    this.panels.delete(sessionId);
    this.opts.logger.info('panel', 'disposed', { sessionId });
    this.chatService?.cancelSession(sessionId);
    this.orchestrator?.dismissSession(sessionId);
  }

  private findSessionForFile(filePath: AbsPath): SessionId | undefined {
    void filePath;
    // Right now there's at most one open session per panel. Walk the panels
    // and return the only candidate. (Real multi-session lookup happens via
    // the orchestrator; this function is only used as a routing convenience
    // when actions originate host-side.)
    for (const sid of this.panels.keys()) return sid;
    return undefined;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.opts.context.extensionUri, 'dist', 'webview', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.opts.context.extensionUri, 'dist', 'webview', 'index.css'),
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
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Code Review</title>
</head>
<body>
  <div id="root">Loading…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function titleFor(session: SessionReview): string {
  const fileWord = session.files.length === 1 ? 'file' : 'files';
  return `Review · ${session.sessionId.slice(0, 7)} · ${session.files.length} ${fileWord}`;
}
