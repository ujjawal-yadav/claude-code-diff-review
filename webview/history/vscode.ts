/**
 * Webview-side VS Code API bridge for the History panel.
 *
 * `acquireVsCodeApi` is already declared as a Window member in
 * `webview/vscode.ts` (for the review panel). We don't re-declare it here
 * — that would conflict with the existing declaration. Instead we cast
 * through `unknown` to apply our History-specific message type.
 */
import type { HistoryWebviewToHost } from '../../src/messages.js';

interface HistoryVsCodeApi {
  postMessage(msg: HistoryWebviewToHost): void;
  setState<T>(state: T): void;
  getState<T>(): T | undefined;
}

const api: HistoryVsCodeApi = (() => {
  const w = window as unknown as { acquireVsCodeApi?: () => unknown };
  if (typeof w.acquireVsCodeApi === 'function') {
    return w.acquireVsCodeApi() as HistoryVsCodeApi;
  }
  return {
    postMessage: () => undefined,
    setState: () => undefined,
    getState: () => undefined,
  };
})();

export const vscode = api;
