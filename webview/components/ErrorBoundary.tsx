import { Component, ReactNode } from 'react';
import { send } from '../vscode';

/**
 * Visible error boundary so a render-time crash doesn't leave the panel blank.
 *
 * Without this, a thrown exception during render unmounts the React tree
 * and the user sees an empty webview with no clue what went wrong.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    this.setState({ error, info: info.componentStack ?? null });
    // Surface to host so it ends up in the Output Channel too.
    try {
      send({ type: 'log', level: 'warn', msg: `webview render crashed: ${error.message}` });
    } catch { /* noop — boundary itself must never throw */ }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{
          padding: 16,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: 'var(--vscode-errorForeground, #f14c4c)',
          background: 'var(--vscode-editor-background)',
          minHeight: '100vh',
        }}>
          <h2 style={{ marginTop: 0 }}>Review panel crashed</h2>
          <p><strong>Error:</strong> {this.state.error.message}</p>
          {this.state.error.stack ? (
            <pre style={{
              whiteSpace: 'pre-wrap',
              fontSize: 11,
              padding: 8,
              background: 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08))',
              borderRadius: 3,
              overflowX: 'auto',
            }}>{this.state.error.stack}</pre>
          ) : null}
          {this.state.info ? (
            <details>
              <summary>Component stack</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{this.state.info}</pre>
            </details>
          ) : null}
          <p style={{ marginTop: 16, color: 'var(--vscode-descriptionForeground)' }}>
            Reload the dev host and report this trace.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
