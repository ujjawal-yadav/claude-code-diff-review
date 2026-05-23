/**
 * v0.5 — TypeScript compiler output parser.
 *
 * tsc has no JSON / machine-readable output mode (see
 * microsoft/TypeScript#46340). The text format with `--pretty false` is
 * the contract:
 *
 *   <path>(<line>,<col>): <severity> TS<code>: <message>
 *
 * Path is workspace-relative, forward-slash even on Windows; line/col are
 * 1-based. Diagnostics with no file anchor omit the `(line,col)` prefix:
 *
 *   error TS5023: Unknown compiler option 'foo'.
 *
 * Related information (e.g. `'x' is declared here.`) emits as additional
 * lines INDENTED below the primary diagnostic. We aggregate continuations
 * into the prior diagnostic's message.
 *
 * Belt-and-braces: we ALSO strip ANSI escape codes in case `--pretty false`
 * was ignored by an old tsc or some unusual TTY-detection sneaked through.
 *
 * Streaming mode: `TscOutputStreamParser` feeds bytes line-by-line as they
 * arrive from the subprocess so the panel can surface partial results
 * while tsc finishes (a large repo can take 30+ seconds).
 *
 * Purity: both modes are zero-I/O, zero-globals. Safe to call from tests.
 */

import type { BuildErrorRef } from '../types.js';

/**
 * Diagnostic with file anchor.
 *
 * v0.5.1 (LH12): the message group is bounded `{0,8192}` to defang
 * adversarial / pathologically long tsc output. Unbounded `.*` risks
 * catastrophic backtracking on inputs that almost-but-not-quite match
 * subsequent regex anchors. 8 KB is generous — real tsc diagnostics
 * top out around 1 KB even with elaborated type info.
 */
const DIAG_RE = /^(?<file>[^()\r\n]+?)\((?<line>\d+),(?<col>\d+)\):\s(?<sev>error|warning|message|info)\sTS(?<code>\d+):\s(?<msg>.{0,8192})$/;
/** Project-level diagnostic (no file:line). Same cap as DIAG_RE. */
const PROJ_DIAG_RE = /^(?<sev>error|warning|message|info)\sTS(?<code>\d+):\s(?<msg>.{0,8192})$/;
/** Strips standard SGR / CSI ANSI escape sequences. The `no-control-regex`
 *  rule flags literal ESC; we use a constructed RegExp so the lint warning
 *  doesn't fire while the runtime behaviour is identical. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** Summary line we explicitly skip. */
const SUMMARY_RE = /^Found \d+ errors? in \d+ files?\.$/;

export interface ParsedTscOutput {
  /** Diagnostics anchored to a file:line. */
  diagnostics: BuildErrorRef[];
  /** Project-level diagnostics (config errors, etc.) — no file:line. */
  projectDiagnostics: BuildErrorRef[];
}

/** One-shot parse. Use for tests / when you have the full output as a string. */
export function parseTscOutput(raw: string): ParsedTscOutput {
  const parser = new TscOutputStreamParser();
  parser.feed(raw);
  return parser.done();
}

/**
 * Incremental stream parser. Call `feed()` with each chunk of bytes as they
 * arrive from the subprocess (chunks need not be line-aligned); call
 * `done()` after the subprocess exits to flush any tail-buffer.
 *
 * `snapshot()` returns the partial state safely at any point — used by the
 * runner to fire `onProgress` callbacks at a throttled cadence.
 */
export class TscOutputStreamParser {
  private buffer = '';
  private readonly diagnostics: BuildErrorRef[] = [];
  private readonly projectDiagnostics: BuildErrorRef[] = [];
  /** Index of the most recent diagnostic — for related-info continuation. */
  private lastDiagIndex: number | null = null;
  private lastDiagBucket: 'file' | 'project' | null = null;

  feed(chunk: string): void {
    this.buffer += chunk;
    // Process complete lines; keep any trailing partial line for the next chunk.
    let nlIndex: number;
    while ((nlIndex = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, nlIndex);
      this.buffer = this.buffer.slice(nlIndex + 1);
      this.processLine(rawLine);
    }
  }

