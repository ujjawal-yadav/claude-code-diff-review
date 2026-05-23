/**
 * Phase β.0 (10.1.4): adoptReconstructed end-to-end + round-trip equivalence.
 *
 * Maps to acceptance IDs:
 *   B0-7: resume e2e from crash (orchestrator empty + history log full → adopt)
 *   B0-8: resume e2e from explicit-close (session dismissed → re-open via adopt)
 *
 * Strategy
 * --------
 * The round-trip harness is the verification surface:
 *   1. Run a fixture through a live orchestrator → capture projection A
 *   2. Build a fresh orchestrator + SnapshotStore using the same history root
 *   3. reconstructSessionReview → adoptReconstructed → capture projection B
 *   4. expect(B).toEqual(A) — every field reconstruct/adopt knows about
 *
 * A `SerializableProjection` strips Map/Set objects so deep-equal works.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import { HistoryService } from '../../src/history/historyService.js';
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
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-adopt-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-adopt-ws-'));
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

/** Strip nondeterministic / volatile fields so deep-equal works across instances. */
function projectOrchestratorState(orch: ReviewOrchestrator, sid: string) {
  const session = orch.getSession(sid);
  if (!session) return null;
  // Sort files by relPath for deterministic comparison.
  const files = [...session.files]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((f) => ({
      relPath: f.relPath,
      before: f.before,
      after: f.after,
      isNew: f.isNew,
      isDeleted: f.isDeleted,
      isBinary: f.isBinary,
      // warnings may differ (live has no drift; adopted may have external-edit
      // if drift was simulated). Test-side decides whether to include.
      warnings: [...f.warnings].sort(),
      hunks: f.hunks.map((h) => ({
        index: h.index,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        // Skip header — reconstructed events don't carry it (empty string).
        lines: h.lines.slice(),
        status: h.status,
        // Skip decidedAt — timestamp differs between live and reconstructed.
      })),
    }));
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    files,
    metrics: session.metrics,
  };
}

const CWD_ABS = process.platform === 'win32'
  ? 'C:\\Users\\test\\workspace'
  : '/Users/test/workspace';

async function runLiveSession(opts: {
  workspaceDir: string;
  cwd: string;
  sid: string;
  fixture: { relPath: string; before: string; after: string };
  postOpenAction?: (orch: ReviewOrchestrator, abs: AbsPath) => Promise<void>;
}): Promise<{ projection: ReturnType<typeof projectOrchestratorState>; finalDisk: string }> {
  const logger = new Logger('test', 'error');
  const history = new HistoryService({
    scope: 'workspace', workspaceRoot: opts.workspaceDir, logger, enabled: true,
  });
  const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
  const panel = new NoopPanel();

  let live = opts.fixture.after;
  const orch = new ReviewOrchestrator({
    store, panel, logger, history,
    writeFile: async (_, c) => { live = c; },
    readFile: async () => live,
  });

  // Seed: capture + record turn-started.
  const resolved = await store.captureOriginal(opts.sid, opts.cwd, opts.fixture.relPath);
  if (!resolved) throw new Error('captureOriginal failed');
  store.get(opts.sid)!.originals.set(resolved, opts.fixture.before);
  store.recordTouched(opts.sid, opts.cwd, opts.fixture.relPath);
  const turn = store.beginTurnIfNeeded(opts.sid, opts.cwd);
  await history.recordTurnStarted({
    sessionId: opts.sid, turnId: turn.turnId, agentId: 'claude-code',
    files: [{ relPath: opts.fixture.relPath, beforeContent: opts.fixture.before, mtimeMs: null }],
  });

  // Trigger Stop → orchestrator builds the review and emits turn-stopped.
  orch.handleStop(opts.sid, false, null);
  await new Promise((r) => setTimeout(r, 350));

  if (opts.postOpenAction) {
    await opts.postOpenAction(orch, resolved);
    // Let any fire-and-forget recordHunkDecided land.
    await new Promise((r) => setTimeout(r, 50));
  }

  return { projection: projectOrchestratorState(orch, opts.sid), finalDisk: live };
}

