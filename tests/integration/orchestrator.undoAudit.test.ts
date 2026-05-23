/**
 * Integration: orchestrator → HistoryService undo-event emission (FR-B0.7).
 *
 * Phase β.0 acceptance tests B0-11 and B0-12 (PHASE-BETA-NEXT.md §6.0).
 *
 * B0-11: per-hunk ↶ Undo emits a scope:'hunk' undo event with the
 *        correct path + hunkIdx and the post-undo content's SHA-256.
 * B0-12: session-level ↶ Undo last action (Option A) emits a single
 *        undo event whose scope matches the original action (hunk / file /
 *        turn) and whose postBlobs cover every affected file.
 *
 * We run the orchestrator against a real `HistoryService` rooted at a
 * tmp directory (same shape as `tests/integration/history.service.test.ts`).
 * The on-disk JSONL is the source of truth — we read it back and assert.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import { HistoryService } from '../../src/history/historyService.js';
import { sha256Hex } from '../../src/history/historyBlobs.js';
import type { UndoEvent } from '../../src/history/historyEvents.js';
import {
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from '../../src/types.js';

class NoopPanel implements PanelGateway {
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_sessionId: SessionId, _filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_sessionId: SessionId, _filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict(_sessionId: SessionId, _filePath: AbsPath, _attemptedHunkIndex: number, _conflictingHunks: number[]) {}
  postUndoStackDepth(_sid: SessionId, _depth: number) {}
  postRejectionDrafts(_sid: SessionId, _drafts: ReadonlyArray<{ filePath: string; relPath: string; hunkIdx: number; reason: string; ts: number }>) { void _drafts; }
  postBuildSignal(_sid: SessionId, _signal: import('../../src/types.js').BuildSignal) { void _signal; }
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
}

let workspaceDir: string;
let homeDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-undo-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-undo-ws-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const SID = 'undo-audit-sid';
const CWD = process.platform === 'win32' ? 'C:\\undo-audit' : '/undo-audit';
const REL = 'src/file.ts';

function buildHarness() {
  const logger = new Logger('test', 'error');
  const history = new HistoryService({
    scope: 'workspace',
    workspaceRoot: workspaceDir,
    logger,
    enabled: true,
  });
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();

  // In-memory disk: every write updates `live`; reads return `live`.
  let live = '';
  const writes: Array<{ path: string; content: string }> = [];
  const orchestrator = new ReviewOrchestrator({
    store,
    panel,
    logger,
    history,
    writeFile: async (p, c) => { live = c; writes.push({ path: p, content: c }); },
    readFile: async () => live,
  });

  return { orchestrator, store, history, writes, setLive: (s: string) => { live = s; }, getLive: () => live };
}

async function seedAndOpen(
  harness: ReturnType<typeof buildHarness>,
  before: string,
  after: string,
): Promise<AbsPath> {
  const resolved = await harness.store.captureOriginal(SID, CWD, REL);
  if (!resolved) throw new Error('captureOriginal failed');
  harness.store.get(SID)!.originals.set(resolved, before);
  harness.store.recordTouched(SID, CWD, REL);
  // Open a turn so currentTurnId is set (mirrors PreToolUse hook behaviour).
  harness.store.beginTurnIfNeeded(SID, CWD);
  // Seed live disk with Claude's post-edit content.
  harness.setLive(after);
  // Trigger Stop → debounced openReview → endTurn before openReview.
  harness.orchestrator.handleStop(SID, false, null);
  await new Promise((r) => setTimeout(r, 350));
  return resolved;
}

async function readUndoEvents(): Promise<UndoEvent[]> {
  const dir = path.join(workspaceDir, '.claude', 'review-history', 'sessions');
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: UndoEvent[] = [];
  for (const f of files) {
    if (!f.startsWith(SID + '.')) continue;
    const raw = await fs.readFile(path.join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.kind === 'undo') out.push(ev as UndoEvent);
      } catch { /* tolerant */ }
    }
  }
  return out;
}

