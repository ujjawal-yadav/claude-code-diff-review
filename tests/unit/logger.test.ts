import { describe, it, expect } from 'vitest';
import { Logger, __test } from '../../src/logger.js';

describe('logger — redactor', () => {
  it('redacts top-level secret-shaped keys', () => {
    const out = __test.redact({ apiKey: 'sk-ant-x', other: 'ok' }, 0) as Record<string, unknown>;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.other).toBe('ok');
  });

  it('redacts nested keys at any depth', () => {
    const out = __test.redact(
      { headers: { Authorization: 'Bearer abc', other: 'ok' } },
      0,
    ) as Record<string, Record<string, unknown>>;
    expect(out.headers.Authorization).toBe('[redacted]');
    expect(out.headers.other).toBe('ok');
  });

  it('respects depth limit', () => {
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 10; i++) nested = { wrap: nested };
    const out = __test.redact(nested, 0);
    // Redactor returns the depth-limit sentinel somewhere down the tree.
    expect(JSON.stringify(out)).toContain('[depth-limit]');
  });

  it('passes primitives through unchanged', () => {
    expect(__test.redact('hello', 0)).toBe('hello');
    expect(__test.redact(42, 0)).toBe(42);
    expect(__test.redact(null, 0)).toBe(null);
  });

  it('handles arrays', () => {
    const out = __test.redact(
      [{ apiKey: 'leak' }, { ok: true }],
      0,
    ) as Array<Record<string, unknown>>;
    expect(out[0].apiKey).toBe('[redacted]');
    expect(out[1].ok).toBe(true);
  });
});

describe('logger — level filtering', () => {
  it('suppresses below-threshold records', async () => {
    const log = new Logger('test', 'warn');
    // Use the underlying mock channel exposed via the vscode mock.
    const { __mock } = await import('vscode') as unknown as { __mock: { channels: Array<{ lines: string[] }> } };
    const channel = __mock.channels[__mock.channels.length - 1];
    log.debug('test', 'should-skip');
    log.info('test', 'should-skip');
    log.warn('test', 'should-keep');
    log.error('test', 'should-keep');
    expect(channel.lines.filter((l) => l.includes('should-skip')).length).toBe(0);
    expect(channel.lines.filter((l) => l.includes('should-keep')).length).toBe(2);
  });

  it('emits valid JSON lines', async () => {
    const log = new Logger('test', 'debug');
    const { __mock } = await import('vscode') as unknown as { __mock: { channels: Array<{ lines: string[] }> } };
    const channel = __mock.channels[__mock.channels.length - 1];
    log.info('src', 'evt', { k: 'v' });
    const last = channel.lines[channel.lines.length - 1];
    const parsed = JSON.parse(last);
    expect(parsed.src).toBe('src');
    expect(parsed.evt).toBe('evt');
    expect(parsed.lvl).toBe('info');
    expect(parsed.k).toBe('v');
  });
});
