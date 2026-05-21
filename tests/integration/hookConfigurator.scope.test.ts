/**
 * Phase α Track 2 (M9.3) acceptance tests — install scope.
 *
 * Maps to PHASE-ALPHA-IMMEDIATE.md §4.7 test IDs:
 *   T2-1 fresh install at user-level writes to ~/.claude/settings.json
 *   T2-2 two workspaces share one user-level install (path identity)
 *   T2-3 scope switch preserves foreign keys
 *   T2-4 round-trip user → workspace → user clean
 *   T2-5 permission denied surfaces with actionable error
 *
 * Strategy: override HOME / USERPROFILE before each test so user-scope
 * writes land in a temp dir, not the real home.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureHooksInstalled,
  hasInstalledHooks,
  removeHooks,
  resolveInstallPath,
  HOOK_MARKER_KEY,
  HOOK_MARKER_VALUE,
} from '../../src/hookConfigurator.js';

let tmpHome: string;
let tmpWs1: string;
let tmpWs2: string;
let savedHomeEnv: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-home-'));
  tmpWs1  = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-ws1-'));
  tmpWs2  = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-ws2-'));
  // os.homedir() reads HOME on Unix and USERPROFILE on Windows.
  savedHomeEnv = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  if (savedHomeEnv === undefined) delete process.env.HOME; else process.env.HOME = savedHomeEnv;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  for (const d of [tmpHome, tmpWs1, tmpWs2]) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function readSettings(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

describe('hookConfigurator — scope resolution (M9.3.2)', () => {
  it('resolves user scope to ~/.claude/settings.json regardless of workspace', () => {
    const resolved = resolveInstallPath('user', null);
    expect(resolved).not.toBeNull();
    expect(resolved!.settingsPath).toBe(path.join(tmpHome, '.claude', 'settings.json'));
  });

  it('resolves user scope identically when a workspace is also provided', () => {
    const resolved = resolveInstallPath('user', tmpWs1);
    expect(resolved!.settingsPath).toBe(path.join(tmpHome, '.claude', 'settings.json'));
  });

  it('resolves workspace scope to <workspaceRoot>/.claude/settings.json', () => {
    const resolved = resolveInstallPath('workspace', tmpWs1);
    expect(resolved!.settingsPath).toBe(path.join(tmpWs1, '.claude', 'settings.json'));
  });

  it('returns null for workspace scope with no workspace folder', () => {
    expect(resolveInstallPath('workspace', null)).toBeNull();
  });
});

describe('hookConfigurator — T2-1 fresh user-level install', () => {
  it('writes ~/.claude/settings.json with marker entries on first run', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const root = await readSettings(settingsPath) as {
      hooks: { PreToolUse: Array<Record<string, unknown>>; PostToolUse: Array<Record<string, unknown>>; Stop: Array<Record<string, unknown>> };
    };
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
      const arr = root.hooks[ev];
      expect(arr.length).toBe(1);
      expect(arr[0][HOOK_MARKER_KEY]).toBe(HOOK_MARKER_VALUE);
    }
    // No workspace-level file was created.
    await expect(fs.stat(path.join(tmpWs1, '.claude', 'settings.json'))).rejects.toThrow();
  });
});

describe('hookConfigurator — T2-2 two workspaces share one user-level install', () => {
  it('running ensureHooksInstalled from two different workspaces writes the SAME file', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs2, port: 53117, scope: 'user' });
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const root = await readSettings(settingsPath) as { hooks: { PreToolUse: unknown[]; PostToolUse: unknown[]; Stop: unknown[] } };
    // Idempotent: still exactly one marked entry per event.
    expect(root.hooks.PreToolUse.length).toBe(1);
    expect(root.hooks.PostToolUse.length).toBe(1);
    expect(root.hooks.Stop.length).toBe(1);
    // hasInstalledHooks confirms detection works for both workspace roots.
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(true);
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs2, scope: 'user' })).toBe(true);
  });
});

describe('hookConfigurator — T2-3 scope switch preserves foreign keys', () => {
  it('switching user → workspace preserves any foreign keys in either settings file', async () => {
    // Pre-seed BOTH locations with a foreign hook entry the user owns.
    const userDir = path.join(tmpHome, '.claude');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      path.join(userDir, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-bash' }] }] },
        otherSetting: 'preserved',
      }, null, 2),
    );
    const wsDir = path.join(tmpWs1, '.claude');
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsDir, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ws-bash' }] }] },
        wsSetting: 'preserved',
      }, null, 2),
    );

    // Install at user scope; later "switch" to workspace.
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    await removeHooks({ workspaceRoot: tmpWs1, scope: 'user' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'workspace' });

    // User settings: foreign Bash hook and otherSetting must survive.
    const userRoot = await readSettings(path.join(userDir, 'settings.json')) as {
      hooks?: { PreToolUse?: Array<Record<string, unknown>> };
      otherSetting?: string;
    };
    expect(userRoot.otherSetting).toBe('preserved');
    expect(userRoot.hooks?.PreToolUse?.length).toBe(1);
    expect((userRoot.hooks!.PreToolUse![0] as Record<string, unknown>).matcher).toBe('Bash');
    expect((userRoot.hooks!.PreToolUse![0] as Record<string, unknown>)[HOOK_MARKER_KEY]).toBeUndefined();

    // Workspace settings: foreign Bash hook and wsSetting must survive
    // alongside our newly-written marker entry.
    const wsRoot = await readSettings(path.join(wsDir, 'settings.json')) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
      wsSetting?: string;
    };
    expect(wsRoot.wsSetting).toBe('preserved');
    expect(wsRoot.hooks.PreToolUse.length).toBe(2);
    const userOwned = wsRoot.hooks.PreToolUse.find((e) => (e as Record<string, unknown>).matcher === 'Bash');
    const ours      = wsRoot.hooks.PreToolUse.find((e) => (e as Record<string, unknown>)[HOOK_MARKER_KEY] === HOOK_MARKER_VALUE);
    expect(userOwned).toBeDefined();
    expect(ours).toBeDefined();
  });
});

describe('hookConfigurator — T2-4 round-trip clean', () => {
  it('user → workspace → user leaves no marked entries anywhere except the final scope', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    await removeHooks({ workspaceRoot: tmpWs1, scope: 'user' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'workspace' });
    await removeHooks({ workspaceRoot: tmpWs1, scope: 'workspace' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });

    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(true);
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'workspace' })).toBe(false);
  });
});

describe('hookConfigurator — T2-5 permission denied surfaces gracefully', () => {
  it('write failure on user-scope file rejects with an actionable error', async () => {
    // Create the .claude directory and write a settings file owned by us.
    // Then change the directory permission to 0o000 (no access) so the
    // atomic write fails. Skipped on Windows where chmod semantics differ.
    if (process.platform === 'win32') {
      // Windows ACLs don't reliably block via chmod in Node; skip.
      return;
    }
    const userDir = path.join(tmpHome, '.claude');
    await fs.mkdir(userDir, { recursive: true });
    await fs.chmod(userDir, 0o400); // read-only
    try {
      await expect(
        ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' }),
      ).rejects.toThrow();
    } finally {
      // Restore so cleanup works.
      await fs.chmod(userDir, 0o700);
    }
  });
});

/**
 * v0.2.2 (2026-05-21): integration coverage for dual-scope auto-resolve.
 * The activation IIFE in extension.ts (a) probes both scopes via
 * `hasInstalledHooks`, (b) calls `decideDualScopeAction` (unit-tested
 * separately in hookConfigurator.test.ts), (c) invokes `removeHooks` on
 * the inactive scope when the action is `auto-resolve`. These tests verify
 * step (c) — that the I/O actually targets the correct scope and leaves
 * the active scope untouched.
 */
