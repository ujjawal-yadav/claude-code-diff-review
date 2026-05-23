/**
 * Bug B + C regression: the user-reported flow
 *
 *   1. Run live session → accept hunk 0, reject hunk 1, leave hunk 2 pending.
 *   2. Dismiss + reconstruct + adopt.
 *   3. Verify adopted state preserves decisions.
 *   4. Simulate Claude continuing in the SAME session (new turn) — both
 *      adding a new file AND re-editing the original file.
 *   5. Stop fires → openReview rebuilds.
 *   6. Assert prior decisions are preserved in the live panel state.
 *   7. Assert the event log has TWO distinct turns (original + continuation),
 *      not a single replaced one.
 *   8. Reconstruct from scratch and assert decisions survive end-to-end.
 *
 * Pre-fix behaviour:
 *   - adoptReconstructed set currentTurnId = original → beginTurnIfNeeded
 *     never minted a new turn → Stop emitted a SECOND turn-stopped with
 *     the same turnId → reconstruction REPLACED the prior turn's hunks +
 *     acceptedSet, dropping hunk-decided events.
 *   - openReview unconditionally rebuilt FileReviews with all hunks
 *     'pending' → user's prior accept/reject wiped from live state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { HistoryService } from '../../src/history/historyService.js';
import { Logger } from '../../src/logger.js';
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

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-resume-cont-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-resume-cont-ws-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  logger = new Logger('test', 'error');
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const CWD = process.platform === 'win32' ? 'C:\\rc' : '/rc';

describe('Resume + Claude continuation (Bug B + C regression)', () => {
  it('preserves user decisions + emits a fresh turn id on continuation', async () => {
    const SID = 'rc-session';
    const fileARelPath = 'a.ts';

    // ------------------------------------------------------------------
    // PHASE 1: live session — Claude makes one turn with 3 hunks in a.ts
    // ------------------------------------------------------------------
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const afterArr = before.split('\n');
    // Space changes ≥10 lines apart so jsdiff's default 3-line context
    // doesn't merge them into a single hunk.
    afterArr[5]  = 'MOD-5';
    afterArr[18] = 'MOD-18';
    afterArr[31] = 'MOD-31';
    const after = afterArr.join('\n');

    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const writes = new Map<string, string>();
    let aDisk = after;
    const orch = new ReviewOrchestrator({
      store,
      panel: new NoopPanel(),
      logger,
      history,
      writeFile: async (p, c) => {
        writes.set(p, c);
        aDisk = c;
      },
      readFile: async (p) => {
        // Resolved abs path for a.ts → return current disk.
        const aAbs = path.resolve(CWD, fileARelPath);
        if (p === aAbs) return aDisk;
        throw new Error('unexpected read: ' + p);
      },
    });

    // Seed production order: beginTurnIfNeeded → captureOriginal (PreToolUse)
    // → recordTouched (PostToolUse). Order matters because beginTurnIfNeeded
    // resets `currentTurnTouched` to a fresh empty Set on freshlyMinted.
    const turn1 = store.beginTurnIfNeeded(SID, CWD);
    const aAbs = (await store.captureOriginal(SID, CWD, fileARelPath))!;
    store.get(SID)!.originals.set(aAbs, before);
    store.recordTouched(SID, CWD, fileARelPath);
    await history.recordTurnStarted({
      sessionId: SID, turnId: turn1.turnId, agentId: 'claude-code',
      files: [{ relPath: fileARelPath, beforeContent: before, mtimeMs: null }],
    });

    orch.handleStop(SID, false, 'Made edits to a.ts');
    await new Promise((r) => setTimeout(r, 350));

    // Verify the live session has 3 hunks, all pending.
    const session1 = orch.getSession(SID)!;
    expect(session1.files).toHaveLength(1);
    expect(session1.files[0].hunks).toHaveLength(3);
    expect(session1.files[0].hunks.map((h) => h.status)).toEqual(['pending', 'pending', 'pending']);

    // User: accept hunk 0, reject hunk 1, leave hunk 2 pending.
    await orch.handleHunkAction(SID, aAbs, 0, 'accept');
    await orch.handleHunkAction(SID, aAbs, 1, 'reject');
    await new Promise((r) => setTimeout(r, 50)); // let fire-and-forget history record settle

    const afterUserActions = orch.getSession(SID)!.files[0].hunks.map((h) => h.status);
    expect(afterUserActions).toEqual(['accepted', 'rejected', 'pending']);

    // ------------------------------------------------------------------
    // PHASE 2: dismiss + reconstruct + adopt
    // ------------------------------------------------------------------
    orch.dismissSession(SID);
    expect(orch.getSession(SID)).toBeUndefined();

    const recon = await history.reconstructSessionReview(SID, {
      cwd: CWD, readDiskFile: async () => aDisk,
    });
    expect(recon).not.toBeNull();
    orch.adoptReconstructed(recon!);

    // Verify adopted state preserved the decisions.
    const adopted = orch.getSession(SID)!;
    expect(adopted.files[0].hunks.map((h) => h.status)).toEqual(['accepted', 'rejected', 'pending']);

    // Bug C fix: currentTurnId is null, lastTurnId is the original turn id.
    const ssData = store.get(SID)!;
    expect(ssData.currentTurnId).toBeNull();
    expect(ssData.lastTurnId).toBe(turn1.turnId);

    // ------------------------------------------------------------------
    // PHASE 3: Claude continues — new edit to a NEW file b.ts
    // ------------------------------------------------------------------
    const bRelPath = 'b.ts';
    const bBefore = '';
    const bAfter = 'brand new file\n';
    const bDisk = bAfter; // Claude wrote it to disk.

    // Mock readFile for both a and b.
    const aOriginalRead = (orch as unknown as { read: (p: AbsPath) => Promise<string> }).read;
    (orch as unknown as { read: (p: AbsPath) => Promise<string> }).read = async (p: AbsPath) => {
      const aAbs = path.resolve(CWD, fileARelPath);
      const bAbs = path.resolve(CWD, bRelPath);
      if (p === aAbs) return aDisk;
      if (p === bAbs) return bDisk;
      return aOriginalRead(p);
    };

    // Simulate PreToolUse on b.ts → mints a fresh turn id (Bug C fix lit).
    // Production order: beginTurnIfNeeded FIRST so currentTurnTouched is
    // scoped to this turn before captureOriginal/recordTouched populate it.
    const turn2 = store.beginTurnIfNeeded(SID, CWD);
    const bAbs = (await store.captureOriginal(SID, CWD, bRelPath))!;
    store.get(SID)!.originals.set(bAbs, bBefore);
    store.recordTouched(SID, CWD, bRelPath);

    // CRITICAL ASSERT: fresh turn id, not the original.
    expect(turn2.freshlyMinted).toBe(true);
    expect(turn2.turnId).not.toBe(turn1.turnId);

    await history.recordTurnStarted({
      sessionId: SID, turnId: turn2.turnId, agentId: 'claude-code',
      files: [{ relPath: bRelPath, beforeContent: bBefore, mtimeMs: null }],
    });

    // Stop fires for the continuation turn.
    orch.handleStop(SID, false, 'Added b.ts');
    await new Promise((r) => setTimeout(r, 350));

    // ------------------------------------------------------------------
    // PHASE 4: assert the live panel state preserved decisions
    // ------------------------------------------------------------------
    const sessionAfterContinuation = orch.getSession(SID)!;
    const fileA = sessionAfterContinuation.files.find((f) => f.relPath === fileARelPath);
    expect(fileA).toBeDefined();
    // Bug B fix: the user's prior ACCEPT on hunk 0 is preserved (the
    // crucial regression). The rejected hunk's content is no longer on
    // disk (the set-pipeline already wrote the reverted bytes), so the
    // new diff doesn't include it — natural "absorption" of the
    // rejection. The pending hunk is preserved as pending. Net: the
    // remaining 2 visible hunks reflect what's still on disk.
    expect(fileA!.hunks.map((h) => h.status)).toEqual(['accepted', 'pending']);

    const fileB = sessionAfterContinuation.files.find((f) => f.relPath === bRelPath);
    expect(fileB).toBeDefined();
    // New file: all hunks pending.
    expect(fileB!.hunks.every((h) => h.status === 'pending')).toBe(true);

    // ------------------------------------------------------------------
    // PHASE 5: assert the event log has TWO distinct turns
    // ------------------------------------------------------------------
    const events = await history.readEvents(SID);
    const turnIds = new Set(events.map((e) => e.turnId));
    expect(turnIds.has(turn1.turnId)).toBe(true);
    expect(turnIds.has(turn2.turnId)).toBe(true);
    expect(turnIds.size).toBe(2);

    // ------------------------------------------------------------------
    // PHASE 6: reconstruct from scratch — decisions survive end-to-end
    // ------------------------------------------------------------------
    const reconFinal = await history.reconstructSessionReview(SID, {
      cwd: CWD, readDiskFile: async (rel) => (rel === fileARelPath ? aDisk : bDisk),
    });
    expect(reconFinal).not.toBeNull();

    const aRecon = reconFinal!.files.find((f) => f.relPath === fileARelPath);
    expect(aRecon).toBeDefined();
    // Bug C fix: reconstruction sees both turn-stoppeds as distinct turns,
    // so the prior turn's hunks + hunk-decided events aren't clobbered.
    // Replay walks: turn1.turn-stopped emits 3 hunks all 'pending', then
    // 2 hunk-decided events flip hunks 0 and 1 to accepted/rejected,
    // then turn2.turn-stopped emits b.ts (separate file, doesn't touch
    // a.ts's state). Final a.ts state: 3 hunks with the recorded statuses.
    expect(aRecon!.hunks.map((h) => h.status)).toEqual(['accepted', 'rejected', 'pending']);

    const bRecon = reconFinal!.files.find((f) => f.relPath === bRelPath);
    expect(bRecon).toBeDefined();
    expect(bRecon!.hunks.every((h) => h.status === 'pending')).toBe(true);
  });
});