describe('FR-B0.7 — orchestrator emits undo events into the history log', () => {
  it('B0-11: per-hunk Undo emits an undo event with scope=hunk and correct hunkIdx', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'line 5 MODIFIED';
    afterArr[25] = 'line 25 MODIFIED';
    const after = afterArr.join('\n');
    const harness = buildHarness();
    const abs = await seedAndOpen(harness, before, after);

    // Reject hunk 0 first so undo has something to revert.
    await harness.orchestrator.handleHunkAction(SID, abs, 0, 'reject');
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks[0].status).toBe('rejected');

    // Per-hunk ↶ Undo (M9.2.9 path) — the FR-B0.7 emission point.
    await harness.orchestrator.handleUndoHunkDecision(SID, abs, 0);

    // Give the fire-and-forget recordUndo a tick to land on disk.
    await new Promise((r) => setTimeout(r, 50));

    const undos = await readUndoEvents();
    expect(undos.length).toBe(1);
    const ev = undos[0];
    expect(ev.scope).toBe('hunk');
    expect(ev.target.path).toBe('src/file.ts');
    expect(ev.target.hunkIdx).toBe(0);

    // postBlobs must include exactly the affected file's relPath, keyed by
    // the SHA-256 of the post-undo content.
    const postContent = harness.orchestrator.getSession(SID)!.files[0].after;
    expect(Object.keys(ev.postBlobs)).toEqual(['src/file.ts']);
    expect(ev.postBlobs['src/file.ts']).toBe(sha256Hex(postContent));
  });

  it('B0-12 (file): bulk reject-all → ↶ Undo last action emits scope=file', async () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'X5';
    afterArr[25] = 'X25';
    afterArr[45] = 'X45';
    const after = afterArr.join('\n');
    const harness = buildHarness();
    const abs = await seedAndOpen(harness, before, after);

    await harness.orchestrator.handleBulk(SID, 'file', 'reject', abs);
    expect(harness.orchestrator.getSession(SID)!.files[0].hunks.every((h) => h.status === 'rejected')).toBe(true);

    await harness.orchestrator.handleUndoLastAction(SID);
    await new Promise((r) => setTimeout(r, 50));

    const undos = await readUndoEvents();
    expect(undos.length).toBe(1);
    expect(undos[0].scope).toBe('file');
    expect(undos[0].target.path).toBe('src/file.ts');
    // No hunkIdx for file-scope.
    expect(undos[0].target.hunkIdx).toBeUndefined();
    // Post-undo content matches Claude's after.
    expect(Object.keys(undos[0].postBlobs)).toEqual(['src/file.ts']);
    expect(undos[0].postBlobs['src/file.ts']).toBe(sha256Hex(after));
  });

  it('B0-12 (turn): bulk session reject-all → ↶ Undo emits scope=turn', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'mod-5';
    afterArr[25] = 'mod-25';
    const after = afterArr.join('\n');
    const harness = buildHarness();
    const abs = await seedAndOpen(harness, before, after);

    // Bulk session-scope reject (single file in this fixture, but the
    // emitted event scope reflects the user's action, not the file count).
    await harness.orchestrator.handleBulk(SID, 'session', 'reject');
    await harness.orchestrator.handleUndoLastAction(SID);
    await new Promise((r) => setTimeout(r, 50));

    const undos = await readUndoEvents();
    expect(undos.length).toBe(1);
    expect(undos[0].scope).toBe('turn');
    // turn-scope omits path/hunkIdx.
    expect(undos[0].target.path).toBeUndefined();
    expect(undos[0].target.hunkIdx).toBeUndefined();
    expect(undos[0].postBlobs['src/file.ts']).toBe(sha256Hex(after));
    // Reference abs to silence unused-binding warning on the test.
    void abs;
  });
});
