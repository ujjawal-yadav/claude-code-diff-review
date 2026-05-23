import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import spawn from 'cross-spawn';
import treeKill from 'tree-kill';
import parseArgv from 'string-argv';

import type { Logger } from '../logger.js';
import type { BuildErrorRef } from '../types.js';
import { TscOutputStreamParser } from './tscParser.js';
import type { ResolvedTsConfig } from './tsconfigResolver.js';

/**
 * v0.5 — spawn the workspace's TypeScript compiler and stream its output
 * through the parser. Cross-platform: `cross-spawn` handles Windows `.cmd`
 * shim resolution + arg escaping (Node's own escaping has had CVEs);
 * `tree-kill` handles process-tree teardown on POSIX (process-group
 * SIGTERM) and Windows (`taskkill /T /F`) uniformly.
 *
 * Cancellation: every spawn carries an AbortSignal. On abort: kill the
 * process tree via the saved pid, flush handlers, settle with
 * `exitCode: -1`.
 *
 * Timeout: independent wall-clock setTimeout. On fire: same teardown,
 * settle with `exitCode: null` (distinguishable from explicit abort).
 *
 * Output streaming: stdout + stderr both feed the parser; `onProgress` is
 * throttled at ~500ms to avoid flooding the webview postMessage channel.
 * tsc writes diagnostics to stdout; stderr is reserved for fatal config
 * errors (exit code 2/3).
 *
 * No I/O on success path beyond the subprocess + binary resolution.
 */

export interface TscRunOptions {
  cwd: string;
  /** User-override command (from `claudeReview.buildSignal.typecheckCommand`).
   *  When non-empty, parsed into argv and used directly — no auto-detection. */
  overrideCommand: string;
  /** Resolved tsconfig from tsconfigResolver. Null ⇒ run is a no-op and
   *  result will indicate "no TypeScript project found". */
  tsconfig: ResolvedTsConfig | null;
  timeoutMs: number;
  signal: AbortSignal;
  logger: Logger;
  /** Throttled progress callbacks during streaming. */
  onProgress?: (partial: { diagnostics: BuildErrorRef[]; projectDiagnostics: BuildErrorRef[] }) => void;
  /** Test seam — inject a custom spawn factory. */
  spawnFn?: typeof spawn;
}

/**
 * v0.5.1 (LH6): discriminator for the run outcome. Callers SHOULD switch
 * on `kind` instead of pattern-matching on `exitCode`. The raw `exitCode`
 * is kept as a debug field but its semantic meaning was scattered in a
 * comment (-2 / -1 / null / 0 / 1 / 2 / 3) — easy to typo.
 */
export type TscRunKind =
  | 'success'        // exitCode 0, no diagnostics
  | 'diagnostics'    // exitCode 1, diagnostics emitted
  | 'error'          // exitCode 2 or 3, fatal config/crash; stderr populated
  | 'aborted'        // user-cancelled via AbortSignal
  | 'timeout'        // wall-clock timeout fired
  | 'no-tsconfig';   // no override + no tsconfig found → no-op

export interface TscRunResult {
  /** v0.5.1: source-of-truth discriminator for the run outcome. */
  kind: TscRunKind;
  /**
   * Raw process exit code (or one of the synthetic sentinels). Kept for
   * debug logs / tests; callers should branch on `kind` instead.
   *   0 = clean, 1 = diagnostics, 2 or 3 = config/crash,
   *   -1 = aborted, null = timeout, -2 = no-tsconfig.
   */
  exitCode: number | null;
  diagnostics: BuildErrorRef[];
  projectDiagnostics: BuildErrorRef[];
  /** When the run was a fast no-op via tsc -b's incremental cache
   *  (sub-second exit, no diagnostics, useBuildMode was on). */
  cached: boolean;
  /** Whatever stderr produced. Surface as project-level warning when kind === 'error'. */
  fatalStderr: string | null;
  durationMs: number;
}

/** v0.5.1: derive the discriminator from a raw exit code + flags. */
function deriveKind(opts: {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  noTsconfig: boolean;
}): TscRunKind {
  if (opts.noTsconfig) return 'no-tsconfig';
  if (opts.aborted) return 'aborted';
  if (opts.timedOut) return 'timeout';
  if (opts.exitCode === 0) return 'success';
  if (opts.exitCode === 1) return 'diagnostics';
  return 'error';
}

