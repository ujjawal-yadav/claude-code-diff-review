import * as vscode from 'vscode';

import type { HistoryService } from './history/historyService.js';
import type { Logger } from './logger.js';

/**
 * β.0 (10.1.6) — Pending-reviews indicator backed by the event log.
 *
 * Sibling of `StatusBarController` (NOT an extension of it). Different data
 * source and different lifecycle:
 *
 *   - `StatusBarController` reflects live-session pending counts (data source:
 *     `ReviewOrchestrator` state, updated synchronously per hunk action).
 *
 *   - `PendingStatusBar` reflects RECOVERABLE-session pending counts (data
 *     source: `HistoryService.getPendingReviewsSummary`, refreshed lazily
 *     via debounce after every event-log write).
 *
 * The two items coexist on the right side of the status bar with distinct
 * priorities so the user can see both at a glance. Clicking this item invokes
 * the `claudeReview.openPanel` command, which 10.1.7 upgrades to surface the
 * "Resume / Open History / Dismiss" prompt when the in-memory orchestrator is
 * empty but the event log has unfinished sessions.
 *
 * Refresh model
 * -------------
 * `scheduleRefresh()` debounces multiple recompute requests within
 * `REFRESH_DEBOUNCE_MS` into a single `refresh()` call. The orchestrator's
 * `onChange` callback (already wired for CodeLens) fires on every hunk action,
 * bulk action, undo, and session lifecycle event — that's where the debounced
 * scheduler hooks. Eager `refresh()` is called from activation, after
 * `adoptReconstructed`, and after a History panel action lands.
 */
export class PendingStatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | null = null;
  private refreshScheduled = false;
  private disposed = false;

  /** Debounce window: aligns with HistoryService's 1s pending-summary cache. */
  private static readonly REFRESH_DEBOUNCE_MS = 1_000;

  constructor(
    context: vscode.ExtensionContext,
    private readonly history: HistoryService,
    private readonly logger: Logger,
  ) {
    // Priority 99 places this just below the live-session indicator (priority
    // 100) so the visual order is: [live pending] [history pending].
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = 'claudeReview.openPanel';
    context.subscriptions.push(this.item);
    // Hidden by default; first refresh decides whether to show.
    void this.refresh();
  }

  /**
   * Schedule a recompute within `REFRESH_DEBOUNCE_MS`. Multiple calls within
   * the window coalesce to one `refresh()`. Safe to call from hot paths
   * (orchestrator `onChange`, post-Stop, every hunk decision).
   */
  scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    this.timer = setTimeout(() => {
      this.refreshScheduled = false;
      this.timer = null;
      void this.refresh();
    }, PendingStatusBar.REFRESH_DEBOUNCE_MS);
  }

  /**
   * Eager recompute. Read the current pending summary, update the item.
   * Best-effort: any error is logged and leaves the prior state intact.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const summary = await this.history.getPendingReviewsSummary();
      if (summary.totalPendingHunks === 0) {
        this.item.hide();
        return;
      }
      const sessionsLabel = summary.totalSessions === 1 ? 'session' : 'sessions';
      const hunksLabel = summary.totalPendingHunks === 1 ? 'hunk' : 'hunks';
      this.item.text = `$(history) ${summary.totalPendingHunks} ${hunksLabel} pending`;
      const lines = summary.sessions
        .map((s) => {
          const idShort = s.sessionId.slice(0, 8);
          const ago = humanizeAgo(s.lastEventAt);
          return `  · ${idShort} — ${s.pendingCount}/${s.totalCount} hunks (${ago})`;
        })
        .join('\n');
      const tooltip = new vscode.MarkdownString(
        `**${summary.totalSessions} ${sessionsLabel}** with pending review\n\n${lines}\n\nClick to resume the most recent.`,
      );
      tooltip.isTrusted = false;
      this.item.tooltip = tooltip;
      this.item.show();
    } catch (err) {
      this.logger.warn('pendingStatusBar', 'refresh.failed', { err: String(err) });
    }
  }

  /** Force-hide regardless of cache state. Useful in tests. */
  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.item.dispose();
  }
}

/**
 * Compact human-readable "time ago" for tooltips. Returns e.g. "just now",
 * "5m ago", "2h ago", "3d ago". Bounded — no fancy locale handling needed
 * for the status bar surface.
 */
function humanizeAgo(ts: number): string {
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
