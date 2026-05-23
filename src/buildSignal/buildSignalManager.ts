import type { Logger } from '../logger.js';
import type {
  AbsPath, BuildErrorRef, BuildSignal, BuildStatus,
  FileReview, SessionId, SessionReview,
} from '../types.js';
import { intersectDiagnosticsWithHunks, type HunkCoordSnapshot } from './intersectHunks.js';
import { resolveTsconfig } from './tsconfigResolver.js';
import { runTsc } from './tscRunner.js';

/**
 * v0.5 — per-session lifecycle manager for the build-signal runner.
 *
 * One in-flight tsc run per session at a time (L16). A subsequent
 * `start(sid, ...)` cancels the prior run for that sid then spawns afresh.
 *
 * Cancellation discipline (L15): every run carries an AbortController.
 *   - `cancel(sid)` aborts the current run for one session.
 *   - `dispose()` aborts every in-flight run (extension.deactivate).
 *   - The runner's wall-clock timeout (L8) fires independently.
 *
 * The manager mutates the orchestrator's live FileReview / HunkReview
 * objects in place (per L9 — reuse `postFileUpdated`). It does NOT touch
 * `hunk.status` — only `file.buildStatus`, `hunk.buildErrors`, and the
 * session-level `review.buildSignal`. User decisions made between Stop
 * and tsc-complete are preserved.
 *
 * The host emits a `build-signal` HostToWebview message via the panel
 * gateway whenever the aggregate state changes (start, throttled
 * progress, finish). Per-file changes ride along on `file-updated`.
 */

export interface BuildSignalPanel {
  postFileUpdated(sessionId: SessionId, filePath: AbsPath, file: FileReview): void;
  postBuildSignal(sessionId: SessionId, signal: BuildSignal): void;
}

export interface BuildSignalManagerDeps {
  logger: Logger;
  panel: BuildSignalPanel;
  /** Injectable for tests. */
  runTsc?: typeof runTsc;
  resolveTsconfig?: typeof resolveTsconfig;
}

export interface BuildSignalManagerOptions {
  enabled: boolean;
  timeoutMs: number;
  overrideCommand: string;
}

interface RunHandle {
  abort: AbortController;
  startedAt: number;
  /**
   * v0.5.1 (LH2): per-file hunk coords captured at start(). Pinned to the
   * file state tsc reads. Without this, an in-flight edit mutates
   * hunk.newStart / newLines, then intersectDiagnosticsWithHunks (running
   * AFTER tsc finishes) reads the mutated values and mis-attributes
   * diagnostics.
   */
  coordSnapshot: HunkCoordSnapshot;
}

export class BuildSignalManager {
  private readonly runs = new Map<SessionId, RunHandle>();
  private opts: BuildSignalManagerOptions;
  private readonly runTscFn: typeof runTsc;
  private readonly resolveTsconfigFn: typeof resolveTsconfig;

  constructor(
    private readonly deps: BuildSignalManagerDeps,
    initialOpts: BuildSignalManagerOptions,
  ) {
    this.opts = initialOpts;
    this.runTscFn = deps.runTsc ?? runTsc;
    this.resolveTsconfigFn = deps.resolveTsconfig ?? resolveTsconfig;
  }

  /** Hot-reload from `onDidChangeConfiguration`. */
  updateOptions(next: BuildSignalManagerOptions): void {
    const wasEnabled = this.opts.enabled;
    this.opts = next;
    // Flip from enabled→disabled cancels all in-flight runs.
    if (wasEnabled && !next.enabled) {
      for (const sid of Array.from(this.runs.keys())) this.cancel(sid);
    }
  }