const PROGRESS_THROTTLE_MS = 500;
/** Below this duration, a tsc -b run with no output is treated as cached. */
const CACHED_THRESHOLD_MS = 1500;

/** Resolve the tsc binary to spawn. Searches node_modules/.bin first. */
async function resolveTscBinary(cwd: string): Promise<{ bin: string; prefix: string[] }> {
  const isWin = process.platform === 'win32';
  // Try local node_modules first.
  const localCandidates = isWin
    ? [path.join(cwd, 'node_modules', '.bin', 'tsc.cmd'), path.join(cwd, 'node_modules', '.bin', 'tsc')]
    : [path.join(cwd, 'node_modules', '.bin', 'tsc')];
  for (const candidate of localCandidates) {
    try {
      await fs.access(candidate);
      return { bin: candidate, prefix: [] };
    } catch {
      // continue
    }
  }
  // Fall back to npx (lets the system resolve / temporary-install tsc).
  return { bin: isWin ? 'npx.cmd' : 'npx', prefix: ['--no-install', 'tsc'] };
}

/**
 * Build the argv list for tsc. When the user provided an override command,
 * we tokenise it (respecting quotes) and use that verbatim. Otherwise the
 * standard flags assemble per tsconfig mode.
 */
function buildTscArgs(
  overrideCommand: string,
  tsconfig: ResolvedTsConfig | null,
): { argv: string[] | null; usingOverride: boolean } {
  if (overrideCommand.trim().length > 0) {
    const tokens = parseArgv(overrideCommand);
    if (tokens.length === 0) return { argv: null, usingOverride: true };
    return { argv: tokens, usingOverride: true };
  }
  if (!tsconfig) return { argv: null, usingOverride: false };
  // Standard: --noEmit + --pretty false. -p <tsconfig> for project mode,
  // -b for build mode (composite/references). Per the research, -b takes
  // a config path positionally rather than via -p.
  const args = ['--noEmit', '--pretty', 'false'];
  if (tsconfig.useBuildMode) {
    return { argv: ['-b', ...args, tsconfig.configPath], usingOverride: false };
  }
  return { argv: [...args, '-p', tsconfig.configPath], usingOverride: false };
}

