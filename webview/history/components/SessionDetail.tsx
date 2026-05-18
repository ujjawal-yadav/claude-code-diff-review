import { useMemo } from 'react';
import type { HistoryEvent } from '../../../src/history/historyEvents.js';
import type { SessionIndexEntry } from '../../../src/history/historyTypes.js';

interface SessionDetailProps {
  session: SessionIndexEntry;
  events: HistoryEvent[] | null;
  loading: boolean;
}

/** A turn aggregated for display. */
interface TurnSummary {
  turnId: string;
  startedAt: number | null;
  stoppedAt: number | null;
  lastAssistantMessage: string | null;
  files: Map<string, { decisions: { accepted: number; rejected: number }; reverted: boolean }>;
  aborted: boolean;
}

export function SessionDetail({ session, events, loading }: SessionDetailProps): JSX.Element {
  const turns = useMemo(() => (events ? aggregateTurns(events) : []), [events]);

  return (
    <div>
      <h2 style={styles.h2}>
        <code>{session.sessionId}</code>{' '}
        <span style={styles.subtle}>· {session.agentId} · {session.status}</span>
      </h2>
      <div style={styles.subtle}>
        Started {new Date(session.startedAt).toLocaleString()} · Last event {new Date(session.lastEventAt).toLocaleString()}
      </div>
      {session.lastMessage && (
        <blockquote style={styles.quote}>{session.lastMessage}</blockquote>
      )}

      <h3 style={styles.h3}>Turns ({session.turnCount})</h3>
      {loading && <p style={styles.subtle}>Loading events…</p>}
      {!loading && events != null && turns.length === 0 && (
        <p style={styles.subtle}>No turn events recorded.</p>
      )}
      {turns.map((t, i) => (
        <TurnCard key={t.turnId} index={i} turn={t} />
      ))}
    </div>
  );
}

