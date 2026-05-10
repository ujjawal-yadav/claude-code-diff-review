import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Telemetry, TelemetryEvent, __test } from '../../src/telemetry.js';

describe('telemetry — scrubProps', () => {
  it('drops PII keys', () => {
    const out = __test.scrubProps({ apiKey: 'leak', token: 'leak', filePath: '/x', kept: 'ok' });
    expect(out).toEqual({ kept: 'ok' });
  });

  it('drops object/array values (telemetry is flat-only)', () => {
    const out = __test.scrubProps({ a: { nested: 1 }, b: [1, 2], c: 'kept', d: 5 });
    expect(out).toEqual({ c: 'kept', d: 5 });
  });

  it('preserves primitives', () => {
    const out = __test.scrubProps({ s: 'x', n: 42, b: true, u: undefined });
    expect(out).toEqual({ s: 'x', n: 42, b: true, u: undefined });
  });

  it('returns undefined for undefined input', () => {
    expect(__test.scrubProps(undefined)).toBeUndefined();
  });
});

describe('telemetry — gating', () => {
  let extOn = true;
  let globalOn = true;
  let received: TelemetryEvent[] = [];
  let t: Telemetry;

  beforeEach(() => {
    extOn = true; globalOn = true; received = [];
    t = new Telemetry({
      isExtensionEnabled: () => extOn,
      isGlobalEnabled:    () => globalOn,
      sink: (e) => { received.push(e); },
    });
  });

  afterEach(() => { t.dispose(); });

  it('emits when both gates are open', () => {
    t.event('hook.received', { route: '/pre' });
    t.flush();
    expect(received.length).toBe(1);
    expect(received[0].name).toBe('hook.received');
  });

  it('drops when extension setting is off', () => {
    extOn = false;
    t.event('hook.received');
    t.flush();
    expect(received.length).toBe(0);
  });

  it('drops when global setting is off', () => {
    globalOn = false;
    t.event('hook.received');
    t.flush();
    expect(received.length).toBe(0);
  });

  it('scrubs PII keys before storing in the buffer', () => {
    t.event('chat.completed', { apiKey: 'leak', inputTokens: 12 });
    t.flush();
    expect(received.length).toBe(1);
    expect(received[0].properties).toEqual({ inputTokens: 12 });
  });
});

describe('telemetry — batching', () => {
  it('batches events and flushes on demand', async () => {
    const received: TelemetryEvent[] = [];
    const t = new Telemetry({
      isExtensionEnabled: () => true,
      isGlobalEnabled:    () => true,
      sink: (e) => { received.push(e); },
    });
    t.event('a');
    t.event('b');
    t.event('c');
    expect(received.length).toBe(0);
    t.flush();
    expect(received.length).toBe(3);
    t.dispose();
  });

  it('caps the buffer (drops rather than grows unbounded)', () => {
    const received: TelemetryEvent[] = [];
    const t = new Telemetry({
      isExtensionEnabled: () => true,
      isGlobalEnabled:    () => true,
      sink: (e) => { received.push(e); },
    });
    for (let i = 0; i < __test.MAX_BUFFER + 50; i++) t.event('overflow');
    t.flush();
    expect(received.length).toBe(__test.MAX_BUFFER);
    t.dispose();
  });

  it('dispose flushes any pending batch', () => {
    const received: TelemetryEvent[] = [];
    const t = new Telemetry({
      isExtensionEnabled: () => true,
      isGlobalEnabled:    () => true,
      sink: (e) => { received.push(e); },
    });
    t.event('hello');
    t.dispose();
    expect(received.length).toBe(1);
  });

  it('flush is a no-op when buffer empty', () => {
    const received: TelemetryEvent[] = [];
    const t = new Telemetry({
      isExtensionEnabled: () => true,
      isGlobalEnabled:    () => true,
      sink: (e) => { received.push(e); },
    });
    t.flush();
    t.flush();
    expect(received.length).toBe(0);
    t.dispose();
  });

  it('sink errors do not propagate (host stays alive)', () => {
    const t = new Telemetry({
      isExtensionEnabled: () => true,
      isGlobalEnabled:    () => true,
      sink: () => { throw new Error('boom'); },
    });
    t.event('e');
    expect(() => t.flush()).not.toThrow();
    t.dispose();
  });
});

// Avoid leaving a pending interval if Vitest runs another suite after.
afterEach(() => { vi.clearAllTimers(); });