export async function runTsc(opts: TscRunOptions): Promise<TscRunResult> {
  const start = Date.now();

  // No tsconfig and no override → degenerate no-op.
  const { argv, usingOverride } = buildTscArgs(opts.overrideCommand, opts.tsconfig);
  if (!argv) {
    opts.logger.debug('buildSignal', 'tsc.no-config', { cwd: opts.cwd });
    return {
      kind: 'no-tsconfig',
      exitCode: -2,
      diagnostics: [],
      projectDiagnostics: [],
      cached: false,
      fatalStderr: null,
      durationMs: Date.now() - start,
    };
  }

  // Resolve the binary unless the user provided their own command.
  let bin: string;
  let finalArgv: string[];
  if (usingOverride) {
    // User-override: first token is the binary, rest are args. cross-spawn
    // handles Windows .cmd resolution automatically when the binary name
    // matches a local script (e.g. 'tsc' → tsc.cmd in PATH or .bin).
    bin = argv[0]!;
    finalArgv = argv.slice(1);
  } else {
    const resolved = await resolveTscBinary(opts.cwd);
    bin = resolved.bin;
    finalArgv = [...resolved.prefix, ...argv];
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
  };

  const spawnFn = opts.spawnFn ?? spawn;
  opts.logger.info('buildSignal', 'tsc.spawn', {
    cwd: opts.cwd, bin, argv: finalArgv, timeoutMs: opts.timeoutMs,
  });

  let child: ChildProcess;
  try {
    child = spawnFn(bin, finalArgv, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached on POSIX so SIGTERM hits the entire process group via
      // tree-kill; on Windows tree-kill uses taskkill /T /F regardless
      // of the detached flag, so it's a POSIX-only need.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    opts.logger.warn('buildSignal', 'tsc.spawn-failed', { err: String(err) });
    return {
      kind: 'error',
      exitCode: 2,
      diagnostics: [],
      projectDiagnostics: [],
      cached: false,
      fatalStderr: `Failed to spawn ${bin}: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  const parser = new TscOutputStreamParser();
  let lastProgressEmit = 0;
  let stderrBuffer = '';

  const emitProgress = (force = false) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    lastProgressEmit = now;
    opts.onProgress(parser.snapshot());
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    parser.feed(chunk);
    emitProgress();
  });
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });

  // Set up cancellation + timeout.
  let timeoutHandle: NodeJS.Timeout | null = null;
  let abortHandler: (() => void) | null = null;
  let aborted = false;
  let timedOut = false;

  const teardown = (kind: 'abort' | 'timeout') => {
    if (kind === 'abort') aborted = true;
    if (kind === 'timeout') timedOut = true;
    if (!child.pid) return;
    // tree-kill works on both platforms; on POSIX it sends to the process
    // group, on Windows it shells out to `taskkill /T /F <pid>`.
    //
    // v0.5.1 (LH14 — security audit comment): `child.pid` is typed
    // `number | undefined` by Node and originates from the kernel via the
    // cross-spawn shim, NOT from user input. tree-kill's Windows path
    // interpolates the pid into a taskkill command string; this is safe
    // because the value is numeric — no shell-injection vector.
    treeKill(child.pid, 'SIGTERM', (err) => {
      if (err) opts.logger.warn('buildSignal', 'tsc.tree-kill.failed', { err: String(err), kind });
    });
  };

  if (opts.signal.aborted) {
    teardown('abort');
  } else {
    abortHandler = () => teardown('abort');
    opts.signal.addEventListener('abort', abortHandler, { once: true });
  }

  if (opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => teardown('timeout'), opts.timeoutMs);
  }

  return new Promise<TscRunResult>((resolve) => {
    // v0.5.1 (LH1): both `error` and `close` can fire on some platforms when
    // the child crashes/spawn-fails. Without this guard, finish() runs
    // twice → parser.done() is called twice (second call returns empty),
    // emitProgress(true) double-posts to the manager, and we waste CPU.
    // The Promise's resolve() is idempotent so no correctness bug, but the
    // double-emit causes UI flicker and ambiguous logs.
    let finished = false;

    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (abortHandler) { opts.signal.removeEventListener('abort', abortHandler); abortHandler = null; }
      // v0.5.1 (LH1): stream data listeners are NOT auto-removed when the
      // child closes on all platforms — Node holds the closed-stream object
      // alive as long as a listener is attached. Over ~50 runs/hour, the
      // accumulated retained stream + closure references creep memory.
      // Explicit removal here lets GC reclaim them on the next cycle.
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      const snapshot = parser.done();
      const durationMs = Date.now() - start;
      // -b incremental cache detection: build-mode + sub-second + no
      // diagnostics + exit 0 = cached run.
      const usedBuildMode = !usingOverride && (opts.tsconfig?.useBuildMode ?? false);
      const cached = usedBuildMode
        && code === 0
        && durationMs < CACHED_THRESHOLD_MS
        && snapshot.diagnostics.length === 0
        && snapshot.projectDiagnostics.length === 0;
      // Emit one final progress so the manager sees the terminal snapshot.
      emitProgress(true);
      const exitCode = aborted ? -1 : (timedOut ? null : code);
      const result: TscRunResult = {
        kind: deriveKind({ aborted, timedOut, exitCode, noTsconfig: false }),
        exitCode,
        diagnostics: snapshot.diagnostics,
        projectDiagnostics: snapshot.projectDiagnostics,
        cached,
        fatalStderr: stderrBuffer.trim().length > 0 ? stderrBuffer : null,
        durationMs,
      };
      opts.logger.info('buildSignal', 'tsc.finished', {
        exitCode: result.exitCode,
        diagnostics: result.diagnostics.length,
        projectDiagnostics: result.projectDiagnostics.length,
        durationMs,
        cached,
      });
      resolve(result);
    };

    child.on('error', (err) => {
      opts.logger.warn('buildSignal', 'tsc.process-error', { err: String(err) });
      // The 'close' event may not fire after 'error' on spawn failure on
      // some platforms; emit a synthetic finish here. Subsequent 'close'
      // (if any) is now idempotent via the `finished` guard above.
      finish(2);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}
