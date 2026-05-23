/**
 * v0.3 — keyboard shortcuts help overlay.
 *
 * Modal-style panel listing the keybindings registered by the global
 * keydown handler in App.tsx. Toggled via `?` (Shift+/) or via the Help
 * button in SessionHeader. Esc dismisses.
 *
 * Pure presentational component — reads `helpVisible` from the store and
 * calls `setHelpVisible(false)` on dismiss.
 */

import { useEffect } from 'react';
import { useUi } from '../store';
import styles from '../styles/KeyboardShortcutsHelp.module.css';

interface Binding {
  keys: string[];
  description: string;
}

const BINDINGS: ReadonlyArray<Binding> = [
  { keys: ['j', '↓'],          description: 'Next hunk (spills to next file)' },
  { keys: ['k', '↑'],          description: 'Previous hunk (spills to previous file)' },
  { keys: ['Shift+J'],         description: 'Next flagged hunk (skips unflagged)' },
  { keys: ['Shift+K'],         description: 'Previous flagged hunk' },
  { keys: ['Shift+N'],         description: 'Next hunk affecting failing tsc (v0.5)' },
  { keys: ['Shift+P'],         description: 'Previous hunk affecting failing tsc (v0.5)' },
  { keys: ['a'],               description: 'Accept selected hunk' },
  { keys: ['r'],               description: 'Reject selected hunk' },
  { keys: ['e'],               description: 'Edit selected hunk in place (v0.4)' },
  { keys: ['?'],               description: 'Open chat for selected hunk' },
  { keys: ['Space'],           description: 'Toggle expand/collapse selected file' },
  { keys: ['Esc'],             description: 'Close chat overlay / dismiss this help' },
  { keys: ['Shift+/'],         description: 'Show / hide this help overlay' },
];

export function KeyboardShortcutsHelp(): JSX.Element | null {
  const helpVisible = useUi((s) => s.helpVisible);
  const setHelpVisible = useUi((s) => s.setHelpVisible);

  useEffect(() => {
    if (!helpVisible) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        setHelpVisible(false);
        ev.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpVisible, setHelpVisible]);

  if (!helpVisible) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={() => setHelpVisible(false)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
    >
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 id="kbd-help-title" className={styles.title}>Keyboard shortcuts</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => setHelpVisible(false)}
            aria-label="Close help"
          >×</button>
        </header>
        <table className={styles.table}>
          <tbody>
            {BINDINGS.map((b, i) => (
              <tr key={i}>
                <td className={styles.keyCell}>
                  {b.keys.map((k, j) => (
                    <kbd key={j} className={styles.kbd}>{k}</kbd>
                  ))}
                </td>
                <td className={styles.descCell}>{b.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.footer}>
          Shortcuts are inactive while typing in the chat input (Esc still closes the chat).
        </p>
      </div>
    </div>
  );
}
