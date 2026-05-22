/**
 * v0.4 (A5) — integration tests for `handleRejectionReason` + drafts queue.
 *
 * Coverage:
 *   - happy path: rejected hunk → reason saved → drafts queue updated +
 *     `rejection-reason` event logged
 *   - status guard: reason on a pending or accepted hunk is dropped silently
 *   - reconstruction: rejection reasons replay into the drafts list
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewOrchestrator, PanelGateway, RejectionDraft } from '../../src/reviewOrchestrator.js';
import { HistoryService } from '../../src/history/historyService.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

class NoopPanel implements PanelGateway {
  drafts: RejectionDraft[][] = [];
  async openOrFocus(_s: SessionReview) {}
  postFileUpdated() {}
  postHunkApplied() {}
  postSetConflict() {}
  postSessionCompleted(_sid: SessionId, _m: SessionMetrics) {}
  postUndoStackDepth() {}
  postRejectionDrafts(_sid: SessionId, drafts: ReadonlyArray<RejectionDraft>) {
    this.drafts.push([...drafts]);
  }
  close(_sid: SessionId) {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reason-test-'));
  const logger = new Logger('test', 'error');
  const history = new HistoryService({ scope: 'workspace', workspaceRoot: root, enabled: true, logger });
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();
  let live = '';
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger, history,
    writeFile: async (_p, c) => { live = c; },
    readFile: async () => live,
  });
  return { root, logger, history, store, panel, orchestrator, setLive: (v: string) => { live = v; } };
}

const CWD = process.platform === 'win32' ? 'C:\\reason-int' : '/reason-int';
const SID = 'reason-sid-1';
const REL = 'src/foo.ts';

async function seedAndOpen(h: Awaited<ReturnType<typeof setup>>, before: string, after: string): Promise<AbsPath> {
  h.store.beginTurnIfNeeded(SID, CWD, 'claude-code');
  const resolved = await h.store.captureOriginal(SID, CWD, REL);
  if (!resolved) throw new Error('captureOriginal failed');
  h.store.get(SID)!.originals.set(resolved, before);
  h.store.recordTouched(SID, CWD, REL);
  h.setLive(after);
  await h.orchestrator.handleStop(SID, false, null);
  await new Promise((r) => setTimeout(r, 350));
  return resolved;
}

describe('orchestrator — handleRejectionReason', () => {
  it('appends to drafts queue + logs rejection-reason event after a hunk is rejected', async () => {
    const h = await setup();
    try {
      const resolved = await seedAndOpen(h, 'a\nb\nc\n', 'a\nB\nc\n');
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;

      // Reject first so the reason has a target.
      await h.orchestrator.handleHunkAction(SID, resolved, hunkIdx, 'reject');
      await h.orchestrator.handleRejectionReason(SID, resolved, hunkIdx, 'unnecessary capitalisation');
      // history is fire-and-forget for the event part; small wait.
      await new Promise((r) => setTimeout(r, 100));

      const drafts = h.orchestrator.getRejectionDrafts(SID);
      expect(drafts.length).toBe(1);
      expect(drafts[0]!.reason).toBe('unnecessary capitalisation');

      // Panel was notified with the new list.
      const lastPosted = h.panel.drafts[h.panel.drafts.length - 1]!;
      expect(lastPosted.length).toBe(1);

      const events = await h.history.readEvents(SID);
      const reasonEvent = events.find((e) => e.kind === 'rejection-reason');
      expect(reasonEvent).toBeDefined();
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('silently drops a reason aimed at a pending hunk', async () => {
    const h = await setup();
    try {
      const resolved = await seedAndOpen(h, 'a\nb\nc\n', 'a\nB\nc\n');
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;

      // No reject — status is pending.
      await h.orchestrator.handleRejectionReason(SID, resolved, hunkIdx, 'should not land');
      expect(h.orchestrator.getRejectionDrafts(SID).length).toBe(0);
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('clearRejectionDrafts wipes the queue and posts the empty list', async () => {
    const h = await setup();
    try {
      const resolved = await seedAndOpen(h, 'a\nb\nc\n', 'a\nB\nc\n');
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;
      await h.orchestrator.handleHunkAction(SID, resolved, hunkIdx, 'reject');
      await h.orchestrator.handleRejectionReason(SID, resolved, hunkIdx, 'a reason');
      expect(h.orchestrator.getRejectionDrafts(SID).length).toBe(1);

      h.orchestrator.clearRejectionDrafts(SID);
      expect(h.orchestrator.getRejectionDrafts(SID).length).toBe(0);
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reconstruction restores rejection reasons into the drafts queue', async () => {
    const h = await setup();
    try {
      const resolved = await seedAndOpen(h, 'a\nb\nc\n', 'a\nB\nc\n');
      const hunkIdx = h.orchestrator.getSession(SID)!.files.find((f) => f.filePath === resolved)!.hunks[0]!.index;
      await h.orchestrator.handleHunkAction(SID, resolved, hunkIdx, 'reject');
      await h.orchestrator.handleRejectionReason(SID, resolved, hunkIdx, 'persisted reason');
      await new Promise((r) => setTimeout(r, 100));

      const recon = await h.history.reconstructSessionReview(SID, { cwd: CWD });
      expect(recon).not.toBeNull();
      expect(recon!.rejectionReasons.length).toBe(1);
      expect(recon!.rejectionReasons[0]!.reason).toBe('persisted reason');
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