describe('hookConfigurator — dual-scope auto-resolve I/O', () => {
  it('installing both scopes then removing workspace leaves user intact', async () => {
    // Seed both scopes with our marker.
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53118, scope: 'workspace' });
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(true);
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'workspace' })).toBe(true);

    // Simulate the auto-resolve action (installScope='user' → cleanScope='workspace').
    await removeHooks({ workspaceRoot: tmpWs1, scope: 'workspace' });

    // Workspace cleaned; user intact.
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'workspace' })).toBe(false);
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(true);
  });

  it('installing both scopes then removing user leaves workspace intact', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53118, scope: 'workspace' });

    // Simulate auto-resolve when installScope='workspace' → cleanScope='user'.
    await removeHooks({ workspaceRoot: tmpWs1, scope: 'user' });

    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(false);
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'workspace' })).toBe(true);
  });

  it('removing a scope that has no marker is a safe no-op (auto-resolve falls back when only one scope present)', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmpWs1, port: 53117, scope: 'user' });
    // Workspace was never installed; removing it should not throw.
    await expect(removeHooks({ workspaceRoot: tmpWs1, scope: 'workspace' })).resolves.not.toThrow();
    // User scope unaffected.
    expect(await hasInstalledHooks({ workspaceRoot: tmpWs1, scope: 'user' })).toBe(true);
  });
});
