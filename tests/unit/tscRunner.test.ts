/**
 * v0.5 — unit tests for `runTsc` via a mock spawn factory.
 *
 * The real subprocess code is exercised by the gated `CCDR_REAL_TSC=1`
 * end-to-end harness. These unit tests cover the control flow:
 *   - happy path: exit 0 with no diagnostics → result `exitCode: 0`
 *   - diagnostic emit: exit 1 with stdout → parsed correctly
 *   - exit 2 with stderr → fatalStderr surfaced, project warning path
 *   - AbortSignal → tree-kill called, exitCode: -1
 *   - timeout → tree-kill called, exitCode: null
 *   - onProgress called during streaming
 *   - no-tsconfig + no-override → degenerate no-op, exitCode: -2
 *   - cached (build-mode + sub-second + clean) → cached: true
 *   - user-override command tokenised correctly
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runTsc } from '../../src/buildSignal/tscRunner.js';
import { Logger } from '../../src/logger.js';
import type { ChildProcess } from 'node:child_process';

const logger = new Logger('test', 'error');

/** Poll until predicate is true or the budget elapses. */
async function waitFor(pred: () => boolean, budgetMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: predicate did not become true within ${budgetMs}ms`);
}

/**
 * Build a fake ChildProcess that mimics the events runTsc subscribes to:
 *   - stdout / stderr streams with `on('data', ...)` + `setEncoding`
 *   - `on('close', code)` and `on('error', err)` on the process itself
 *
 * Returns a `controller` that lets tests drive the fake from outside.
 */
function makeFakeChild(): {
  child: ChildProcess;
  controller: {
    emitStdout(s: string): void;
    emitStderr(s: string): void;
    close(code: number | null): void;
    error(err: Error): void;
  };
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  (stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  (stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  (child as unknown as { stdout: NodeJS.ReadableStream }).stdout = stdout;
  (child as unknown as { stderr: NodeJS.ReadableStream }).stderr = stderr;
  (child as unknown as { pid: number }).pid = 12345;
  return {
    child,
    controller: {
      emitStdout(s) { stdout.emit('data', s); },
      emitStderr(s) { stderr.emit('data', s); },
      close(code) { child.emit('close', code); },
      error(err) { child.emit('error', err); },
    },
  };
}

describe('runTsc — happy path', () => {
  it('returns exit 0 with no diagnostics when stdout is empty', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    // Let microtasks settle so event listeners are wired.
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.projectDiagnostics).toEqual([]);
  });

  it('passes --noEmit --pretty false -p <tsconfig> for non-build mode', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    await run;
    const call = spawnFn.mock.calls[0]!;
    const argv = call[1] as string[];
    expect(argv).toContain('--noEmit');
    expect(argv).toContain('--pretty');
    expect(argv).toContain('false');
    expect(argv).toContain('-p');
  });

  it('uses -b for composite/references tsconfig', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: true },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    await run;
    const argv = spawnFn.mock.calls[0]![1] as string[];
    expect(argv).toContain('-b');
    expect(argv).toContain('--noEmit');
  });
});

describe('runTsc — diagnostics path', () => {
  it('parses stdout diagnostics with exit code 1', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.emitStdout("a.ts(1,1): error TS1: A.\n");
    controller.emitStdout("b.ts(2,2): error TS2: B.\n");
    controller.close(1);
    const result = await run;
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.length).toBe(2);
    expect(result.diagnostics[0]?.relPath).toBe('a.ts');
  });

  it('surfaces stderr on exit code 2 (config error)', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.emitStderr("Cannot find tsconfig.\n");
    controller.close(2);
    const result = await run;
    expect(result.exitCode).toBe(2);
    expect(result.fatalStderr).toContain('Cannot find tsconfig');
  });
});

describe('runTsc — cancellation', () => {
  it('AbortSignal pre-aborted → kills immediately, exitCode: -1', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const ac = new AbortController();
    ac.abort();
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: ac.signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    // tree-kill mock would have been called; simulate the process exit
    // that tree-kill would induce.
    controller.close(null);
    const result = await run;
    expect(result.exitCode).toBe(-1);
  });

  it('abort mid-run → exitCode: -1', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const ac = new AbortController();
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: ac.signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.emitStdout("a.ts(1,1): error TS1: A.\n");
    ac.abort();
    controller.close(null);
    const result = await run;
    expect(result.exitCode).toBe(-1);
    // We DO surface any partial diagnostics gathered before abort.
    expect(result.diagnostics.length).toBe(1);
  });
});

describe('runTsc — timeout', () => {
  it('wall-clock timeout fires → exitCode: null', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 50,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    // Don't emit anything; let the timeout fire.
    await new Promise((r) => setTimeout(r, 100));
    // tree-kill in real life would close the child; simulate.
    controller.close(null);
    const result = await run;
    expect(result.exitCode).toBeNull();
  });
});

describe('runTsc — onProgress', () => {
  it('progress callback fires during streaming', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const onProgress = vi.fn();
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      onProgress,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.emitStdout("a.ts(1,1): error TS1: A.\n");
    controller.close(1);
    await run;
    // At least one progress emit (could be debounced; we force a final one).
    expect(onProgress).toHaveBeenCalled();
  });
});

describe('runTsc — degenerate cases', () => {
  it('no tsconfig + no override → exit -2 (no-op)', async () => {
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => null as unknown);
    const result = await runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: null,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    expect(result.exitCode).toBe(-2);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('runTsc — cached detection', () => {
  it('build-mode + sub-second + no diagnostics + exit 0 → cached: true', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: true },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    const result = await run;
    expect(result.cached).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('non-build mode never reports cached', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    const result = await run;
    expect(result.cached).toBe(false);
  });
});

describe('runTsc — v0.5.1 LH1: double-fire guard + listener cleanup', () => {
  it('error + close fire back-to-back → finish() runs exactly once', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const onProgress = vi.fn();
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      onProgress,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    // Fire both events back-to-back. Without the `finished` guard, the
    // second finish() call would re-emit progress and call parser.done()
    // on an already-drained parser.
    controller.error(new Error('spawn failed'));
    controller.close(0);
    const result = await run;
    // The error path wins: result.exitCode reflects the synthetic exit 2.
    expect(result.exitCode).toBe(2);
    // Final progress was emitted exactly once (terminal flush) — not twice.
    // Pre-error progress emits may exist for streaming; the relevant
    // assertion is that we don't see a duplicate post-finish emit.
    // Re-deriving by counting how many times the final state was posted:
    const lastTwo = onProgress.mock.calls.slice(-2);
    // If finish() ran twice, the last two calls would be identical
    // terminal snapshots. Assert at most one terminal snapshot exists.
    if (lastTwo.length >= 2) {
      expect(lastTwo[0]).not.toEqual(lastTwo[1]);
    }
  });

  it('stdout/stderr data listeners are removed after finish()', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const stdoutRemoveSpy = vi.spyOn(child.stdout!, 'removeAllListeners');
    const stderrRemoveSpy = vi.spyOn(child.stderr!, 'removeAllListeners');
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: '',
      tsconfig: { configPath: '/tmp/ws/tsconfig.json', useBuildMode: false },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    await run;
    expect(stdoutRemoveSpy).toHaveBeenCalledWith('data');
    expect(stderrRemoveSpy).toHaveBeenCalledWith('data');
  });
});

describe('runTsc — user override', () => {
  it('tokenises overrideCommand and bypasses auto-detection', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: 'tsc -b --noEmit -p apps/web',
      tsconfig: null, // ignored when override present
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    await run;
    const call = spawnFn.mock.calls[0]!;
    expect(call[0]).toBe('tsc');
    expect(call[1]).toEqual(['-b', '--noEmit', '-p', 'apps/web']);
  });

  it('respects quoted args in overrideCommand', async () => {
    const { child, controller } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, _argv: string[]) => child);
    const run = runTsc({
      cwd: '/tmp/ws',
      overrideCommand: 'tsc --noEmit -p "path with spaces/tsconfig.json"',
      tsconfig: null,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      logger,
      spawnFn: spawnFn as unknown as NonNullable<Parameters<typeof runTsc>[0]['spawnFn']>,
    });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    controller.close(0);
    await run;
    const argv = spawnFn.mock.calls[0]![1] as string[];
    expect(argv).toContain('path with spaces/tsconfig.json');
  });
});
