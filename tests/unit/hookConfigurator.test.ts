import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureHooksInstalled,
  removeHooks,
  HOOK_MARKER_KEY,
  HOOK_MARKER_VALUE,
} from '../../src/hookConfigurator.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdr-hook-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readSettings(workspaceRoot: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(workspaceRoot, '.claude', 'settings.json'), 'utf8');
  return JSON.parse(raw);
}

describe('hookConfigurator — install', () => {
  it('creates .claude/settings.json from scratch with marker entries', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    const root = await readSettings(tmp) as {
      hooks: { PreToolUse: Array<Record<string, unknown>>; PostToolUse: Array<Record<string, unknown>>; Stop: Array<Record<string, unknown>> };
    };
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
      const arr = root.hooks[ev];
      expect(arr.length).toBe(1);
      expect(arr[0][HOOK_MARKER_KEY]).toBe(HOOK_MARKER_VALUE);
    }
    const ph = root.hooks.PreToolUse[0] as { matcher: string; hooks: Array<{ url: string; headers: Record<string, string> }> };
    expect(ph.matcher).toBe('Write|Edit|MultiEdit');
    expect(ph.hooks[0].url).toContain(':53117/');
    expect(ph.hooks[0].headers.Authorization).toBe('Bearer $CLAUDE_REVIEW_TOKEN');
  });

  it('preserves user-defined hook entries (no marker) when merging', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    const userEntry = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo user' }],
    };
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [userEntry] } }, null, 2),
    );

    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    const root = await readSettings(tmp) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    expect(root.hooks.PreToolUse.length).toBe(2);
    const userPresent = root.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
    expect(userPresent).toBeDefined();
    expect((userPresent as Record<string, unknown>)[HOOK_MARKER_KEY]).toBeUndefined();
  });

  it('is idempotent: running twice does not duplicate marked entries', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    const root = await readSettings(tmp) as { hooks: { PreToolUse: unknown[]; PostToolUse: unknown[]; Stop: unknown[] } };
    expect(root.hooks.PreToolUse.length).toBe(1);
    expect(root.hooks.PostToolUse.length).toBe(1);
    expect(root.hooks.Stop.length).toBe(1);
  });

  it('updates the URL when port changes', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 60000, scope: 'workspace' });
    const root = await readSettings(tmp) as {
      hooks: { Stop: Array<{ hooks: Array<{ url: string }> }> };
    };
    expect(root.hooks.Stop[0].hooks[0].url).toContain(':60000/');
  });

  it('refuses to overwrite malformed JSON', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'settings.json'), '{ this is not json');
    await expect(ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' })).rejects.toThrow(/malformed/i);
  });
});

describe('hookConfigurator — remove', () => {
  it('removes only marked entries; preserves user entries', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    const userEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] };
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [userEntry] } }, null, 2),
    );
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    await removeHooks({ workspaceRoot: tmp, scope: 'workspace' });

    const root = await readSettings(tmp) as { hooks?: { PreToolUse?: unknown[] } };
    expect(root.hooks?.PreToolUse?.length).toBe(1);
    const remaining = (root.hooks!.PreToolUse![0] as Record<string, unknown>);
    expect(remaining[HOOK_MARKER_KEY]).toBeUndefined();
    expect(remaining.matcher).toBe('Bash');
  });

  it('drops empty hook events and the hooks block when empty', async () => {
    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });
    await removeHooks({ workspaceRoot: tmp, scope: 'workspace' });
    const root = await readSettings(tmp) as { hooks?: unknown };
    expect(root.hooks).toBeUndefined();
  });

  it('is a no-op when settings file is absent', async () => {
    await expect(removeHooks({ workspaceRoot: tmp, scope: 'workspace' })).resolves.not.toThrow();
  });
});

/**
 * Audit Cleanup Wave (2026-05-20): legacy unmarked entries pointing at our
 * server URL pattern must be self-healed on the next `ensureHooksInstalled`.
 * Without this, users upgraded from older extension versions accumulate
 * duplicate hook entries (see 2026-05-19 debugging log — caused real auth
 * failures in the field).
 */
describe('hookConfigurator — legacy unmarked cleanup', () => {
  it('strips legacy unmarked entries matching our URL pattern on install', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    // Pre-seed settings with a LEGACY unmarked entry pointing at our URL
    // pattern (simulating an upgrade from an older extension version) AND
    // a genuinely-user-owned entry that should be preserved.
    const legacyUnmarked = {
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{
        type: 'http',
        url: 'http://127.0.0.1:53117/pre-tool-use',
        headers: { Authorization: 'Bearer $CLAUDE_REVIEW_TOKEN' },
      }],
    };
    const genuineUser = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    };
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [legacyUnmarked, genuineUser] } }, null, 2),
    );

    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });

    const root = await readSettings(tmp) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    // Expect: legacy unmarked entry STRIPPED, user-owned entry KEPT, our
    // marked entry ADDED. Total = 2 (user + ours).
    expect(root.hooks.PreToolUse.length).toBe(2);
    expect(root.hooks.PreToolUse.find((e) => e.matcher === 'Bash')).toBeDefined();
    expect(root.hooks.PreToolUse.find((e) => e[HOOK_MARKER_KEY] === HOOK_MARKER_VALUE)).toBeDefined();
    // The duplicate "looks like ours but unmarked" is gone.
    const httpEntries = root.hooks.PreToolUse.filter((e) => {
      const hooks = e.hooks as Array<{ type: string }>;
      return Array.isArray(hooks) && hooks.some((h) => h.type === 'http');
    });
    expect(httpEntries.length).toBe(1);
    expect(httpEntries[0][HOOK_MARKER_KEY]).toBe(HOOK_MARKER_VALUE);
  });

  it('does NOT strip unmarked entries pointing at unrelated URLs', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    const unrelatedHttp = {
      matcher: 'Write',
      hooks: [{
        type: 'http',
        url: 'http://127.0.0.1:9999/my-own-hook',
        headers: {},
      }],
    };
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [unrelatedHttp] } }, null, 2),
    );

    await ensureHooksInstalled({ workspaceRoot: tmp, port: 53117, scope: 'workspace' });

    const root = await readSettings(tmp) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    expect(root.hooks.PreToolUse.length).toBe(2); // unrelated + ours
    expect(root.hooks.PreToolUse.find((e) =>
      Array.isArray(e.hooks) && (e.hooks as Array<{ url: string }>).some((h) => h.url.includes(':9999/'))
    )).toBeDefined();
  });

  it('removeHooks strips legacy unmarked entries as well', async () => {
    const dir = path.join(tmp, '.claude');
    await fs.mkdir(dir, { recursive: true });
    const legacyUnmarked = {
      matcher: 'Stop',
      hooks: [{
        type: 'http',
        url: 'http://127.0.0.1:53117/stop',
        headers: { Authorization: 'Bearer $CLAUDE_REVIEW_TOKEN' },
      }],
    };
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [legacyUnmarked] } }, null, 2),
    );
    await removeHooks({ workspaceRoot: tmp, scope: 'workspace' });
    const root = await readSettings(tmp) as { hooks?: unknown };
    // Nothing left after stripping the legacy entry — hooks block is dropped.
    expect(root.hooks).toBeUndefined();
  });
});
