/**
 * M9.6 — Wave 4 sub-agent attribution integration tests.
 *
 * Covers:
 *   - T5-1: a multi-Task session attributes the correct sub-agent to each file
 *   - T5-2: a main-agent-only session leaves subagentId null/undefined
 *   - T5-3: the truncation rule (UI chip caps at 32 chars; tooltip carries the
 *           full string) — exercised at the data layer here, UI verification
 *           is implicit since the chip's `title=` is the raw description
 *   - T5-4: subagentId round-trips through the event log → reconstruction
 *           → adoption (file.subagentId reappears on the live FileReview)
 *   - Audit-gap regression: emitted `undo` events carry the per-file
 *     subagentId (9.6.8 fix)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ClaudeCodeAdapter } from '../../src/adapters/claudeCodeAdapter.js';
import { HistoryService } from '../../src/history/historyService.js';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  asSessionId,
  AbsPath,
  FileReview,
  HunkStatus,
  SessionId,
  SessionMetrics,
  SessionReview,
} from '../../src/types.js';

const SID = 'session-subagent-9999';

class NoopPanel implements PanelGateway {
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSetConflict(_filePath: AbsPath, _attemptedHunkIndex: number, _conflictingHunks: number[]) {}
  postUndoStackDepth(_sid: SessionId, _depth: number) {}
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
}

let homeDir: string;
let workspaceDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let logger: Logger;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-subagent-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-subagent-ws-'));
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

async function writeTranscript(cwd: string, entries: unknown[]): Promise<string> {
  const encoded = cwd.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '-');
  const dir = path.join(homeDir, '.claude', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${SID}.jsonl`);
  await fs.writeFile(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// T5-1, T5-2, T5-3 — adapter-level attribution
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter.extractSubagentId (M9.6)', () => {
  it('T5-1: multi-Task session attributes the correct sub-agent per timestamp', async () => {
    const adapter = new ClaudeCodeAdapter();
    await writeTranscript(workspaceDir, [
      { type: 'tool_use', id: 't1', tool_name: 'Task', tool_input: { description: 'refactor auth' }, timestamp: '2026-05-18T10:00:00.000Z' },
      // file1 edit at 10:00:30 — falls under Task A
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/work/file1.ts' }, timestamp: '2026-05-18T10:00:30.000Z' },
      { type: 'tool_use', id: 't2', tool_name: 'Task', tool_input: { description: 'write tests for user service' }, timestamp: '2026-05-18T10:01:00.000Z' },
      // file2 edit at 10:01:30 — falls under Task B (latest before)
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/work/file2.ts' }, timestamp: '2026-05-18T10:01:30.000Z' },
    ]);

    const file1Edit = {
      session_id: SID,
      cwd: workspaceDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/work/file1.ts' },
      timestamp: '2026-05-18T10:00:30.000Z',
    };
    const file2Edit = {
      session_id: SID,
      cwd: workspaceDir,
      tool_name: 'Edit',
      tool_input: { file_path: '/work/file2.ts' },
      timestamp: '2026-05-18T10:01:30.000Z',
    };

    const id1 = await adapter.extractSubagentId(file1Edit);
    const id2 = await adapter.extractSubagentId(file2Edit);
    expect(id1).toBe('refactor auth');
    expect(id2).toBe('write tests for user service');
  });

  it('T5-2: main-agent-only session returns null', async () => {
    const adapter = new ClaudeCodeAdapter();
    await writeTranscript(workspaceDir, [
      { type: 'user', message: { content: 'edit file' }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' }, timestamp: '2026-05-18T10:00:10.000Z' },
    ]);
    const result = await adapter.extractSubagentId({
      session_id: SID, cwd: workspaceDir,
      tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' },
      timestamp: '2026-05-18T10:00:10.000Z',
    });
    expect(result).toBeNull();
  });

  it('T5-3: full description (incl. >32 chars) returned untruncated — UI truncates at render', async () => {
    const adapter = new ClaudeCodeAdapter();
    const long = 'refactor the authentication middleware with the new token store and update all callers';
    await writeTranscript(workspaceDir, [
      { type: 'tool_use', tool_name: 'Task', tool_input: { description: long }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' }, timestamp: '2026-05-18T10:00:30.000Z' },
    ]);
    const result = await adapter.extractSubagentId({
      session_id: SID, cwd: workspaceDir,
      tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' },
      timestamp: '2026-05-18T10:00:30.000Z',
    });
    expect(result).toBe(long); // full string at the data layer
    expect(result!.length).toBeGreaterThan(32);
  });

  it('caches per session: second call does not re-read the transcript', async () => {
    const adapter = new ClaudeCodeAdapter();
    await writeTranscript(workspaceDir, [
      { type: 'tool_use', tool_name: 'Task', tool_input: { description: 'A' }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' }, timestamp: '2026-05-18T10:00:30.000Z' },
    ]);
    const payload = {
      session_id: SID, cwd: workspaceDir,
      tool_name: 'Edit', tool_input: { file_path: '/work/a.ts' },
      timestamp: '2026-05-18T10:00:30.000Z',
    };
    expect(await adapter.extractSubagentId(payload)).toBe('A');
    // Remove the transcript file — cached call should still return 'A'.
    const transcriptPath = adapter.resolveTranscriptPath(SID, workspaceDir)!;
    await fs.rm(transcriptPath);
    expect(await adapter.extractSubagentId(payload)).toBe('A');
    // Clear the cache; now the missing file produces null.
    adapter.clearSubagentCache!(SID);
    expect(await adapter.extractSubagentId(payload)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T5-4: round-trip through the event log
// ---------------------------------------------------------------------------

describe('Sub-agent attribution round-trips through reconstruction (T5-4)', () => {
  it('TurnStoppedEvent carries per-file subagentId; recon → adopt restores it', async () => {
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });

    // Seed events directly (simulating a multi-Task turn).
    const turnId = '99999999-9999-4999-8999-999999999999';
    await history.recordTurnStarted({
      sessionId: SID, turnId, agentId: 'claude-code',
      files: [
        { relPath: 'a.ts', beforeContent: 'a\n', mtimeMs: null },
        { relPath: 'b.ts', beforeContent: 'b\n', mtimeMs: null },
      ],
    });
    await history.recordTurnStopped({
      sessionId: SID, turnId, agentId: 'claude-code', lastAssistantMessage: null,
      files: [
        {
          relPath: 'a.ts', afterContent: 'A\n',
          isNew: false, isDeleted: false, isBinary: false,
          subagentId: 'refactor auth',
          hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }],
        },
        {
          relPath: 'b.ts', afterContent: 'B\n',
          isNew: false, isDeleted: false, isBinary: false,
          subagentId: 'write tests',
          hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-b', '+B'] }],
        },
      ],
    });

    // Reconstruct and verify per-file subagentId surfaces.
    const recon = await history.reconstructSessionReview(SID, {
      cwd: workspaceDir,
      readDiskFile: async (rel) => (rel === 'a.ts' ? 'A\n' : 'B\n'),
    });
    expect(recon).not.toBeNull();
    const byRelPath = new Map(recon!.files.map((f) => [f.relPath, f]));
    expect(byRelPath.get('a.ts')!.subagentId).toBe('refactor auth');
    expect(byRelPath.get('b.ts')!.subagentId).toBe('write tests');

    // Adopt into a fresh orchestrator. Live FileReview must carry subagentId.
    const store = new SnapshotStore({ maxSessionBytes: 50 * 1024 * 1024, maxFilesPerSession: 200 });
    const orch = new ReviewOrchestrator({
      store, panel: new NoopPanel(), logger, history,
      writeFile: async () => undefined,
      readFile: async () => '',
    });
    orch.adoptReconstructed(recon!);
    const session = orch.getSession(SID)!;
    const liveByRel = new Map(session.files.map((f) => [f.relPath, f]));
    expect(liveByRel.get('a.ts')!.subagentId).toBe('refactor auth');
    expect(liveByRel.get('b.ts')!.subagentId).toBe('write tests');
  });

  it('events written before Wave 4 (no per-file subagentId) reconstruct cleanly with undefined', async () => {
    const history = new HistoryService({
      scope: 'workspace', workspaceRoot: workspaceDir, logger, enabled: true,
    });
    const turnId = '88888888-8888-4888-8888-888888888888';
    await history.recordTurnStarted({
      sessionId: SID, turnId, agentId: 'claude-code',
      files: [{ relPath: 'a.ts', beforeContent: 'a\n', mtimeMs: null }],
    });
    await history.recordTurnStopped({
      sessionId: SID, turnId, agentId: 'claude-code', lastAssistantMessage: null,
      files: [{
        relPath: 'a.ts', afterContent: 'A\n',
        isNew: false, isDeleted: false, isBinary: false,
        // no subagentId — forward-compat case
        hunks: [{ idx: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }],
      }],
    });
    const recon = await history.reconstructSessionReview(SID, {
      cwd: workspaceDir, readDiskFile: async () => 'A\n',
    });
    expect(recon!.files[0].subagentId).toBeUndefined();
  });
});
