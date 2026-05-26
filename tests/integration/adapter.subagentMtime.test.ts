/**
 * v0.6.1: regression for the sub-agent-attribution staleness fix.
 *
 * Before the fix, `extractSubagentId` cached the transcript's Task entries on
 * the first call per session and NEVER refreshed — so a Task (sub-agent)
 * spawned mid-session was permanently mis-attributed to the main agent (and a
 * sticky negative `null` meant NO later sub-agent was ever picked up). The fix
 * stats the transcript and re-reads when its mtime advances.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ClaudeCodeAdapter } from '../../src/adapters/claudeCodeAdapter.js';

let homeDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

const SID = 'mtime-sess';
const CWD = '/work/proj';

const userLine = JSON.stringify({
  type: 'user', message: { content: 'do the thing' }, timestamp: '2026-05-18T09:00:00.000Z',
});
const editLine = JSON.stringify({
  type: 'tool_use', tool_name: 'Edit',
  tool_input: { file_path: '/work/proj/a.ts', old_string: 'a', new_string: 'b' },
  timestamp: '2026-05-18T09:30:00.000Z',
});
const taskLine = JSON.stringify({
  type: 'tool_use', id: 'task-1', tool_name: 'Task',
  tool_input: { description: 'refactor auth' },
  timestamp: '2026-05-18T10:00:00.000Z',
});

const payload = { session_id: SID, tool_name: 'Edit', tool_input: { file_path: '/work/proj/a.ts' }, cwd: CWD };

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-mtime-home-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('ClaudeCodeAdapter.extractSubagentId — mtime re-read (v0.6.1)', () => {
  it('picks up a Task appended to the transcript mid-session', async () => {
    const adapter = new ClaudeCodeAdapter();
    const transcriptPath = adapter.resolveTranscriptPath(SID, CWD);
    expect(transcriptPath).not.toBeNull();
    await fs.mkdir(path.dirname(transcriptPath!), { recursive: true });

    // v1: no Task yet → unattributed (main agent).
    await fs.writeFile(transcriptPath!, [userLine, editLine].join('\n') + '\n', 'utf8');
    await expect(adapter.extractSubagentId(payload)).resolves.toBeNull();

    // v2: a Task is spawned later in the session. Append it and bump the file
    // mtime deterministically so the cache invalidation can't depend on
    // coarse filesystem clock resolution.
    await fs.writeFile(transcriptPath!, [userLine, editLine, taskLine].join('\n') + '\n', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(transcriptPath!, future, future);

    await expect(adapter.extractSubagentId(payload)).resolves.toBe('refactor auth');
  });

  it('serves the cache (no re-read) when mtime is unchanged', async () => {
    const adapter = new ClaudeCodeAdapter();
    const transcriptPath = adapter.resolveTranscriptPath(SID, CWD);
    await fs.mkdir(path.dirname(transcriptPath!), { recursive: true });
    await fs.writeFile(transcriptPath!, [userLine, editLine, taskLine].join('\n') + '\n', 'utf8');
    // Pin a stable mtime so both calls observe the same value.
    const stamp = new Date(Date.now() - 5_000);
    await fs.utimes(transcriptPath!, stamp, stamp);

    await expect(adapter.extractSubagentId(payload)).resolves.toBe('refactor auth');
    // Second call with identical mtime returns the cached attribution.
    await expect(adapter.extractSubagentId(payload)).resolves.toBe('refactor auth');
  });
});
