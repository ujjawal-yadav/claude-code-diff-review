import type { HostToWebview, WebviewToHost } from '../src/messages';

/**
 * Thin wrapper over the VS Code webview API.
 *
 * The host injects `acquireVsCodeApi()` once per webview load.
 */

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}

declare global {
  interface Window {
    acquireVsCodeApi: () => VsCodeApi;
  }
}

let api: VsCodeApi | null = null;

export function getVsCode(): VsCodeApi {
  if (api) return api;
  api = window.acquireVsCodeApi();
  return api;
}

export function send(msg: WebviewToHost): void {
  getVsCode().postMessage(msg);
}

/**
 * Persisted webview state (TRD §10.4). Survives VS Code restarts as long as
 * the panel hasn't been disposed. Use for ephemeral UI prefs like sidebar
 * width — anything trust-sensitive must stay on the host.
 */
export function getPersistedState<T>(): T | undefined {
  return getVsCode().getState<T>();
}
export function setPersistedState(state: unknown): void {
  getVsCode().setState(state);
}

export type { HostToWebview, WebviewToHost };
