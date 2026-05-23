/**
 * v0.5 — unit tests for `tscParser`.
 *
 * Verifies the regex contract, related-info continuation aggregation, ANSI
 * stripping, summary-line filtering, and streaming-mode equivalence with
 * one-shot mode.
 */

import { describe, it, expect } from 'vitest';
import { parseTscOutput, TscOutputStreamParser } from '../../src/buildSignal/tscParser.js';

describe('parseTscOutput — file-anchored diagnostics', () => {
  it('parses a single error line', () => {
    const r = parseTscOutput("src/foo.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.\n");
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]).toEqual({
      relPath: 'src/foo.ts',
      line: 42,
      col: 7,
      code: 2322,
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'.",
    });
    expect(r.projectDiagnostics).toEqual([]);
  });

  it('parses multiple errors in the same file', () => {
    const out = [
      "src/foo.ts(1,1): error TS1: First.",
      "src/foo.ts(2,2): error TS2: Second.",
      "src/foo.ts(3,3): error TS3: Third.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(3);
    expect(r.diagnostics.map((d) => d.code)).toEqual([1, 2, 3]);
  });

  it('parses errors across multiple files', () => {
    const out = [
      "a.ts(1,1): error TS1: A.",
      "b.ts(1,1): error TS2: B.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics.map((d) => d.relPath)).toEqual(['a.ts', 'b.ts']);
  });

  it('normalises Windows backslashes in paths to forward slashes', () => {
    const r = parseTscOutput("src\\nested\\foo.ts(1,1): error TS1: Boom.\n");
    expect(r.diagnostics[0]?.relPath).toBe('src/nested/foo.ts');
  });

  it('handles CRLF line endings', () => {
    const r = parseTscOutput("a.ts(1,1): error TS1: A.\r\nb.ts(2,2): error TS2: B.\r\n");
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics[0]?.message).toBe('A.');
    expect(r.diagnostics[1]?.message).toBe('B.');
  });
});

describe('parseTscOutput — related information', () => {
  it('aggregates indented continuation into the prior diagnostic message', () => {
    const out = [
      "src/foo.ts(10,5): error TS2345: Argument of type X is not assignable.",
      "  'x' was declared here.",
      "  Found in scope: outer.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.message).toBe("Argument of type X is not assignable. 'x' was declared here. Found in scope: outer.");
  });

  it('blank line terminates the continuation anchor', () => {
    const out = [
      "a.ts(1,1): error TS1: First.",
      "  related to first",
      '',
      "  this indented line is orphaned",
      "b.ts(2,2): error TS2: Second.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics[0]?.message).toBe("First. related to first");
    expect(r.diagnostics[1]?.message).toBe("Second.");
  });
});

describe('parseTscOutput — project-level diagnostics', () => {
  it('lands errors with no file anchor in projectDiagnostics', () => {
    const r = parseTscOutput("error TS5023: Unknown compiler option 'foo'.\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.projectDiagnostics.length).toBe(1);
    expect(r.projectDiagnostics[0]).toEqual({
      relPath: '',
      line: 0,
      col: 0,
      code: 5023,
      severity: 'error',
      message: "Unknown compiler option 'foo'.",
      isProjectLevel: true,
    });
  });

  it('mixes file-anchored and project-level diagnostics correctly', () => {
    const out = [
      "error TS5023: Bad option.",
      "src/foo.ts(1,1): error TS1: File error.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.projectDiagnostics.length).toBe(1);
    expect(r.diagnostics.length).toBe(1);
  });
});

describe('parseTscOutput — ANSI + summary filtering', () => {
  it('strips ANSI SGR sequences before regex match', () => {
    // Simulated pretty-mode leak: color codes around the path + sev + code.
    const out = "\x1b[96msrc/foo.ts\x1b[0m(\x1b[1m1\x1b[0m,\x1b[1m1\x1b[0m): \x1b[91merror\x1b[0m TS1: Boom.\n";
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0]?.relPath).toBe('src/foo.ts');
    expect(r.diagnostics[0]?.message).toBe('Boom.');
  });

  it('skips the summary line', () => {
    const out = [
      "a.ts(1,1): error TS1: A.",
      '',
      "Found 1 error in 1 file.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(1);
    // Summary line was filtered, not parsed as a diagnostic.
    expect(r.projectDiagnostics).toEqual([]);
  });
});

describe('parseTscOutput — severity filter', () => {
  it('keeps errors and warnings; drops info/message', () => {
    const out = [
      "a.ts(1,1): error TS1: An error.",
      "a.ts(2,2): warning TS2: A warning.",
      "a.ts(3,3): info TS3: An info.",
      "a.ts(4,4): message TS4: A message.",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(2);
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['error', 'warning']);
  });
});

describe('parseTscOutput — empty / degenerate input', () => {
  it('empty string returns empty arrays', () => {
    const r = parseTscOutput('');
    expect(r).toEqual({ diagnostics: [], projectDiagnostics: [] });
  });

  it('only whitespace returns empty arrays', () => {
    const r = parseTscOutput('\n\n\r\n\n');
    expect(r).toEqual({ diagnostics: [], projectDiagnostics: [] });
  });

  it('garbage lines do not break parsing', () => {
    const out = [
      "> tsc --noEmit --pretty false",
      "Some startup banner.",
      "a.ts(1,1): error TS1: A.",
      "and more garbage",
      '',
    ].join('\n');
    const r = parseTscOutput(out);
    expect(r.diagnostics.length).toBe(1);
  });
});

describe('TscOutputStreamParser — incremental feeds match one-shot', () => {
  const fixture = [
    "a.ts(1,1): error TS1: A.",
    "  related info",
    "b.ts(2,2): warning TS2: B.",
    "error TS5023: Bad config.",
    '',
    "Found 2 errors in 2 files.",
    '',
  ].join('\n');

  it('feed-once equals parseTscOutput', () => {
    const oneShot = parseTscOutput(fixture);
    const stream = new TscOutputStreamParser();
    stream.feed(fixture);
    const streamed = stream.done();
    expect(streamed).toEqual(oneShot);
  });

  it('1-byte chunks produce identical result', () => {
    const stream = new TscOutputStreamParser();
    for (const c of fixture) stream.feed(c);
    const streamed = stream.done();
    const oneShot = parseTscOutput(fixture);
    expect(streamed).toEqual(oneShot);
  });

  it('mid-line chunk boundary preserved', () => {
    const stream = new TscOutputStreamParser();
    const half = Math.floor(fixture.length / 2);
    stream.feed(fixture.slice(0, half));
    stream.feed(fixture.slice(half));
    expect(stream.done()).toEqual(parseTscOutput(fixture));
  });

  it('snapshot() during streaming returns partial-but-consistent state', () => {
    const stream = new TscOutputStreamParser();
    stream.feed("a.ts(1,1): error TS1: A.\n");
    const partial = stream.snapshot();
    expect(partial.diagnostics.length).toBe(1);
    stream.feed("b.ts(2,2): error TS2: B.\n");
    const partial2 = stream.snapshot();
    expect(partial2.diagnostics.length).toBe(2);
  });
});