  /** True when the runner is gated off via config. */
  isEnabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * Spawn tsc for this session. Cancels any in-flight run first. Returns
   * immediately; the run completes asynchronously and updates state via
   * the panel gateway.
   */
  start(sid: SessionId, review: SessionReview): void {
    if (!this.opts.enabled) {
      this.deps.logger.debug('buildSignal', 'manager.skip.disabled', { sid });
      return;
    }
    // Cancel prior run for this session.
    this.cancel(sid);

    const startedAt = Date.now();
    const abort = new AbortController();
    // v0.5.1 (LH2): pin hunk coords at start-time. If the user edits a hunk
    // while tsc is running, `hunk.newStart`/`hunk.newLines` mutate in-place
    // on the live FileReview. The snapshot lets `intersectDiagnosticsWithHunks`
    // map tsc-time diagnostics against tsc-time coords — not post-edit coords.
    const coordSnapshot: HunkCoordSnapshot = new Map();
    for (const f of review.files) {
      coordSnapshot.set(f.relPath, f.hunks.map((h) => ({
        index: h.index,
        newStart: h.newStart,
        newLines: h.newLines,
      })));
    }
    this.runs.set(sid, { abort, startedAt, coordSnapshot });

    // Initialize the aggregate signal and seed per-file 'running' status.
    const signal: BuildSignal = {
      status: 'running',
      startedAt,
      finishedAt: null,
      totalErrors: 0,
      totalWarnings: 0,
      projectDiagnostics: [],
      fatalStderr: null,
    };
    review.buildSignal = signal;
    for (const f of review.files) {
      f.buildStatus = 'running';
    }
    this.deps.panel.postBuildSignal(sid, signal);

    void this.runLoop(sid, review, abort.signal, startedAt);
  }

  /** Cancel any in-flight run for `sid`. Idempotent. */
  cancel(sid: SessionId): void {
    const handle = this.runs.get(sid);
    if (!handle) return;
    handle.abort.abort();
    this.runs.delete(sid);
    this.deps.logger.debug('buildSignal', 'manager.cancelled', { sid });
    // Post an aggregate 'unknown' so the banner stops showing 'running'
    // forever after cancel. The runLoop's finalize path won't fire for
    // this run anymore (race-guard drops superseded results), so we
    // settle the aggregate here.
    const sig: BuildSignal = {
      status: 'unknown',
      startedAt: handle.startedAt,
      finishedAt: Date.now(),
      totalErrors: 0,
      totalWarnings: 0,
      projectDiagnostics: [],
      fatalStderr: null,
    };
    this.deps.panel.postBuildSignal(sid, sig);
  }

  /** Cancel every in-flight run. Called from extension.deactivate. */
  dispose(): void {
    for (const sid of Array.from(this.runs.keys())) this.cancel(sid);
  }

  /** Number of in-flight runs. Test/inspection helper. */
  size(): number {
    return this.runs.size;
  }

  // -- internals ----------------------------------------------------------

