/**
 * Audit Cleanup Wave (2026-05-20): coverage for the `rotateBearerToken`
 * command body, extracted into `rotateBearerTokenAndPromptReload`.
 *
 * Contract verified:
 *   1. Calls `secrets.rotateBearerToken()` to mint a fresh value.
 *   2. Propagates that value to `environmentVariableCollection.replace`
 *      so future-spawned terminals get the new token.
 *   3. Surfaces an info toast with a "Reload Window" action.
 *   4. On accepting Reload Window, dispatches `workbench.action.reloadWindow`.
 *   5. On dismissing the toast, does NOT dispatch reload (no silent reload).
 *   6. Optional logger receives the `bearer.rotated` info event.
 */

import { describe, it, expect, vi } from 'vitest';
import { rotateBearerTokenAndPromptReload } from '../../src/extension.js';

function deps(opts: { toastChoice: string | undefined } = { toastChoice: undefined }) {
  const replacements: Array<{ name: string; value: string }> = [];
  const commands: string[] = [];
  const logEntries: Array<{ src: string; evt: string }> = [];
  const showInfo = vi.fn(async (_msg: string, ..._actions: string[]) => opts.toastChoice);
  const secrets = { rotateBearerToken: vi.fn(async () => 'fresh-' + Math.random().toString(36).slice(2)) };
  return {
    secrets,
    envCollection: {
      replace(name: string, value: string) { replacements.push({ name, value }); },
    },
    logger: {
      info(src: string, evt: string) { logEntries.push({ src, evt }); },
    },
    showInfo,
    executeCommand: (cmd: string) => { commands.push(cmd); },
    // accessors
    _replacements: replacements,
    _commands: commands,
    _logEntries: logEntries,
  };
}

describe('rotateBearerTokenAndPromptReload', () => {
  it('mints a fresh token, propagates to env collection, and prompts reload', async () => {
    const d = deps({ toastChoice: undefined });
    await rotateBearerTokenAndPromptReload(d);

    expect(d.secrets.rotateBearerToken).toHaveBeenCalledTimes(1);
    expect(d._replacements.length).toBe(1);
    expect(d._replacements[0].name).toBe('CLAUDE_REVIEW_TOKEN');
    expect(d._replacements[0].value).toMatch(/^fresh-/);
    // Toast was shown with "Reload Window" as an action.
    expect(d.showInfo).toHaveBeenCalledTimes(1);
    expect(d.showInfo.mock.calls[0][1]).toBe('Reload Window');
  });

  it('dispatches workbench.action.reloadWindow when user accepts', async () => {
    const d = deps({ toastChoice: 'Reload Window' });
    await rotateBearerTokenAndPromptReload(d);
    expect(d._commands).toEqual(['workbench.action.reloadWindow']);
  });

  it('does NOT reload when user dismisses (returns undefined)', async () => {
    const d = deps({ toastChoice: undefined });
    await rotateBearerTokenAndPromptReload(d);
    expect(d._commands).toEqual([]);
  });

  it('does NOT reload when user picks an unknown action label', async () => {
    const d = deps({ toastChoice: 'Some Other Label' });
    await rotateBearerTokenAndPromptReload(d);
    expect(d._commands).toEqual([]);
  });

  it('emits bearer.rotated info log when logger is provided', async () => {
    const d = deps({ toastChoice: undefined });
    await rotateBearerTokenAndPromptReload(d);
    expect(d._logEntries).toEqual([{ src: 'extension', evt: 'bearer.rotated' }]);
  });

  it('completes cleanly when logger is omitted (optional dependency)', async () => {
    const replacements: Array<{ name: string; value: string }> = [];
    await expect(rotateBearerTokenAndPromptReload({
      secrets: { rotateBearerToken: async () => 'no-logger' },
      envCollection: { replace: (n, v) => replacements.push({ name: n, value: v }) },
      showInfo: async () => undefined,
      executeCommand: () => {},
    })).resolves.toBeUndefined();
    expect(replacements).toEqual([{ name: 'CLAUDE_REVIEW_TOKEN', value: 'no-logger' }]);
  });
});
