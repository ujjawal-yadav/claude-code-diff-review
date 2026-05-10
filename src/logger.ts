import * as vscode from 'vscode';

/**
 * Structured logger (TRD §16.1).
 *
 * Emits JSON-line records into a single OutputChannel. A redactor strips
 * fields that may contain secrets (apiKey, authorization, bearer*) at any
 * depth before serialisation.
 *
 * Performance: a hot-path call is two `JSON.stringify`s and one
 * `appendLine`. The redactor walks the object once, never deeper than
 * MAX_REDACTOR_DEPTH to bound cost on adversarial inputs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_RX = /^(api[_-]?key|authorization|bearer.*|secret|token)$/i;
const MAX_REDACTOR_DEPTH = 6;

export interface LogRecord {
  ts: string;
  lvl: LogLevel;
  src: string;
  evt: string;
  [k: string]: unknown;
}

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private threshold: number;

  constructor(channelName: string, level: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel(channelName);
    this.threshold = LEVELS[level];
  }

  setLevel(level: LogLevel): void {
    this.threshold = LEVELS[level];
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  debug(src: string, evt: string, props?: Record<string, unknown>): void { this.write('debug', src, evt, props); }
  info (src: string, evt: string, props?: Record<string, unknown>): void { this.write('info',  src, evt, props); }
  warn (src: string, evt: string, props?: Record<string, unknown>): void { this.write('warn',  src, evt, props); }
  error(src: string, evt: string, props?: Record<string, unknown>): void { this.write('error', src, evt, props); }

  private write(lvl: LogLevel, src: string, evt: string, props: Record<string, unknown> | undefined): void {
    if (LEVELS[lvl] < this.threshold) return;
    const safeProps = props ? redact(props, 0) : undefined;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      lvl,
      src,
      evt,
      ...(safeProps as Record<string, unknown> | undefined),
    };
    try {
      this.channel.appendLine(JSON.stringify(record));
    } catch {
      // The OutputChannel may be in the process of being disposed (extension
      // host shutdown) and `appendLine` throws "Channel has been closed".
      // Final defence — swallow rather than crash deactivation.
      try {
        this.channel.appendLine(`{"ts":"${record.ts}","lvl":"${lvl}","src":"${src}","evt":"${evt}","_logSerializeFailed":true}`);
      } catch { /* host channel is gone; nothing to do */ }
    }
  }
}

function redact(value: unknown, depth: number): unknown {
  if (depth >= MAX_REDACTOR_DEPTH) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RX.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Exported for unit tests only. */
export const __test = { redact };
