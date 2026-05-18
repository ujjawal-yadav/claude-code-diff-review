import { useEffect, useMemo, useState } from 'react';
import type { HistoryEvent } from '../../src/history/historyEvents.js';
import type { SessionIndexEntry } from '../../src/history/historyTypes.js';
import type { HistoryHostToWebview } from '../../src/messages.js';
import { vscode } from './vscode.js';
import { SessionList } from './components/SessionList.js';
import { SessionDetail } from './components/SessionDetail.js';

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionIndexEntry[] | null>(null);
  const [historyRoot, setHistoryRoot] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const handler = (e: MessageEvent<unknown>) => {
      const msg = e.data as HistoryHostToWebview;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'init':
          setSessions(msg.sessions);
          setHistoryRoot(msg.root);
          // Auto-select most-recent session for fast crash-recovery glance.
          if (msg.sessions.length > 0 && selectedId == null) {
            const newest = [...msg.sessions].sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
            setSelectedId(newest.sessionId);
            setLoading(true);
            vscode.postMessage({ type: 'load-session', sessionId: newest.sessionId });
          }
          return;
        case 'session-loaded':
          if (msg.sessionId === selectedId) {
            setEvents(msg.events);
            setLoading(false);
          }
          return;
        case 'error':
          setError(msg.message);
          setLoading(false);
          return;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [selectedId]);

  const selected = useMemo(
    () => sessions?.find((s) => s.sessionId === selectedId) ?? null,
    [sessions, selectedId],
  );

  const onSelect = (sid: string): void => {
    if (sid === selectedId) return;
    setSelectedId(sid);
    setEvents(null);
    setLoading(true);
    vscode.postMessage({ type: 'load-session', sessionId: sid });
  };

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <strong>Claude Code Review · History</strong>
        <span style={styles.subtle}>
          {sessions == null ? 'loading…' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
          {historyRoot ? ` · ${historyRoot}` : ''}
        </span>
      </header>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.body}>
        <aside style={styles.aside}>
          <SessionList sessions={sessions} selectedId={selectedId} onSelect={onSelect} />
        </aside>
        <main style={styles.main}>
          {selected == null ? (
            <p style={styles.empty}>
              {sessions == null
                ? 'Loading history…'
                : sessions.length === 0
                  ? 'No Claude Code sessions recorded yet. Run a session — every turn lands in the event log.'
                  : 'Select a session to inspect its turns.'}
            </p>
          ) : (
            <SessionDetail session={selected} events={events} loading={loading} />
          )}
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
    background: 'var(--vscode-editor-background)',
  },
  header: {
    padding: '0.5rem 1rem',
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  subtle: { color: 'var(--vscode-descriptionForeground)', fontSize: '0.85em' },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  aside: {
    width: '280px',
    minWidth: '240px',
    borderRight: '1px solid var(--vscode-panel-border)',
    overflowY: 'auto',
  },
  main: { flex: 1, overflowY: 'auto', padding: '1rem' },
  empty: { color: 'var(--vscode-descriptionForeground)' },
  error: {
    padding: '0.5rem 1rem',
    background: 'var(--vscode-inputValidation-errorBackground)',
    color: 'var(--vscode-inputValidation-errorForeground)',
    borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)',
  },
};