  private async runLoop(
    sid: SessionId,
    review: SessionReview,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<void> {
    try {
      const tsconfig = await this.resolveTsconfigFn(review.cwd, this.deps.logger);

      // Race-guard: if a newer run replaced this handle, drop.
      const handle = this.runs.get(sid);
      if (!handle || handle.startedAt !== startedAt) return;

      const result = await this.runTscFn({
        cwd: review.cwd,
        overrideCommand: this.opts.overrideCommand,
        tsconfig,
        timeoutMs: this.opts.timeoutMs,
        signal,
        logger: this.deps.logger,
        onProgress: (partial) => this.onProgress(sid, review, partial, startedAt),
      });

      // Race-guard again after await.
      const handleAfter = this.runs.get(sid);
      if (!handleAfter || handleAfter.startedAt !== startedAt) return;
      this.runs.delete(sid);

      this.finalize(sid, review, result, startedAt, handleAfter.coordSnapshot);
    } catch (err) {
      this.deps.logger.warn('buildSignal', 'manager.run.error', { sid, err: String(err) });
      const handle = this.runs.get(sid);
      if (handle && handle.startedAt === startedAt) {
        this.runs.delete(sid);
        // Settle as 'unknown' on unexpected error.
        const sig: BuildSignal = {
          status: 'unknown',
          startedAt,
          finishedAt: Date.now(),
          totalErrors: 0,
          totalWarnings: 0,
          projectDiagnostics: [],
          fatalStderr: String(err),
        };
        review.buildSignal = sig;
        for (const f of review.files) {
          f.buildStatus = 'unknown';
          this.deps.panel.postFileUpdated(sid, f.filePath, f);
        }
        this.deps.panel.postBuildSignal(sid, sig);
      }
    }
  }

  private onProgress(
    sid: SessionId,
    review: SessionReview,
    partial: { diagnostics: BuildErrorRef[]; projectDiagnostics: BuildErrorRef[] },
    startedAt: number,
  ): void {
    // Race-guard: drop progress from a superseded run.
    const handle = this.runs.get(sid);
    if (!handle || handle.startedAt !== startedAt) return;
    if (!review.buildSignal) return;
    const errors = partial.diagnostics.filter((d) => d.severity === 'error').length
      + partial.projectDiagnostics.filter((d) => d.severity === 'error').length;
    const warnings = partial.diagnostics.filter((d) => d.severity === 'warning').length
      + partial.projectDiagnostics.filter((d) => d.severity === 'warning').length;
    review.buildSignal.totalErrors = errors;
    review.buildSignal.totalWarnings = warnings;
    review.buildSignal.projectDiagnostics = partial.projectDiagnostics.slice();
    this.deps.panel.postBuildSignal(sid, review.buildSignal);
  }

  private finalize(
    sid: SessionId,
    review: SessionReview,
    result: Awaited<ReturnType<typeof runTsc>>,
    startedAt: number,
    coordSnapshot: HunkCoordSnapshot,
  ): void {
    // v0.5.1 (LH6): switch on the discriminator instead of pattern-matching
    // on raw exit codes. `kind` is the source of truth; exitCode is debug.
    let aggregate: BuildStatus;
    switch (result.kind) {
      case 'success':
        aggregate = 'pass';
        break;
      case 'diagnostics':
        aggregate = 'fail';
        break;
      case 'aborted':
      case 'timeout':
      case 'no-tsconfig':
      case 'error':
        // All non-clean / non-diagnostic outcomes collapse to 'unknown' at
        // the per-file level. Project-level stderr surfaces via fatalStderr
        // on the aggregate banner.
        aggregate = 'unknown';
        break;
    }

    // Intersect diagnostics with hunks ONLY when tsc actually emitted them
    // (exit 0 or 1). On 'unknown' (abort/timeout/crash), leave hunks empty.
    if (aggregate === 'pass' || aggregate === 'fail') {
      // v0.5.1 (LH2): use the start-time coord snapshot so an in-flight
      // hunk edit during typecheck doesn't mis-attribute diagnostics.
      intersectDiagnosticsWithHunks(review.files, result.diagnostics, coordSnapshot);
    } else {
      for (const f of review.files) {
        f.buildStatus = 'unknown';
        for (const h of f.hunks) {
          if (h.buildErrors !== undefined) delete h.buildErrors;
        }
      }
    }

    // Per-file post.
    for (const f of review.files) {
      this.deps.panel.postFileUpdated(sid, f.filePath, f);
    }

    // Update the aggregate.
    const totalErrors = result.diagnostics.filter((d) => d.severity === 'error').length
      + result.projectDiagnostics.filter((d) => d.severity === 'error').length;
    const totalWarnings = result.diagnostics.filter((d) => d.severity === 'warning').length
      + result.projectDiagnostics.filter((d) => d.severity === 'warning').length;
    const sig: BuildSignal = {
      status: aggregate,
      startedAt,
      finishedAt: Date.now(),
      totalErrors,
      totalWarnings,
      projectDiagnostics: result.projectDiagnostics,
      fatalStderr: result.fatalStderr,
      ...(result.cached ? { cached: true } : {}),
    };
    review.buildSignal = sig;
    this.deps.panel.postBuildSignal(sid, sig);
  }
}
