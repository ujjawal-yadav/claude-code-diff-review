import { useEffect, useMemo, useState } from 'react';
import type { HistoryEvent } from '../../src/history/historyEvents.js';
import type { SessionIndexEntry } from '../../src/history/historyTypes.js';
import type { HistoryHostToWebview } from '../../src/messages.js';
import type { InsightsReport } from '../../src/types.js';
import { vscode } from './vscode.js';
import { SessionList } from './components/SessionList.js';
import { SessionDetail } from './components/SessionDetail.js';
import { Insights } from './components/Insights.js';

type Tab = 'sessions' | 'insights';

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionIndexEntry[] | null>(null);
  const [historyRoot, setHistoryRoot] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  /**
   * β.0 (10.1.8): when an action (resume / rollback / delete) is in flight,
   * the SessionDetail's buttons disable until the host echoes back. Keyed
   * by sessionId so concurrent actions on different sessions don't clash
   * (rare today; future-proofing for richer flows).
   */
  const [inflight, setInflight] = useState<Record<string, 'resume' | 'rollback' | 'delete' | undefined>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  // v0.6 (A9): Insights tab. Lazily requested on first switch; refreshed
  // unsolicited by the host's gated change-listener recompute.
  const [tab, setTab] = useState<Tab>('sessions');
  const [insights, setInsights] = useState<InsightsReport | null>(null);
  const [insightsLoading, setInsightsLoading] = useState<boolean>(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);

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
          // After a delete, the deleted session may have been the selected
          // one. Clear selection if it's no longer in the list.
          if (selectedId && !msg.sessions.some((s) => s.sessionId === selectedId)) {
            setSelectedId(null);
            setEvents(null);
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
        case 'session-action-result':
          setInflight((prev) => {
            const next = { ...prev };
            delete next[msg.sessionId];
            return next;
          });
          if (!msg.ok) {
            setActionError(
              `${msg.action} failed${msg.error ? `: ${msg.error}` : ''}`,
            );
          } else {
            setActionError(null);
          }
          return;
        case 'insights-report':
          setInsights(msg.report);
          setInsightsLoading(false);
          setInsightsError(null);
          return;
        case 'insights-error':
          setInsightsError(msg.message);
          setInsightsLoading(false);
          return;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [selectedId]);

  const onResume = (sid: string): void => {
    setActionError(null);
    setInflight((prev) => ({ ...prev, [sid]: 'resume' }));
    vscode.postMessage({ type: 'resume-session', sessionId: sid });
  };
  const onRollback = (sid: string): void => {
    setActionError(null);
    setInflight((prev) => ({ ...prev, [sid]: 'rollback' }));
    vscode.postMessage({ type: 'rollback-turn', sessionId: sid });
  };
  const onDelete = (sid: string): void => {
    setActionError(null);
    setInflight((prev) => ({ ...prev, [sid]: 'delete' }));
    vscode.postMessage({ type: 'delete-session', sessionId: sid });
  };

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

  const switchTab = (next: Tab): void => {
    if (next === tab) return;
    setTab(next);
    // Lazily request insights on the first switch; later switches reuse the
    // cached report (live recompute arrives unsolicited from the host).
    if (next === 'insights' && insights == null && !insightsLoading) {
      setInsightsLoading(true);
      setInsightsError(null);
      vscode.postMessage({ type: 'load-insights' });
    }
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
      <div style={styles.tabBar} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sessions'}
          style={tab === 'sessions' ? { ...styles.tab, ...styles.tabActive } : styles.tab}
          onClick={() => switchTab('sessions')}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'insights'}
          style={tab === 'insights' ? { ...styles.tab, ...styles.tabActive } : styles.tab}
          onClick={() => switchTab('insights')}
        >
          Insights
        </button>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {actionError && <div style={styles.error}>{actionError}</div>}
      {tab === 'sessions' ? (
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
              <SessionDetail
                session={selected}
                events={events}
                loading={loading}
                inflight={inflight[selected.sessionId]}
                onResume={onResume}
                onRollback={onRollback}
                onDelete={onDelete}
              />
            )}
          </main>
        </div>
      ) : (
        <main style={styles.main}>
          <Insights report={insights} loading={insightsLoading} error={insightsError} />
        </main>
      )}
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
  tabBar: {
    display: 'flex',
    gap: '2px',
    padding: '0 1rem',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  tab: {
    padding: '0.4rem 0.9rem',
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  tabActive: {
    borderBottom: '2px solid var(--vscode-focusBorder)',
    color: 'var(--vscode-foreground)',
  },
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
