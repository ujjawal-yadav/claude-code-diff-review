/**
 * History webview entry (Phase α M9.2.8).
 *
 * Read-mostly UI: list sessions, click → load events, render turn timeline
 * with file-level decision counts. No diff-rendering here — that's Phase β
 * Revisit surface. Goal: enough to answer "which turn was I in?" for
 * crash recovery + a basic audit trail.
 */

import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './App.js';

window.addEventListener('error', (e) => {
  console.error('[claudeReviewHistory] error', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[claudeReviewHistory] unhandledrejection', e.reason);
});

const root = document.getElementById('root');
if (root) {
  try {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    root.textContent = `History panel failed to mount: ${String(err)}`;
  }
}
