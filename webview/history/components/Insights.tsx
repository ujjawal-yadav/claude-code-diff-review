import type { InsightsReport } from '../../../src/types.js';
import { truncate } from '../../utils/truncate.js';

/**
 * v0.6 (A9 — Insights): renders the host-computed `InsightsReport`. Read-only;
 * no aggregation here (that's host-side). CSS bars + tables, no chart lib.
 * Inline `styles` record to match the history webview convention.
 */
interface InsightsProps {
  report: InsightsReport | null;
  loading: boolean;
  error: string | null;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function Insights({ report, loading, error }: InsightsProps): JSX.Element {
  if (error) {
    return <div style={styles.error}>Failed to compute insights: {error}</div>;
  }
  if (report == null) {
    return <p style={styles.empty}>{loading ? 'Computing insights…' : 'Open to load insights.'}</p>;
  }

  const windowDays = Math.round(report.windowMs / (24 * 60 * 60 * 1000));

  if (report.empty) {
    return (
      <div>
        <p style={styles.empty}>
          No review decisions in the last {windowDays} days yet. Accept or reject hunks in the
          review panel and they'll show up here.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.asOf}>
        {report.sessionsScanned} session{report.sessionsScanned === 1 ? '' : 's'} · last{' '}
        {windowDays} days · computed {new Date(report.computedAt).toLocaleTimeString()}
      </div>

      {/* (a) Per-file accept/reject rates */}
      <section style={styles.section}>
        <h3 style={styles.h3}>Per-file accept rate</h3>
        {report.fileRates.length === 0 ? (
          <p style={styles.empty}>No decided hunks in the last {windowDays} days.</p>
        ) : (
          <table style={styles.table}>
            <tbody>
              {report.fileRates.map((f) => (
                <tr key={f.path}>
                  <td style={styles.pathCell} title={f.path}>
                    <code>{truncate(f.path, 48)}</code>
                  </td>
                  <td style={styles.barCell}>
                    <StackedBar accepted={f.accepted} rejected={f.rejected} />
                  </td>
                  <td style={styles.rateCell}>
                    {f.accepted + f.rejected > 0 ? pct(f.acceptRate) : '—'}
                  </td>
                  <td style={styles.countsCell}>
                    <span style={styles.acceptText}>{f.accepted}✓</span>{' '}
                    <span style={styles.rejectText}>{f.rejected}✗</span>
                    {f.edited > 0 ? <span style={styles.editBadge}>{f.edited} edited</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* (b) Per-sub-agent acceptance */}
      <section style={styles.section}>
        <h3 style={styles.h3}>Per-sub-agent acceptance</h3>
        {report.subagentRates.length === 0 ? (
          <p style={styles.empty}>No attributed decisions yet.</p>
        ) : (
          <table style={styles.table}>
            <tbody>
              {report.subagentRates.map((s) => (
                <tr key={s.subagentId}>
                  <td style={styles.pathCell} title={s.label}>
                    {truncate(s.label, 40)}
                  </td>
                  <td style={styles.barCell}>
                    <StackedBar accepted={s.accepted} rejected={s.rejected} />
                  </td>
                  <td style={styles.rateCell}>
                    {s.accepted + s.rejected > 0 ? pct(s.acceptRate) : '—'}
                  </td>
                  <td style={styles.countsCell}>
                    <span style={styles.acceptText}>{s.accepted}✓</span>{' '}
                    <span style={styles.rejectText}>{s.rejected}✗</span>
                    {s.edited > 0 ? <span style={styles.editBadge}>{s.edited} edited</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* (c) Rejection-rate trend */}
      <section style={styles.section}>
        <h3 style={styles.h3}>Rejection-rate trend ({report.trend.length} days)</h3>
        <div style={styles.trendRow}>
          {report.trend.map((b) => (
            <div
              key={b.day}
              style={styles.trendCol}
              title={`${b.day}: ${b.rejected}/${b.decided} rejected`}
            >
              <div style={styles.trendTrack}>
                <div
                  style={{
                    ...styles.trendFill,
                    height: b.decided > 0 ? `${Math.max(4, b.rejectionRate * 100)}%` : '0%',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <div style={styles.trendCaption}>
          Bar height = share of decisions rejected that day. Hover for counts.
        </div>
      </section>

      {/* (d) Rejection-reason mining */}
      <section style={styles.section}>
        <h3 style={styles.h3}>Rejection reasons ({report.reasons.total})</h3>
        {report.reasons.total === 0 ? (
          <p style={styles.empty}>
            No rejection reasons captured yet. Add a reason when rejecting a hunk to see recurring
            themes here.
          </p>
        ) : (
          <ul style={styles.reasonList}>
            {report.reasons.groups.map((g, i) => (
              <li key={i} style={styles.reasonItem}>
                <span style={styles.reasonCount}>{g.count}×</span>
                <span style={styles.reasonText}>{truncate(g.reason, 160)}</span>
                {g.samplePaths.length > 0 ? (
                  <span style={styles.reasonPaths}>
                    {g.samplePaths.map((p) => truncate(p, 32)).join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StackedBar({ accepted, rejected }: { accepted: number; rejected: number }): JSX.Element {
  const total = accepted + rejected;
  if (total === 0) {
    return <div style={styles.barTrack} aria-hidden="true" />;
  }
  const acceptW = (accepted / total) * 100;
  return (
    <div style={styles.barTrack} aria-hidden="true">
      <div style={{ ...styles.barAccept, width: `${acceptW}%` }} />
      <div style={{ ...styles.barReject, width: `${100 - acceptW}%` }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: '1.25rem' },
  asOf: { color: 'var(--vscode-descriptionForeground)', fontSize: '0.85em' },
  section: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  h3: { margin: 0, fontSize: '1em' },
  empty: { color: 'var(--vscode-descriptionForeground)' },
  error: {
    padding: '0.5rem 0.75rem',
    background: 'var(--vscode-inputValidation-errorBackground)',
    color: 'var(--vscode-inputValidation-errorForeground)',
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  pathCell: { padding: '2px 8px 2px 0', whiteSpace: 'nowrap', maxWidth: '320px', overflow: 'hidden' },
  barCell: { width: '40%', padding: '2px 8px' },
  rateCell: { padding: '2px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', width: '3em' },
  countsCell: { padding: '2px 0 2px 8px', whiteSpace: 'nowrap', fontSize: '0.85em' },
  barTrack: {
    display: 'flex',
    height: '10px',
    width: '100%',
    background: 'var(--vscode-panel-border)',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  barAccept: { background: 'var(--vscode-charts-green, #4caf50)' },
  barReject: { background: 'var(--vscode-charts-red, #f44336)' },
  acceptText: { color: 'var(--vscode-charts-green, #4caf50)' },
  rejectText: { color: 'var(--vscode-charts-red, #f44336)' },
  editBadge: {
    marginLeft: '6px',
    padding: '0 5px',
    borderRadius: '6px',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    fontSize: '0.85em',
  },
  trendRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    height: '64px',
    padding: '4px 0',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  trendCol: { flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' },
  trendTrack: { width: '100%', height: '100%', display: 'flex', alignItems: 'flex-end' },
  trendFill: {
    width: '100%',
    background: 'var(--vscode-charts-red, #f44336)',
    borderRadius: '1px 1px 0 0',
  },
  trendCaption: { color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em' },
  reasonList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  reasonItem: { display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' },
  reasonCount: {
    padding: '0 6px',
    borderRadius: '6px',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    fontSize: '0.85em',
  },
  reasonText: { flex: 1 },
  reasonPaths: { color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em', fontFamily: 'var(--vscode-editor-font-family)' },
};
