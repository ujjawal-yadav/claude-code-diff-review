/**
 * Unit tests for `src/transcript/transcriptReader.ts` (M9.5 — Wave 3).
 *
 * Verifies the streamed JSONL parser + window builder behaves correctly
 * across the failure modes we care about:
 *   - missing file → empty window
 *   - malformed lines → skipped silently
 *   - target file lookup finds the most recent matching tool_use
 *   - truncation caps respected
 *   - readTaskEntries returns Task tool_use entries sorted by timestamp
 *   - findLatestTaskBefore binary-searches correctly
 *
 * Heap-bound assertion (T4-5) lives in the integration test file because
 * it needs to write a 50 MB fixture to a real tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  findLatestTaskBefore,
  readTaskEntries,
  readTranscriptWindow,
  type TaskEntry,
} from '../../src/transcript/transcriptReader.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-transcript-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeJsonl(name: string, entries: unknown[]): Promise<string> {
  const p = path.join(dir, name);
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(p, body, 'utf8');
  return p;
}

const SAMPLE = (overrides: Partial<{ ts: string; toolName: string; filePath: string; description: string }> = {}) => {
  const ts = overrides.ts ?? '2026-05-18T10:00:00.000Z';
  return {
    user: { type: 'user', message: { content: 'fix the auth bug' }, timestamp: '2026-05-18T09:59:00.000Z' },
    toolUse: {
      type: 'tool_use',
      tool_name: overrides.toolName ?? 'Edit',
      tool_input: { file_path: overrides.filePath ?? '/work/auth.ts', old_string: 'a', new_string: 'b' },
      timestamp: ts,
    },
    task: {
      type: 'tool_use',
      id: 'task-1',
      tool_name: 'Task',
      tool_input: { description: overrides.description ?? 'refactor auth' },
      timestamp: ts,
    },
  };
};

// ---------------------------------------------------------------------------
// readTranscriptWindow
// ---------------------------------------------------------------------------

describe('readTranscriptWindow', () => {
  it('returns empty window when file does not exist', async () => {
    const w = await readTranscriptWindow('/no/such/file.jsonl', { filePath: '/x' });
    expect(w.userPrompt).toBeNull();
    expect(w.precedingToolCalls).toEqual([]);
    expect(w.followingToolCalls).toEqual([]);
  });

  it('returns empty window when the target file never appears', async () => {
    const s = SAMPLE();
    const p = await writeJsonl('a.jsonl', [s.user, s.toolUse]);
    const w = await readTranscriptWindow(p, { filePath: '/work/OTHER.ts' });
    expect(w.userPrompt).toBeNull();
    expect(w.precedingToolCalls).toEqual([]);
  });

  it('captures the user prompt preceding the matching tool_use', async () => {
    const s = SAMPLE();
    const p = await writeJsonl('a.jsonl', [s.user, s.toolUse]);
    const w = await readTranscriptWindow(p, { filePath: '/work/auth.ts' });
    expect(w.userPrompt).toBe('fix the auth bug');
  });

  it('captures up to windowSize preceding/following tool_use entries', async () => {
    const tu = (file: string, ts: string) => ({
      type: 'tool_use',
      tool_name: 'Edit',
      tool_input: { file_path: file },
      timestamp: ts,
    });
    const entries = [
      { type: 'user', message: { content: 'p' }, timestamp: '2026-05-18T10:00:00.000Z' },
      tu('/a/1.ts', '2026-05-18T10:01:00.000Z'),
      tu('/a/2.ts', '2026-05-18T10:02:00.000Z'),
      tu('/a/3.ts', '2026-05-18T10:03:00.000Z'),
      tu('/a/4.ts', '2026-05-18T10:04:00.000Z'),
      tu('/a/5.ts', '2026-05-18T10:05:00.000Z'),
      tu('/a/6.ts', '2026-05-18T10:06:00.000Z'),
      tu('/a/target.ts', '2026-05-18T10:07:00.000Z'),
      tu('/a/7.ts', '2026-05-18T10:08:00.000Z'),
      tu('/a/8.ts', '2026-05-18T10:09:00.000Z'),
      tu('/a/9.ts', '2026-05-18T10:10:00.000Z'),
    ];
    const p = await writeJsonl('a.jsonl', entries);
    const w = await readTranscriptWindow(p, { filePath: '/a/target.ts', windowSize: 3 });
    expect(w.precedingToolCalls.length).toBe(3);
    expect(w.precedingToolCalls.map((c) => (JSON.parse(c.inputSummary) as { file_path: string }).file_path))
      .toEqual(['/a/4.ts', '/a/5.ts', '/a/6.ts']);
    expect(w.followingToolCalls.length).toBe(3);
    expect(w.followingToolCalls.map((c) => (JSON.parse(c.inputSummary) as { file_path: string }).file_path))
      .toEqual(['/a/7.ts', '/a/8.ts', '/a/9.ts']);
  });

  it('uses the most recent matching tool_use when target appears multiple times', async () => {
    const tu = (file: string, ts: string, marker: string) => ({
      type: 'tool_use',
      tool_name: 'Edit',
      tool_input: { file_path: file, marker },
      timestamp: ts,
    });
    const entries = [
      { type: 'user', message: { content: 'first ask' }, timestamp: '2026-05-18T10:00:00.000Z' },
      tu('/a/target.ts', '2026-05-18T10:01:00.000Z', 'first'),
      { type: 'user', message: { content: 'second ask' }, timestamp: '2026-05-18T10:02:00.000Z' },
      tu('/a/target.ts', '2026-05-18T10:03:00.000Z', 'second'),
    ];
    const p = await writeJsonl('a.jsonl', entries);
    const w = await readTranscriptWindow(p, { filePath: '/a/target.ts' });
    expect(w.userPrompt).toBe('second ask');
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const s = SAMPLE();
    const lines = [
      JSON.stringify(s.user),
      'not valid json',
      JSON.stringify({ type: 'unknown_kind', whatever: 'thing' }),
      JSON.stringify(s.toolUse),
    ];
    const p = path.join(dir, 'a.jsonl');
    await fs.writeFile(p, lines.join('\n') + '\n', 'utf8');
    const w = await readTranscriptWindow(p, { filePath: '/work/auth.ts' });
    expect(w.userPrompt).toBe('fix the auth bug');
  });

  it('handles \\r\\n line endings', async () => {
    const s = SAMPLE();
    const body = [JSON.stringify(s.user), JSON.stringify(s.toolUse)].join('\r\n') + '\r\n';
    const p = path.join(dir, 'a.jsonl');
    await fs.writeFile(p, body, 'utf8');
    const w = await readTranscriptWindow(p, { filePath: '/work/auth.ts' });
    expect(w.userPrompt).toBe('fix the auth bug');
  });

  it('truncates very long tool inputs', async () => {
    const big = 'x'.repeat(8 * 1024);
    const entries = [
      { type: 'user', message: { content: 'p' }, timestamp: '2026-05-18T10:00:00.000Z' },
      {
        type: 'tool_use',
        tool_name: 'Edit',
        tool_input: { file_path: '/work/a.ts', payload: big },
        timestamp: '2026-05-18T10:01:00.000Z',
      },
    ];
    const p = await writeJsonl('a.jsonl', entries);
    const w = await readTranscriptWindow(p, { filePath: '/work/a.ts', windowSize: 1 });
    // Only the target itself; preceding is empty.
    expect(w.precedingToolCalls.length).toBe(0);
    // The target's input would only appear in following if there were
    // entries after. Confirm truncation surface by adding a following entry.
    entries.push({
      type: 'tool_use',
      tool_name: 'Edit',
      tool_input: { file_path: '/work/b.ts', payload: big },
      timestamp: '2026-05-18T10:02:00.000Z',
    });
    const p2 = await writeJsonl('b.jsonl', entries);
    const w2 = await readTranscriptWindow(p2, { filePath: '/work/a.ts', windowSize: 1 });
    expect(w2.followingToolCalls[0].inputSummary.length).toBeLessThanOrEqual(1024 + 24);
  });
});

// ---------------------------------------------------------------------------
// readTaskEntries + findLatestTaskBefore
// ---------------------------------------------------------------------------

describe('readTaskEntries', () => {
  it('returns [] for missing file', async () => {
    const tasks = await readTaskEntries('/no/such.jsonl');
    expect(tasks).toEqual([]);
  });

  it('returns [] when no Task tool_use is in the transcript', async () => {
    const s = SAMPLE();
    const p = await writeJsonl('a.jsonl', [s.user, s.toolUse]);
    expect(await readTaskEntries(p)).toEqual([]);
  });

  it('extracts Task entries sorted by timestamp ascending', async () => {
    const p = await writeJsonl('a.jsonl', [
      { type: 'tool_use', id: 'task-B', tool_name: 'Task',
        tool_input: { description: 'second task' },
        timestamp: '2026-05-18T10:05:00.000Z' },
      { type: 'tool_use', id: 'task-A', tool_name: 'Task',
        tool_input: { description: 'first task' },
        timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Edit',
        tool_input: { file_path: '/a.ts' },
        timestamp: '2026-05-18T10:01:00.000Z' },
    ]);
    const tasks = await readTaskEntries(p);
    expect(tasks.map((t) => t.description)).toEqual(['first task', 'second task']);
    expect(tasks[0].taskToolUseId).toBe('task-A');
  });

  it('skips Task entries without a description', async () => {
    const p = await writeJsonl('a.jsonl', [
      { type: 'tool_use', tool_name: 'Task',
        tool_input: { /* no description */ }, timestamp: '2026-05-18T10:00:00.000Z' },
      { type: 'tool_use', tool_name: 'Task',
        tool_input: { description: '' }, timestamp: '2026-05-18T10:01:00.000Z' },
      { type: 'tool_use', tool_name: 'Task',
        tool_input: { description: 'kept' }, timestamp: '2026-05-18T10:02:00.000Z' },
    ]);
    const tasks = await readTaskEntries(p);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe('kept');
  });
});

describe('findLatestTaskBefore', () => {
  const tasks: TaskEntry[] = [
    { timestamp: 100, taskToolUseId: 'a', description: 'A' },
    { timestamp: 200, taskToolUseId: 'b', description: 'B' },
    { timestamp: 300, taskToolUseId: 'c', description: 'C' },
  ];

  it('returns null for empty array', () => {
    expect(findLatestTaskBefore([], 100)).toBeNull();
  });

  it('returns null when ts is before all entries', () => {
    expect(findLatestTaskBefore(tasks, 50)).toBeNull();
  });

  it('returns the latest entry at or before ts', () => {
    expect(findLatestTaskBefore(tasks, 150)?.description).toBe('A');
    expect(findLatestTaskBefore(tasks, 200)?.description).toBe('B');
    expect(findLatestTaskBefore(tasks, 250)?.description).toBe('B');
    expect(findLatestTaskBefore(tasks, 999)?.description).toBe('C');
  });
});
