/**
 * v0.4 (A8 cheap) — integration test for `handleRenameGroup`.
 *
 * Coverage:
 *   - bulk accept across files: every group member's hunk flips to accepted
 *   - bulk reject across files: every member rejects + writes the before
 *     content
 *   - one undo unwinds the group (snapshot per hunk; ↶ Undo last action
 *     pops one at a time today — locked decision in plan, deferred to a
 *     true "group" snapshot)
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { HistoryService } from '../../src/history/historyService.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

class NoopPanel implements PanelGateway {
  async openOrFocus(_s: SessionReview) {}
  postFileUpdated() {}
  postHunkApplied() {}
  postSetConflict() {}
  postSessionCompleted(_sid: SessionId, _m: SessionMetrics) {}
  postUndoStackDepth() {}
  postRejectionDrafts() {}
  postBuildSignal(_sid: SessionId, _signal: import('../../src/types.js').BuildSignal) { void _signal; }
  close(_sid: SessionId) {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rename-test-'));
  const logger = new Logger('test', 'error');
  const history = new HistoryService({ scope: 'workspace', workspaceRoot: root, enabled: true, logger });
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();
  const liveByPath = new Map<string, string>();
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger, history,
    writeFile: async (p, c) => { liveByPath.set(p, c); },
    readFile: async (p) => liveByPath.get(p) ?? '',
  });
  return { root, logger, history, store, panel, orchestrator, liveByPath };
}

const CWD = process.platform === 'win32' ? 'C:\\rename-int' : '/rename-int';
const SID = 'rename-sid-1';

async function seedFiles(
  h: Awaited<ReturnType<typeof setup>>,
  spec: ReadonlyArray<{ relPath: string; before: string; after: string }>,
): Promise<AbsPath[]> {
  h.store.beginTurnIfNeeded(SID, CWD, 'claude-code');
  const resolved: AbsPath[] = [];
  for (const f of spec) {
    const abs = await h.store.captureOriginal(SID, CWD, f.relPath);
    if (!abs) throw new Error(`captureOriginal failed for ${f.relPath}`);
    h.store.get(SID)!.originals.set(abs, f.before);
    h.store.recordTouched(SID, CWD, f.relPath);
    h.liveByPath.set(abs, f.after);
    resolved.push(abs);
  }
  await h.orchestrator.handleStop(SID, false, null);
  await new Promise((r) => setTimeout(r, 350));
  return resolved;
}

describe('orchestrator — handleRenameGroup', () => {
  it('bulk accept marks every member of the rename group as accepted', async () => {
    const h = await setup();
    try {
      // Three files, same `foo` → `bar` rename in each → forms a group of 3.
      const resolved = await seedFiles(h, [
        { relPath: 'a.ts', before: 'foo(1)\n', after: 'bar(1)\n' },
        { relPath: 'b.ts', before: 'foo(2)\n', after: 'bar(2)\n' },
        { relPath: 'c.ts', before: 'foo(3)\n', after: 'bar(3)\n' },
      ]);

      const review = h.orchestrator.getSession(SID)!;
      expect(review.renameGroups).toBeDefined();
      const groupId = Object.keys(review.renameGroups!)[0]!;
      expect(groupId).toBe('foo->bar');
      expect(review.renameGroups![groupId]!.length).toBe(3);

      await h.orchestrator.handleRenameGroup(SID, groupId, 'accept');

      // All hunks accepted.
      const after = h.orchestrator.getSession(SID)!;
      for (const f of after.files) {
        for (const hk of f.hunks) {
          expect(hk.status).toBe('accepted');
        }
      }
      // Disk shows the `bar` content (Claude's edit) — accept is a no-op on
      // disk when initial-all-applied, but we can confirm via liveByPath.
      for (const abs of resolved) {
        expect(h.liveByPath.get(abs)).toContain('bar');
      }
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('bulk reject reverts every member to its before content', async () => {
    const h = await setup();
    try {
      const resolved = await seedFiles(h, [
        { relPath: 'a.ts', before: 'foo(1)\n', after: 'bar(1)\n' },
        { relPath: 'b.ts', before: 'foo(2)\n', after: 'bar(2)\n' },
        { relPath: 'c.ts', before: 'foo(3)\n', after: 'bar(3)\n' },
      ]);

      const review = h.orchestrator.getSession(SID)!;
      const groupId = Object.keys(review.renameGroups!)[0]!;

      await h.orchestrator.handleRenameGroup(SID, groupId, 'reject');

      const after = h.orchestrator.getSession(SID)!;
      for (const f of after.files) {
        for (const hk of f.hunks) {
          expect(hk.status).toBe('rejected');
        }
      }
      for (const abs of resolved) {
        const content = h.liveByPath.get(abs);
        expect(content).toContain('foo');
        expect(content).not.toContain('bar');
      }
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('groups with fewer than 3 members are NOT surfaced (heuristic minimum)', async () => {
    const h = await setup();
    try {
      // Only 2 files share the rename — group size < 3 → no group surfaced.
      await seedFiles(h, [
        { relPath: 'a.ts', before: 'foo(1)\n', after: 'bar(1)\n' },
        { relPath: 'b.ts', before: 'foo(2)\n', after: 'bar(2)\n' },
      ]);
      const review = h.orchestrator.getSession(SID)!;
      expect(review.renameGroups).toBeUndefined();
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
