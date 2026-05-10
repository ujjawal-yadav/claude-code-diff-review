import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs the test harness', () => {
    expect(1 + 1).toBe(2);
  });

  it('Node target supports modern features', () => {
    expect(typeof structuredClone).toBe('function');
    expect(typeof crypto.randomUUID).toBe('function');
  });
});
