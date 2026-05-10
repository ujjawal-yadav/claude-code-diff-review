import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/global.css';

// Last-resort top-level guard: if importing or React mounting itself throws,
// at least surface the error inside the panel instead of going dark.
function showFatal(message: string, stack?: string): void {
  const root = document.getElementById('root') ?? document.body;
  root.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:16px;font-family:monospace;color:#f14c4c;';
  wrap.innerHTML = `
    <h2 style="margin-top:0;">Review panel failed to start</h2>
    <p><strong>${escapeHtml(message)}</strong></p>
    ${stack ? `<pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(stack)}</pre>` : ''}
    <p style="color:#888;">Open Developer: Webview Developer Tools and check the Console.</p>
  `;
  root.appendChild(wrap);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

window.addEventListener('error', (e) => showFatal(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason), (e.reason as Error)?.stack));

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing in webview HTML');
  root.textContent = '';
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  showFatal((err as Error).message, (err as Error).stack);
}