describe('B0-7 / B0-8: round-trip equivalence — live → reconstruct → adopt', () => {
  it('a clean session (turn-stopped only, no decisions) round-trips byte-for-byte', async () => {
    const sid = 'rt-clean-' + Date.now();
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'MOD-5';
    afterArr[25] = 'MOD-25';
    const after = afterArr.join('\n');

    const live = await runLiveSession({
      workspaceDir, cwd: CWD_ABS, sid,
      fixture: { relPath: 'src/file.ts', before, after },
    });
    expect(live.projection).not.toBeNull();

    // Fresh orchestrator + adopt from the same history root.
    const logger = new Logger('test', 'error');
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const fresh = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => live.finalDisk,
    });
    const recon = await history.reconstructSessionReview(sid, {
      cwd: CWD_ABS,
      readDiskFile: async () => live.finalDisk,
    });
    expect(recon).not.toBeNull();
    fresh.adoptReconstructed(recon!);

    const adopted = projectOrchestratorState(fresh, sid);
    expect(adopted).toEqual(live.projection);
  });

  it('round-trips a session where the user rejected one hunk', async () => {
    const sid = 'rt-reject-' + Date.now();
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    afterArr[5]  = 'MOD-5';
    afterArr[25] = 'MOD-25';
    const after = afterArr.join('\n');

    const live = await runLiveSession({
      workspaceDir, cwd: CWD_ABS, sid,
      fixture: { relPath: 'src/file.ts', before, after },
      postOpenAction: async (orch, abs) => {
        await orch.handleHunkAction(sid, abs, 0, 'reject');
      },
    });

    const logger = new Logger('test', 'error');
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const fresh = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => live.finalDisk,
    });
    const recon = await history.reconstructSessionReview(sid, {
      cwd: CWD_ABS, readDiskFile: async () => live.finalDisk,
    });
    fresh.adoptReconstructed(recon!);

    const adopted = projectOrchestratorState(fresh, sid);
    expect(adopted).toEqual(live.projection);

    // Hunk 0 should be rejected; hunk 1 should be pending.
    const adoptedSession = fresh.getSession(sid)!;
    expect(adoptedSession.files[0].hunks[0].status).toBe('rejected');
    expect(adoptedSession.files[0].hunks[1].status).toBe('pending');
  });

  it('adopt leaves currentTurnId null and stores prior turnId as lastTurnId — Claude continuation mints a fresh turn (Bug C)', async () => {
    const sid = 'rt-turn-id-' + Date.now();
    const before = 'a\nb\nc\n';
    const after = 'A\nb\nc\n';
    const live = await runLiveSession({
      workspaceDir, cwd: CWD_ABS, sid,
      fixture: { relPath: 'src/f.ts', before, after },
    });
    expect(live.projection).not.toBeNull();

    const logger = new Logger('test', 'error');
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const fresh = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => live.finalDisk,
    });
    const recon = await history.reconstructSessionReview(sid, {
      cwd: CWD_ABS, readDiskFile: async () => live.finalDisk,
    });
    fresh.adoptReconstructed(recon!);

    // Bug C fix: after adopt, `currentTurnId` is null and `lastTurnId`
    // carries the original turn id. User decisions during resume attach
    // to the original turn via the `currentTurnId ?? lastTurnId` fallback
    // path (already used by recordHunkDecisionEvent / recordUndoEvent /
    // recordSnapshotRevertEvent). Claude's continuation edits mint a
    // FRESH turn id — this prevents the second-turn-stopped collision
    // that previously dropped earlier hunk-decided events during replay.
    const ssData = store.get(sid);
    expect(ssData).toBeDefined();
    expect(ssData!.currentTurnId).toBeNull();
    expect(ssData!.lastTurnId).toBe(recon!.turnId);

    // Next PreToolUse mints a brand-new turn id (the continuation turn).
    const nextTurn = store.beginTurnIfNeeded(sid, CWD_ABS);
    expect(nextTurn.freshlyMinted).toBe(true);
    expect(nextTurn.turnId).not.toBe(recon!.turnId);
  });
});

describe('B0-7: adopt surfaces drift warnings', () => {
  it("posts 'external-edit' warning when disk content differs from reconstructed after", async () => {
    const sid = 'drift-warn';
    const logger = new Logger('test', 'error');
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    // Manually seed a closed session in the log.
    await history.recordTurnStarted({
      sessionId: sid, turnId: '44444444-4444-4444-8444-444444444444', agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'before\n', mtimeMs: null }],
    });
    await history.recordTurnStopped({
      sessionId: sid, turnId: '44444444-4444-4444-8444-444444444444', agentId: 'claude-code',
      lastAssistantMessage: null,
      files: [{
        relPath: 'a.ts', afterContent: 'after\n',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      }],
    });

    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const fresh = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => 'after\n',
    });
    const recon = await history.reconstructSessionReview(sid, {
      cwd: CWD_ABS,
      // Simulate an external edit between Stop and Resume.
      readDiskFile: async () => 'EXTERNAL\n',
    });
    expect(recon!.driftPerFile['a.ts']).toBe('drifted');
    fresh.adoptReconstructed(recon!);
    const session = fresh.getSession(sid)!;
    expect(session.files[0].warnings).toContain('external-edit');
  });

  it("posts 'vanished' warning when disk file is missing", async () => {
    const sid = 'vanish-warn';
    const logger = new Logger('test', 'error');
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    await history.recordTurnStarted({
      sessionId: sid, turnId: '55555555-5555-4555-8555-555555555555', agentId: 'claude-code',
      files: [{ relPath: 'b.ts', beforeContent: 'b\n', mtimeMs: null }],
    });
    await history.recordTurnStopped({
      sessionId: sid, turnId: '55555555-5555-4555-8555-555555555555', agentId: 'claude-code',
      lastAssistantMessage: null,
      files: [{
        relPath: 'b.ts', afterContent: 'a\n',
        isNew: false, isDeleted: false, isBinary: false,
        hunks: [],
      }],
    });

    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const fresh = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => '',
    });
    const recon = await history.reconstructSessionReview(sid, {
      cwd: CWD_ABS, readDiskFile: async () => null,
    });
    expect(recon!.driftPerFile['b.ts']).toBe('missing');
    fresh.adoptReconstructed(recon!);
    expect(fresh.getSession(sid)!.files[0].warnings).toContain('vanished');
  });
});
