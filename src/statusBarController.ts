import * as vscode from 'vscode';

import { SessionReview } from './types.js';

/**
 * Status bar pending-hunks indicator (TRD §5.10 / §5.7 stub).
 *
 * Shows the count of un-decided hunks across all active sessions. Click
 * focuses (or opens, if dismissed) the latest review panel.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;
  /** Snapshot per sessionId (we sum across all active sessions). */
  private readonly counts = new Map<string, number>();

  constructor(context: vscode.ExtensionContext, openCommand: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = openCommand;
    context.subscriptions.push(this.item);
    this.render();
  }

  update(review: SessionReview): void {
    const pending = review.files.reduce(
      (sum, f) => sum + f.hunks.filter((h) => h.status === 'pending').length,
      0,
    );
    if (pending === 0) {
      this.counts.delete(review.sessionId);
    } else {
      this.counts.set(review.sessionId, pending);
    }
    this.render();
  }

  clear(sessionId: string): void {
    this.counts.delete(sessionId);
    this.render();
  }

  private render(): void {
    const total = Array.from(this.counts.values()).reduce((a, b) => a + b, 0);
    if (total === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(diff) ${total} hunk${total === 1 ? '' : 's'} pending`;
    this.item.tooltip = 'Claude Code Review — open panel';
    this.item.show();
  }
}
