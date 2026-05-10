import * as vscode from 'vscode';

import { FileReview, FileStatus, SessionReview } from './types.js';

/**
 * Minimal SCM Source Control provider (TRD §5.10).
 *
 * One `SourceControl` per session. Files are grouped by review status:
 * pending / accepted / rejected / partial. Click-on-resource focuses the
 * review panel via the `claudeReview.openPanel` command.
 *
 * v1 only surfaces file-level state. v1.1 may add hunk-level resources.
 */

interface PerSession {
  sourceControl: vscode.SourceControl;
  groups: Record<FileStatus, vscode.SourceControlResourceGroup>;
}

const STATUSES: FileStatus[] = ['pending', 'partial', 'rejected', 'accepted'];

export class ClaudeReviewScmProvider {
  private readonly sessions = new Map<string, PerSession>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  upsertSession(review: SessionReview): void {
    let entry = this.sessions.get(review.sessionId);
    if (!entry) entry = this.create(review);
    this.populate(entry, review);
  }

  removeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.sourceControl.dispose();
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const e of this.sessions.values()) e.sourceControl.dispose();
    this.sessions.clear();
  }

  private create(review: SessionReview): PerSession {
    const sourceControl = vscode.scm.createSourceControl(
      `claudeReview.${review.sessionId}`,
      `Claude Review · ${review.sessionId.slice(0, 7)}`,
      vscode.Uri.file(review.cwd),
    );
    const groups = {} as Record<FileStatus, vscode.SourceControlResourceGroup>;
    for (const status of STATUSES) {
      const g = sourceControl.createResourceGroup(`claudeReview.${review.sessionId}.${status}`, labelFor(status));
      g.hideWhenEmpty = true;
      groups[status] = g;
    }
    const entry: PerSession = { sourceControl, groups };
    this.sessions.set(review.sessionId, entry);
    this.context.subscriptions.push({ dispose: () => entry.sourceControl.dispose() });
    return entry;
  }

  private populate(entry: PerSession, review: SessionReview): void {
    const buckets: Record<FileStatus, vscode.SourceControlResourceState[]> = {
      pending: [], partial: [], rejected: [], accepted: [],
    };
    for (const file of review.files) {
      buckets[file.status].push(toResource(file));
    }
    for (const status of STATUSES) {
      entry.groups[status].resourceStates = buckets[status];
    }
  }
}

function labelFor(status: FileStatus): string {
  switch (status) {
    case 'pending':  return 'Pending';
    case 'partial':  return 'Partially reviewed';
    case 'rejected': return 'Rejected';
    case 'accepted': return 'Accepted';
  }
}

function toResource(file: FileReview): vscode.SourceControlResourceState {
  const counts = countByStatus(file);
  const decoration: vscode.SourceControlResourceDecorations = {
    tooltip: `${file.relPath} — ${counts.accepted} accepted / ${counts.rejected} rejected / ${counts.pending} pending`,
    strikeThrough: file.status === 'rejected',
    faded: file.status === 'accepted',
  };
  return {
    resourceUri: vscode.Uri.file(file.filePath),
    decorations: decoration,
    command: {
      title: 'Open review panel',
      command: 'claudeReview.openPanel',
    },
  };
}

function countByStatus(file: FileReview): { accepted: number; rejected: number; pending: number } {
  let accepted = 0, rejected = 0, pending = 0;
  for (const h of file.hunks) {
    if (h.status === 'accepted') accepted++;
    else if (h.status === 'rejected') rejected++;
    else pending++;
  }
  return { accepted, rejected, pending };
}
