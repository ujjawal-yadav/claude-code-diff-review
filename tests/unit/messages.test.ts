import { describe, it, expect } from 'vitest';
import {
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
  parseWebviewMessage,
} from '../../src/messages.js';

describe('messages — hook payload schemas', () => {
  it('accepts a well-formed PreToolUse payload', () => {
    const result = PreToolUsePayload.safeParse({
      session_id: 'abc',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/foo.ts', content: 'x' },
      cwd: '/work',
    });
    expect(result.success).toBe(true);
  });

  it('rejects PreToolUse with empty session_id', () => {
    const result = PreToolUsePayload.safeParse({
      session_id: '',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: '/work',
    });
    expect(result.success).toBe(false);
  });

  it('passes through unknown extra fields (forward-compat)', () => {
    const result = PostToolUsePayload.safeParse({
      session_id: 'abc',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/foo.ts', extra: 'meta' },
      tool_result: { success: true },
      cwd: '/work',
      future_field: 42,
    });
    expect(result.success).toBe(true);
  });

  it('Stop payload defaults stop_hook_active to false when missing', () => {
    const result = StopPayload.safeParse({ session_id: 'abc' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.stop_hook_active).toBe(false);
  });

  it('Stop payload accepts null last_assistant_message', () => {
    const result = StopPayload.safeParse({
      session_id: 'abc',
      stop_hook_active: false,
      last_assistant_message: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('messages — webview message validation', () => {
  it('parses a valid accept-hunk', () => {
    const out = parseWebviewMessage({ type: 'accept-hunk', filePath: 'a.ts', hunkIndex: 0 });
    expect(out).not.toBeNull();
  });

  it('rejects negative hunk index', () => {
    const out = parseWebviewMessage({ type: 'accept-hunk', filePath: 'a.ts', hunkIndex: -1 });
    expect(out).toBeNull();
  });

  it('rejects unknown message type', () => {
    const out = parseWebviewMessage({ type: 'evil-payload' });
    expect(out).toBeNull();
  });

  it('rejects chat-message with non-uuid chatId', () => {
    const out = parseWebviewMessage({
      type: 'chat-message',
      filePath: 'a.ts',
      hunkIndex: 0,
      message: 'hi',
      chatId: 'not-a-uuid',
    });
    expect(out).toBeNull();
  });
});
