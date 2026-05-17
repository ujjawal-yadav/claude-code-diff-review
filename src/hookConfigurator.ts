import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { agentAdapters } from './adapters/index.js';

/**
 * `.claude/settings.json` manager (TRD §5.3).
 *
 * Identity invariant
 * ------------------
 * Every entry written by this extension carries a marker:
 *
 *   { "x-claude-review-extension": "v1", ... }
 *
 * Entries WITHOUT the marker are user-owned and MUST NEVER be modified or
 * deleted. Merge and removal both filter on this marker.
 *
 * Atomicity
 * ---------
 * Writes go to `<file>.<rand>.tmp`, then `fs.rename` to the target. On the
 * same volume, rename is atomic on every supported platform.
 *
 * Failure mode
 * ------------
 * If the existing settings file is malformed JSON, we ABORT rather than
 * overwrite. The user must repair their file. This is intentional — we
 * cannot risk destroying user data.
 */

export const HOOK_MARKER_KEY   = 'x-claude-review-extension';
export const HOOK_MARKER_VALUE = 'v1';

interface HookEntry {
  [k: string]: unknown;
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

interface SettingsRoot {
  hooks?: {
    PreToolUse?:  HookEntry[];
    PostToolUse?: HookEntry[];
    Stop?:        HookEntry[];
    [k: string]: HookEntry[] | undefined;
  };
  [k: string]: unknown;
}

export interface HookConfigOptions {
  /** Workspace root where `.claude/settings.json` lives. */
  workspaceRoot: string;
  /** Bound port of the loopback server. */
  port: number;
}

export async function ensureHooksInstalled(opts: HookConfigOptions): Promise<void> {
  const { settingsPath, dir } = pathsFor(opts.workspaceRoot);

  await fs.mkdir(dir, { recursive: true });

  let root: SettingsRoot;
  try {
    const existing = await fs.readFile(settingsPath, 'utf8');
    root = parseStrict(existing);
  } catch (err: unknown) {
    if (isNoEnt(err)) {
      root = {};
    } else {
      throw err;
    }
  }

  // Delegate entry construction to the Claude Code adapter. The
  // adapter owns the wire format; this module owns the file-merge
  // policy (marker filtering, atomic write, malformed-JSON refusal).
  const adapter = agentAdapters.get('claude-code')!;
  const generated = adapter.generateHookConfig({
    scope: 'workspace',
    workspaceRoot: opts.workspaceRoot,
    port: opts.port,
  }) as Record<'PreToolUse' | 'PostToolUse' | 'Stop', HookEntry>;

  root.hooks = root.hooks ?? {};
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
    const arr = root.hooks[event] ?? [];
    // Strip our own marked entries (handles version upgrades + port changes).
    const userOwned = arr.filter((e) => e?.[HOOK_MARKER_KEY] !== HOOK_MARKER_VALUE);
    userOwned.push(generated[event]);
    root.hooks[event] = userOwned;
  }

  await atomicWrite(settingsPath, JSON.stringify(root, null, 2) + '\n');
}

export async function removeHooks(opts: { workspaceRoot: string }): Promise<void> {
  const { settingsPath } = pathsFor(opts.workspaceRoot);

  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (err) {
    if (isNoEnt(err)) return;
    throw err;
  }
  const root = parseStrict(raw);
  if (!root.hooks) return;

  for (const event of Object.keys(root.hooks) as Array<keyof NonNullable<SettingsRoot['hooks']>>) {
    const arr = root.hooks[event];
    if (!arr) continue;
    const filtered = arr.filter((e) => e?.[HOOK_MARKER_KEY] !== HOOK_MARKER_VALUE);
    if (filtered.length === 0) {
      delete root.hooks[event];
    } else {
      root.hooks[event] = filtered;
    }
  }
  if (root.hooks && Object.keys(root.hooks).length === 0) {
    delete root.hooks;
  }

  await atomicWrite(settingsPath, JSON.stringify(root, null, 2) + '\n');
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function pathsFor(workspaceRoot: string): { dir: string; settingsPath: string } {
  const dir = path.join(workspaceRoot, '.claude');
  return { dir, settingsPath: path.join(dir, 'settings.json') };
}

function parseStrict(raw: string): SettingsRoot {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings root must be an object');
    }
    return parsed as SettingsRoot;
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed .claude/settings.json — please repair manually. (${(err as Error).message})`,
    );
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(tmp, target);
}

function isNoEnt(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Exported for unit tests. */
export const __test = { parseStrict, atomicWrite };
