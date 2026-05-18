import { describe, it, expect } from 'vitest';

import { ClaudeCodeAdapter } from '../../src/adapters/claudeCodeAdapter.js';
import { agentAdapters, requireAdapter } from '../../src/adapters/index.js';

/**
 * Adapter contract tests (M9.4a.6).
 *
 * Goal: round-trip a representative known-good Claude Code hook payload
 * through each parse routine, then assert that schema-invalid input is
 * rejected with `null` rather than throwing.
 */

const adapter = new ClaudeCodeAdapter();

const validPreEdit = {
  session_id: 'sess-001',
  tool_name: 'Edit',
  tool_input: { file_path: '/work/src/foo.ts', content: 'new contents' },
  cwd: '/work',
};

const validPreWrite = {
  session_id: 'sess-001',
  tool_name: 'Write',
  tool_input: { file_path: '/work/new.ts', content: 'fresh file' },
  cwd: '/work',
};

const validPost = {
  session_id: 'sess-001',
  tool_name: 'MultiEdit',
  tool_input: { file_path: '/work/src/foo.ts' },
  tool_result: { success: true },
  cwd: '/work',
};

const validStop = {
  session_id: 'sess-001',
  stop_hook_active: false,
  last_assistant_message: 'done.',
};

describe('ClaudeCodeAdapter — parsePreToolUse', () => {
  it('normalises a valid Edit payload', () => {
    const result = adapter.parsePreToolUse(validPreEdit);
    expect(result).toEqual({
      agentId: 'claude-code',
      sessionId: 'sess-001',
      toolName:  'Edit',
      filePath:  '/work/src/foo.ts',
      fileContent: 'new contents',
      cwd: '/work',
      subagentId: null,
    });
  });

  it('normalises a valid Write payload', () => {
    const result = adapter.parsePreToolUse(validPreWrite);
    expect(result?.toolName).toBe('Write');
    expect(result?.fileContent).toBe('fresh file');
  });

  it('returns null for non-edit tool names (Bash, Read, etc.)', () => {
    expect(adapter.parsePreToolUse({ ...validPreEdit, tool_name: 'Bash' })).toBeNull();
    expect(adapter.parsePreToolUse({ ...validPreEdit, tool_name: 'Read' })).toBeNull();
  });

  it('returns null for malformed payloads', () => {
    expect(adapter.parsePreToolUse({})).toBeNull();
    expect(adapter.parsePreToolUse({ session_id: '', tool_name: 'Edit' })).toBeNull();
    expect(adapter.parsePreToolUse(null)).toBeNull();
    expect(adapter.parsePreToolUse('not-an-object')).toBeNull();
  });
});

describe('ClaudeCodeAdapter — parsePostToolUse', () => {
  it('normalises a valid PostToolUse payload', () => {
    const result = adapter.parsePostToolUse(validPost);
    expect(result).toEqual({
      agentId: 'claude-code',
      sessionId: 'sess-001',
      toolName: 'MultiEdit',
      filePath: '/work/src/foo.ts',
      success: true,
      cwd: '/work',
      subagentId: null,
    });
  });

  it('defaults success=true when tool_result missing', () => {
    const { tool_result, ...withoutResult } = validPost;
    void tool_result;
    const result = adapter.parsePostToolUse(withoutResult);
    expect(result?.success).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(adapter.parsePostToolUse({ tool_name: 'Edit' })).toBeNull();
  });
});

describe('ClaudeCodeAdapter — parseStop', () => {
  it('normalises a valid Stop payload', () => {
    const result = adapter.parseStop(validStop);
    expect(result).toEqual({
      agentId: 'claude-code',
      sessionId: 'sess-001',
      cwd: '',
      stopHookActive: false,
      lastAssistantMessage: 'done.',
    });
  });

  it('preserves stop_hook_active=true', () => {
    const result = adapter.parseStop({ ...validStop, stop_hook_active: true });
    expect(result?.stopHookActive).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(adapter.parseStop({})).toBeNull();
    expect(adapter.parseStop({ session_id: '' })).toBeNull();
  });
});

describe('ClaudeCodeAdapter — generateHookConfig', () => {
  it('emits PreToolUse / PostToolUse / Stop entries with the marker and port', () => {
    const cfg = adapter.generateHookConfig({
      scope: 'workspace',
      workspaceRoot: '/work',
      port: 53117,
    }) as unknown as Record<'PreToolUse' | 'PostToolUse' | 'Stop', { matcher?: string; hooks: Array<{ url: string }> }>;
    expect(cfg.PreToolUse.matcher).toBe('Write|Edit|MultiEdit');
    expect(cfg.PreToolUse.hooks[0].url).toBe('http://127.0.0.1:53117/pre-tool-use');
    expect(cfg.PostToolUse.hooks[0].url).toBe('http://127.0.0.1:53117/post-tool-use');
    expect(cfg.Stop.hooks[0].url).toBe('http://127.0.0.1:53117/stop');
    // Stop has no `matcher` (event fires unconditionally).
    expect(cfg.Stop.matcher).toBeUndefined();
  });

  it('refuses unsupported scopes', () => {
    expect(() =>
      adapter.generateHookConfig({ scope: 'user', workspaceRoot: '/x', port: 1 }),
    ).toThrow(/scope/);
  });
});

describe('ClaudeCodeAdapter — resolveTranscriptPath (M9.5)', () => {
  it('returns a path under ~/.claude/projects/<encoded>/<sessionId>.jsonl', () => {
    const resolved = adapter.resolveTranscriptPath('sess-001', '/work/proj');
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/[\\/]\.claude[\\/]projects[\\/]/);
    expect(resolved).toMatch(/sess-001\.jsonl$/);
  });

  it('encodes cwd by stripping Windows drive letter and replacing separators with -', () => {
    // The encoding strategy is platform-agnostic at the string level.
    const winResolved = adapter.resolveTranscriptPath('sid', 'C:\\Users\\foo\\proj');
    expect(winResolved).not.toBeNull();
    expect(winResolved).toMatch(/-Users-foo-proj/);
    const posixResolved = adapter.resolveTranscriptPath('sid', '/Users/foo/proj');
    expect(posixResolved).not.toBeNull();
    expect(posixResolved).toMatch(/-Users-foo-proj/);
  });

  it('refuses path-traversal in sessionId', () => {
    expect(adapter.resolveTranscriptPath('../escape', '/work')).toBeNull();
    expect(adapter.resolveTranscriptPath('../../escape', '/work')).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(adapter.resolveTranscriptPath('', '/work')).toBeNull();
    expect(adapter.resolveTranscriptPath('sid', '')).toBeNull();
  });
});

describe('ClaudeCodeAdapter — extractSubagentId (M9.6 placeholder)', () => {
  it('returns null until M9.6 lands', () => {
    expect(adapter.extractSubagentId(validPreEdit)).toBeNull();
  });
});

describe('adapter registry', () => {
  it('exposes the Claude Code adapter under its id', () => {
    const a = agentAdapters.get('claude-code');
    expect(a).toBeDefined();
    expect(a?.agentId).toBe('claude-code');
  });

  it('requireAdapter throws on unknown id', () => {
    expect(() => requireAdapter('opencode')).toThrow(/opencode/);
  });
});