  done(): ParsedTscOutput {
    // Flush any tail without a trailing newline.
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = '';
    }
    return this.snapshot();
  }

  snapshot(): ParsedTscOutput {
    return {
      diagnostics: this.diagnostics.slice(),
      projectDiagnostics: this.projectDiagnostics.slice(),
    };
  }

  private processLine(rawLine: string): void {
    // Strip ANSI defensively + trim trailing \r (Windows line endings).
    const line = rawLine.replace(ANSI_RE, '').replace(/\r$/, '');
    if (line.length === 0) {
      // Blank line — terminates any open related-info continuation.
      this.lastDiagIndex = null;
      this.lastDiagBucket = null;
      return;
    }

    // Indented continuation = related information for the most recent diagnostic.
    // Tabs and 2+ spaces both qualify (tsc's pretty-output indents with two spaces;
    // related-info lines on `--pretty false` start with `  ` or `\t`).
    if (this.lastDiagIndex !== null && /^[\s\t]/.test(line)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      const bucket = this.lastDiagBucket === 'project' ? this.projectDiagnostics : this.diagnostics;
      const existing = bucket[this.lastDiagIndex];
      if (existing) {
        existing.message = existing.message + ' ' + trimmed;
      }
      return;
    }

    // Skip summary line ("Found N errors in M files.").
    if (SUMMARY_RE.test(line)) {
      this.lastDiagIndex = null;
      this.lastDiagBucket = null;
      return;
    }

    // Try file-anchored diagnostic.
    const m = DIAG_RE.exec(line);
    if (m && m.groups) {
      const sev = m.groups.sev as 'error' | 'warning' | 'message' | 'info';
      // Only surface errors + warnings — `message` / `info` aren't actionable.
      if (sev === 'error' || sev === 'warning') {
        const file = m.groups.file!;
        // Normalise to forward slashes (tsc already does this on Windows,
        // but the user-override command path may differ).
        const relPath = file.replace(/\\/g, '/');
        const entry: BuildErrorRef = {
          relPath,
          line: Number.parseInt(m.groups.line!, 10),
          col: Number.parseInt(m.groups.col!, 10),
          code: Number.parseInt(m.groups.code!, 10),
          severity: sev,
          message: m.groups.msg!,
        };
        this.diagnostics.push(entry);
        this.lastDiagIndex = this.diagnostics.length - 1;
        this.lastDiagBucket = 'file';
        return;
      }
      // info/message — reset continuation anchor; don't push.
      this.lastDiagIndex = null;
      this.lastDiagBucket = null;
      return;
    }

    // Try project-level (no file anchor).
    const pm = PROJ_DIAG_RE.exec(line);
    if (pm && pm.groups) {
      const sev = pm.groups.sev as 'error' | 'warning' | 'message' | 'info';
      if (sev === 'error' || sev === 'warning') {
        const entry: BuildErrorRef = {
          relPath: '',
          line: 0,
          col: 0,
          code: Number.parseInt(pm.groups.code!, 10),
          severity: sev,
          message: pm.groups.msg!,
          // v0.5.1 (LH7): explicit project-level flag (avoids sentinel-value
          // pattern-matching downstream).
          isProjectLevel: true,
        };
        this.projectDiagnostics.push(entry);
        this.lastDiagIndex = this.projectDiagnostics.length - 1;
        this.lastDiagBucket = 'project';
        return;
      }
      this.lastDiagIndex = null;
      this.lastDiagBucket = null;
      return;
    }

    // Unknown line — could be `> tsc --noEmit` echo on Windows shells, a
    // blank-prefixed startup banner, or a free-form rendered-ansi line.
    // Reset the continuation anchor so a subsequent indented line doesn't
    // attach to a stale diagnostic.
    this.lastDiagIndex = null;
    this.lastDiagBucket = null;
  }
}

/** Exported for unit tests. */
export const __test = { DIAG_RE, PROJ_DIAG_RE, ANSI_RE, SUMMARY_RE };