function TurnCard({ index, turn }: { index: number; turn: TurnSummary }): JSX.Element {
  const totalDecisions = Array.from(turn.files.values()).reduce(
    (acc, f) => acc + f.decisions.accepted + f.decisions.rejected,
    0,
  );
  const accepted = Array.from(turn.files.values()).reduce((a, f) => a + f.decisions.accepted, 0);
  const rejected = Array.from(turn.files.values()).reduce((a, f) => a + f.decisions.rejected, 0);
  return (
    <div style={styles.turn}>
      <div style={styles.turnHeader}>
        <strong>Turn {index + 1}</strong>
        <code style={styles.turnId}>{turn.turnId.slice(0, 8)}</code>
        {turn.aborted && <span style={styles.aborted}>aborted</span>}
        {!turn.aborted && turn.stoppedAt == null && <span style={styles.open}>open</span>}
        <span style={styles.subtle}>
          {turn.startedAt ? new Date(turn.startedAt).toLocaleString() : '—'}
          {turn.stoppedAt ? ` → ${new Date(turn.stoppedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>
      {turn.lastAssistantMessage && (
        <blockquote style={styles.quote}>{truncate(turn.lastAssistantMessage, 200)}</blockquote>
      )}
      <div style={styles.summary}>
        {turn.files.size} file{turn.files.size === 1 ? '' : 's'} · {totalDecisions} decision{totalDecisions === 1 ? '' : 's'}
        {accepted > 0 && <span style={styles.acceptBadge}>{accepted}✓</span>}
        {rejected > 0 && <span style={styles.rejectBadge}>{rejected}✗</span>}
      </div>
      {turn.files.size > 0 && (
        <ul style={styles.files}>
          {Array.from(turn.files.entries()).map(([path, f]) => (
            <li key={path}>
              <code>{path}</code>
              {f.decisions.accepted > 0 && <span style={styles.acceptBadge}>{f.decisions.accepted}✓</span>}
              {f.decisions.rejected > 0 && <span style={styles.rejectBadge}>{f.decisions.rejected}✗</span>}
              {f.reverted && <span style={styles.revertBadge} title="full-file snapshot revert">↶ revert</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function aggregateTurns(events: HistoryEvent[]): TurnSummary[] {
  const map = new Map<string, TurnSummary>();
  const get = (turnId: string): TurnSummary => {
    let t = map.get(turnId);
    if (!t) {
      t = {
        turnId,
        startedAt: null,
        stoppedAt: null,
        lastAssistantMessage: null,
        files: new Map(),
        aborted: false,
      };
      map.set(turnId, t);
    }
    return t;
  };
  for (const ev of events) {
    const turn = get(ev.turnId);
    switch (ev.kind) {
      case 'turn-started':
        turn.startedAt = ev.ts;
        for (const f of ev.files) {
          if (!turn.files.has(f.path)) {
            turn.files.set(f.path, { decisions: { accepted: 0, rejected: 0 }, reverted: false });
          }
        }
        break;
      case 'turn-stopped':
        turn.stoppedAt = ev.ts;
        turn.lastAssistantMessage = ev.lastAssistantMessage;
        for (const f of ev.files) {
          if (!turn.files.has(f.path)) {
            turn.files.set(f.path, { decisions: { accepted: 0, rejected: 0 }, reverted: false });
          }
        }
        break;
      case 'hunk-decided': {
        if (!turn.files.has(ev.path)) {
          turn.files.set(ev.path, { decisions: { accepted: 0, rejected: 0 }, reverted: false });
        }
        const f = turn.files.get(ev.path)!;
        if (ev.decision === 'accepted') f.decisions.accepted++;
        else                            f.decisions.rejected++;
        break;
      }
      case 'file-snapshot-reverted': {
        if (!turn.files.has(ev.path)) {
          turn.files.set(ev.path, { decisions: { accepted: 0, rejected: 0 }, reverted: true });
        } else {
          turn.files.get(ev.path)!.reverted = true;
        }
        break;
      }
      case 'turn-aborted':
        turn.aborted = true;
        break;
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const styles: Record<string, React.CSSProperties> = {
  h2: { fontSize: '1.1em', margin: '0 0 0.25rem 0' },
  h3: { fontSize: '1em', margin: '1rem 0 0.5rem 0' },
  subtle: { color: 'var(--vscode-descriptionForeground)', fontSize: '0.85em' },
  quote: {
    margin: '0.5rem 0',
    padding: '0.4rem 0.6rem',
    borderLeft: '3px solid var(--vscode-textBlockQuote-border)',
    background: 'var(--vscode-textBlockQuote-background)',
    fontStyle: 'italic',
    color: 'var(--vscode-textPreformat-foreground)',
  },
  turn: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    padding: '0.6rem 0.8rem',
    margin: '0.4rem 0',
  },
  turnHeader: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  turnId: { fontSize: '0.8em', color: 'var(--vscode-textLink-foreground)' },
  open: {
    fontSize: '0.75em',
    color: 'var(--vscode-charts-orange)',
    background: 'var(--vscode-inputValidation-warningBackground)',
    padding: '0 0.3rem',
    borderRadius: '3px',
  },
  aborted: {
    fontSize: '0.75em',
    color: 'var(--vscode-charts-red)',
    background: 'var(--vscode-inputValidation-errorBackground)',
    padding: '0 0.3rem',
    borderRadius: '3px',
  },
  summary: { fontSize: '0.85em', marginTop: '0.3rem', color: 'var(--vscode-descriptionForeground)' },
  files: { listStyle: 'none', margin: '0.4rem 0 0 0', padding: '0 0 0 0.6rem', fontSize: '0.85em' },
  acceptBadge: { color: 'var(--vscode-charts-green)', marginLeft: '0.4rem' },
  rejectBadge: { color: 'var(--vscode-charts-red)', marginLeft: '0.4rem' },
  revertBadge: { color: 'var(--vscode-charts-orange)', marginLeft: '0.4rem', fontSize: '0.85em' },
};
