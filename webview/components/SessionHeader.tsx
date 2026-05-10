import type { SessionReview } from '../../src/types';
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
  return (
    <header className={styles.root} role="banner">
      <div className={styles.titleRow}>
        <h1 className={styles.title}>Claude Code Review</h1>
        <span className={styles.meta}>
          Session {session.sessionId.slice(0, 7)} · {session.files.length} file
          {session.files.length === 1 ? '' : 's'} · {decided}/{totalHunks} hunks reviewed
        </span>
      </div>
      {banner ? <p className={styles.banner}>{banner}</p> : null}
      <div className={styles.actions}>
        <ToggleViewType current={viewType} />
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
