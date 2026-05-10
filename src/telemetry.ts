import * as vscode from 'vscode';

/**
 * Opt-in telemetry (TRD §16.2).
 *
 * Double-gating
 * -------------
 * Events are emitted only when BOTH conditions hold:
 *   1. The user has set `claudeReview.telemetry = "on"`.
 *   2. VS Code's global telemetry is enabled (`vscode.env.isTelemetryEnabled`).
 *
 * Either flip flips off. Honors the user's global preference.
 *
 * Batching
 * --------
 * Events are buffered and flushed at a 10 s interval (or on `flush()`).
 * This avoids one VS Code log call per hook event on the hot path.
 *
 * Privacy
 * -------
 * Properties are filtered through a deny-list (`PII_KEYS`). File paths,
 * tokens, and assistant messages are never recorded. Sessions are
 * referenced by short prefix, never the full UUID.
 */

export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string | number | boolean | undefined>;
  timestamp: number;
}

export interface TelemetryDeps {
  /** Reads `claudeReview.telemetry`. */
  isExtensionEnabled: () => boolean;
  /** Reads VS Code's global setting. */
  isGlobalEnabled: () => boolean;
  /** Sink: typically a structured Output Channel or VS Code TelemetryLogger. */
  sink: (event: TelemetryEvent) => void;
}

const FLUSH_INTERVAL_MS = 10_000;
const PII_KEYS = new Set([
  'apiKey', 'authorization', 'token', 'secret',
  'filePath', 'cwd', 'message', 'lastAssistantMessage', 'content',
]);
const MAX_BUFFER = 1_000;

export class Telemetry {
  private buffer: TelemetryEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TelemetryDeps) {}

  /** Emit one event. Cheap on the hot path (push + maybe schedule flush). */
  event(name: string, properties?: Record<string, unknown>): void {
    if (!this.isOn()) return;
    if (this.buffer.length >= MAX_BUFFER) return; // backpressure: drop rather than grow

    const event: TelemetryEvent = { name, timestamp: Date.now() };
    const scrubbed = scrubProps(properties);
    if (scrubbed !== undefined) event.properties = scrubbed;
    this.buffer.push(event);
    this.scheduleFlush();
  }

  /** Manual flush (e.g. on extension deactivate). */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    for (const ev of batch) {
      try { this.deps.sink(ev); } catch { /* never break the host */ }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  // -- internals ---------------------------------------------------------------

  private isOn(): boolean {
    return this.deps.isExtensionEnabled() && this.deps.isGlobalEnabled();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Allow Node to exit even if we're the only remaining handle.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

function scrubProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean | undefined> | undefined {
  if (!props) return undefined;
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(props)) {
    if (PII_KEYS.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === undefined) {
      out[k] = v;
    }
    // Discard objects/arrays — telemetry is flat-only.
  }
  return out;
}

/**
 * Convenience wrapper: build a Telemetry tied to VS Code's runtime settings.
 * Output goes to the supplied logger so we never spin up a second channel.
 */
export function createTelemetry(
  logEvent: (event: TelemetryEvent) => void,
): Telemetry {
  return new Telemetry({
    isExtensionEnabled: () => vscode.workspace.getConfiguration('claudeReview').get<string>('telemetry') === 'on',
    isGlobalEnabled:    () => vscode.env.isTelemetryEnabled,
    sink: logEvent,
  });
}

/** Exported for tests. */
export const __test = { scrubProps, FLUSH_INTERVAL_MS, MAX_BUFFER };
