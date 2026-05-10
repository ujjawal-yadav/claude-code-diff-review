import { describe, it, expect, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { SecretManager, __test } from '../../src/secretManager.js';

class FakeSecretStorage {
  private data = new Map<string, string>();
  async get(key: string)              { return this.data.get(key); }
  async store(key: string, v: string) { this.data.set(key, v); }
  async delete(key: string)           { this.data.delete(key); }
  /** test-only */ get size() { return this.data.size; }
  onDidChange = () => ({ dispose() { /* noop */ } });
}

const asSecretStorage = (f: FakeSecretStorage): vscode.SecretStorage => f as unknown as vscode.SecretStorage;

describe('SecretManager — bearer token', () => {
  let fake: FakeSecretStorage;
  let sm: SecretManager;

  beforeEach(() => {
    fake = new FakeSecretStorage();
    sm = new SecretManager(asSecretStorage(fake));
  });

  it('generates a 64-hex-char token on first call', async () => {
    const token = await sm.getOrCreateBearerToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same token on subsequent get calls', async () => {
    const a = await sm.getOrCreateBearerToken();
    const b = await sm.getOrCreateBearerToken();
    expect(a).toBe(b);
  });

  it('rotateBearerToken always replaces the value', async () => {
    const a = await sm.getOrCreateBearerToken();
    const b = await sm.rotateBearerToken();
    expect(a).not.toBe(b);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clearBearerToken removes the entry', async () => {
    await sm.getOrCreateBearerToken();
    await sm.clearBearerToken();
    expect(fake.size).toBe(0);
  });
});

describe('SecretManager — API key', () => {
  let fake: FakeSecretStorage;
  let sm: SecretManager;

  beforeEach(() => {
    fake = new FakeSecretStorage();
    sm = new SecretManager(asSecretStorage(fake));
  });

  it('regex accepts a realistic Anthropic key shape', () => {
    expect(__test.API_KEY_RX.test('sk-ant-api03-' + 'A'.repeat(95))).toBe(true);
  });

  it('regex rejects short / wrong-shape keys', () => {
    expect(__test.API_KEY_RX.test('sk-ant-')).toBe(false);
    expect(__test.API_KEY_RX.test('not-a-key')).toBe(false);
    expect(__test.API_KEY_RX.test('')).toBe(false);
  });

  it('setApiKey rejects malformed input', async () => {
    await expect(sm.setApiKey('garbage')).rejects.toThrow(/Invalid Anthropic API key/);
  });

  it('setApiKey trims and stores valid keys', async () => {
    const valid = '  sk-ant-api03-' + 'B'.repeat(95) + '  ';
    await sm.setApiKey(valid);
    expect(await sm.getApiKey()).toBe(valid.trim());
  });

  it('getApiKey returns undefined when unset', async () => {
    expect(await sm.getApiKey()).toBeUndefined();
  });

  it('clearApiKey removes the stored key', async () => {
    await sm.setApiKey('sk-ant-api03-' + 'C'.repeat(95));
    await sm.clearApiKey();
    expect(await sm.getApiKey()).toBeUndefined();
  });
});
