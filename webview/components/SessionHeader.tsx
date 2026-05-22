import type { SessionReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import styles from '../styles/SessionHeader.module.css';

interface Props {
  session: SessionReview;
  viewType: 'split' | 'unified';
  banner: string | null;
}

export function SessionHeader({ session, viewType, banner }: Props): JSX.Element {
  const totalHunks = session.metrics.totalHunks;
  const decided = session.metrics.acceptedHunks + session.metrics.rejectedHunks;
  const undoDepth = useUi((s) => s.undoDepth);
  const toggleHelp = useUi((s) => s.toggleHelpVisible);
  const showFlaggedOnly = useUi((s) => s.showFlaggedOnly);
  const setShowFlaggedOnly = useUi((s) => s.setShowFlaggedOnly);
  const wrapLines = useUi((s) => s.wrapLines);
  const setWrapLines = useUi((s) => s.setWrapLines);
  // v0.3: count hunks that carry at least one risk flag — surfaces as a
  // prioritisation hint in the header meta row.
  const flaggedCount = session.files.reduce(
    (acc, f) => acc + f.hunks.filter((h) => (h.flags?.length ?? 0) > 0).length,
    0,
  );
  return (
    <header className={styles.root} role="banner">
      <div className={styles.titleRow}>
        <h1 className={styles.title}>Claude Code Review</h1>
        <span className={styles.meta}>
          Session {session.sessionId.slice(0, 7)} · {session.files.length} file
          {session.files.length === 1 ? '' : 's'} · {decided}/{totalHunks} hunks reviewed
          {flaggedCount > 0 ? (
            <>
              {' · '}
              <span
                className={styles.flaggedSummary}
                title="Hunks with risk flags (sensitive paths, deletions, removed error handling, etc.). Review these first."
              >
                {flaggedCount} flagged
              </span>
            </>
          ) : null}
        </span>
      </div>
      {banner ? <p className={styles.banner}>{banner}</p> : null}
      <div className={styles.actions}>
        <ToggleViewType current={viewType} />
        {/* v0.4 (Wave 4): show-flagged-only filter (file-level; L3). */}
        <button
          className={styles.toggle}
          onClick={() => setShowFlaggedOnly(!showFlaggedOnly)}
          aria-pressed={showFlaggedOnly}
          title={showFlaggedOnly ? 'Show all files' : 'Show only flagged files'}
        >
          🏷 {showFlaggedOnly ? 'All files' : 'Flagged only'}
        </button>
        {/* v0.4 (Wave 4): wrap-long-lines toggle. */}
        <button
          className={styles.toggle}
          onClick={() => setWrapLines(!wrapLines)}
          aria-pressed={wrapLines}
          title={wrapLines ? 'Stop wrapping long lines' : 'Wrap long lines instead of clipping'}
        >
          ⏎ {wrapLines ? 'Wrap on' : 'Wrap off'}
        </button>
        <button
          className={styles.bulk}
          onClick={() => send({ type: 'accept-all' })}
          aria-label="Accept all hunks in this session"
        >
          ✓ Accept all
        </button>
        <button
          className={styles.bulk}
          onClick={() => send({ type: 'reject-all' })}
          aria-label="Reject all hunks in this session"
        >
          ✗ Reject all
        </button>
        <button
          className={styles.bulk}
          onClick={() => send({ type: 'undo-last-action' })}
          disabled={undoDepth === 0}
          aria-label="Undo last action"
          title={undoDepth === 0 ? 'No actions to undo' : `Undo last action (${undoDepth} in history)`}
        >
          ↶ Undo{undoDepth > 0 ? ` (${undoDepth})` : ''}
        </button>
        {/* v0.2.1: discoverability entry to the History panel. */}
        <button
          className={styles.historyButton}
          onClick={() => send({ type: 'open-history' })}
          aria-label="Open History Panel"
          title="Open History Panel — browse past sessions and resume/rollback/delete"
        >
          📜 History
        </button>
        {/* v0.3: discoverability entry to the keyboard shortcuts help overlay. */}
        <button
          className={styles.helpButton}
          onClick={() => toggleHelp()}
          aria-label="Show keyboard shortcuts"
          title="Keyboard shortcuts (press ? to toggle)"
        >
          ⌨
        </button>
      </div>
    </header>
  );
}

function ToggleViewType({ current }: { current: 'split' | 'unified' }): JSX.Element {
  const next = current === 'split' ? 'unified' : 'split';
  return (
    <button
      className={styles.toggle}
      onClick={() => send({ type: 'set-view-type', viewType: next })}
      aria-label={`Switch to ${next} diff view`}
    >
      {current === 'split' ? 'Split' : 'Unified'} view
    </button>
  );
}
