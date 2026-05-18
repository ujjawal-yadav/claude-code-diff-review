import type { SessionIndexEntry } from '../../../src/history/historyTypes.js';

interface SessionListProps {
  sessions: SessionIndexEntry[] | null;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: SessionListProps): JSX.Element {
  if (sessions == null) return <div style={styles.loading}>Loading…</div>;
  if (sessions.length === 0) return <div style={styles.loading}>No sessions yet.</div>;

  const sorted = [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt);

  return (
    <ul style={styles.list}>
      {sorted.map((s) => {
        const isSelected = s.sessionId === selectedId;
        return (
          <li key={s.sessionId}>
            <button
              type="button"
              onClick={() => onSelect(s.sessionId)}
              style={{
                ...styles.item,
                ...(isSelected ? styles.itemSelected : {}),
              }}
            >
              <div style={styles.idRow}>
                <span style={styles.agentBadge} title={s.agentId}>
                  {s.agentId === 'opencode' ? '🌐' : '🤖'}
                </span>
                <code style={styles.id}>{s.sessionId.slice(0, 8)}</code>
                <span style={statusStyle(s.status)} title={s.status}>{s.status[0].toUpperCase() + s.status.slice(1)}</span>
              </div>
              <div style={styles.metaRow}>
                <span>{s.turnCount} turn{s.turnCount === 1 ? '' : 's'}</span>
                <span>·</span>
                <span title={new Date(s.lastEventAt).toLocaleString()}>{relative(s.lastEventAt)}</span>
              </div>
              {s.lastMessage && (
                <div style={styles.message} title={s.lastMessage}>
                  “{truncate(s.lastMessage, 80)}”
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function relative(ts: number): string {
  const dMs = Date.now() - ts;
  const m = Math.floor(dMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function statusStyle(status: SessionIndexEntry['status']): React.CSSProperties {
  switch (status) {
    case 'open':    return { ...styles.statusBase, color: 'var(--vscode-charts-orange)' };
    case 'closed':  return { ...styles.statusBase, color: 'var(--vscode-charts-green)' };
    case 'aborted': return { ...styles.statusBase, color: 'var(--vscode-charts-red)' };
  }
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: '1rem', color: 'var(--vscode-descriptionForeground)' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: {
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--vscode-panel-border)',
    padding: '0.5rem 0.75rem',
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    font: 'inherit',
  },
  itemSelected: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-list-activeSelectionForeground)',
  },
  idRow: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  id: { fontSize: '0.85em', color: 'var(--vscode-textLink-foreground)' },
  agentBadge: { fontSize: '1em' },
  statusBase: { fontSize: '0.75em', marginLeft: 'auto' },
  metaRow: {
    fontSize: '0.8em',
    color: 'var(--vscode-descriptionForeground)',
    display: 'flex',
    gap: '0.3rem',
  },
  message: {
    fontSize: '0.85em',
    color: 'var(--vscode-descriptionForeground)',
    fontStyle: 'italic',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
