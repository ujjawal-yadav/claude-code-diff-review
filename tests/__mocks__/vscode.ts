/**
 * Minimal `vscode` API stub for unit/integration tests.
 *
 * Only the surface we actually use is implemented. Adding here is cheaper
 * than spinning up @vscode/test-electron for every test.
 */

interface OutputChannelStub {
  name: string;
  lines: string[];
  appendLine(line: string): void;
  show(): void;
  dispose(): void;
}

const channels: OutputChannelStub[] = [];

export const window = {
  createOutputChannel(name: string): OutputChannelStub {
    const ch: OutputChannelStub = {
      name,
      lines: [],
      appendLine(line) { this.lines.push(line); },
      show() { /* noop */ },
      dispose() { /* noop */ },
    };
    channels.push(ch);
    return ch;
  },
  showInformationMessage: (_msg: string) => Promise.resolve(undefined),
  showWarningMessage:     (_msg: string) => Promise.resolve(undefined),
  showErrorMessage:       (_msg: string) => Promise.resolve(undefined),
  showInputBox:           (_opts: unknown) => Promise.resolve<string | undefined>(undefined),
};

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, fallback?: T) => fallback,
  }),
  workspaceFolders: undefined,
};

export const commands = {
  registerCommand: (_id: string, _fn: unknown) => ({ dispose() { /* noop */ } }),
};

export const languages = {
  registerCodeLensProvider: (_selector: unknown, _provider: unknown) => ({ dispose() { /* noop */ } }),
};

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  start: Position;
  end:   Position;
  constructor(start: Position | { line: number; character: number }, end: Position | { line: number; character: number }) {
    this.start = start instanceof Position ? start : new Position(start.line, start.character);
    this.end   = end   instanceof Position ? end   : new Position(end.line,   end.character);
  }
}

export class CodeLens {
  constructor(public range: Range, public command?: { title: string; command: string; arguments?: unknown[]; tooltip?: string }) {}
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(e: T): void { for (const l of this.listeners) l(e); }
  dispose(): void { this.listeners = []; }
}

/** Test helpers (not part of the real API). */
export const __mock = {
  channels,
  reset(): void { channels.length = 0; },
};
