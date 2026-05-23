import { memo } from 'react';
import type { SessionReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import { TooltipPopover } from './TooltipPopover';
import styles from '../styles/SessionHeader.module.css';

interface Props {
  session: SessionReview;
  viewType: 'split' | 'unified';
  banner: string | null;
}

/**
 * v0.5.1 (LH9): memoized with a custom `areEqual` that checks only the
 * specific fields the header renders. Without this, every `setBuildSignal`
 * (3-5 times during a typecheck run) recreates the session object and
 * re-renders the header — wasteful since only `buildSignal` changes.
 *
 * Comparison strategy:
 *   - `files` reference equality covers "no file added/removed" — typical
 *     case during typecheck progress. `applyFileUpdate` produces a new
 *     files array only when a file actually changes, so this is correct.
 *   - `metrics` reference equality covers "no hunk decided" — orchestrator
 *     produces a new metrics object only on `recomputeMetrics`.
 *   - `buildSignal`, `lastAssistantMessage` are direct value checks.
 *   - `viewType`, `banner` are scalars.
 */
export const SessionHeader = memo(SessionHeaderImpl, (prev, next) => {
  return prev.session.sessionId === next.session.sessionId
      && prev.session.files === next.session.files
      && prev.session.metrics === next.session.metrics
      && prev.session.buildSignal === next.session.buildSignal
      && prev.session.lastAssistantMessage === next.session.lastAssistantMessage
      && prev.viewType === next.viewType
      && prev.banner === next.banner;
});

function SessionHeaderImpl({ session, viewType, banner }: Props): JSX.Element {
  const totalHunks = session.metrics.totalHunks;
  const decided = session.metrics.acceptedHunks + session.metrics.rejectedHunks;
  const undoDepth = useUi((s) => s.undoDepth);
  const toggleHelp = useUi((s) => s.toggleHelpVisible);
  const showFlaggedOnly = useUi((s) => s.showFlaggedOnly);
  const setShowFlaggedOnly = useUi((s) => s.setShowFlaggedOnly);
  const wrapLines = useUi((s) => s.wrapLines);
  const setWrapLines = useUi((s) => s.setWrapLines);
  const buildSignal = session.buildSignal;
  // v0.5: count files whose buildStatus === 'fail' for the banner copy.
  const buildFailedFiles = buildSignal && buildSignal.status === 'fail'
    ? session.files.filter((f) => f.buildStatus === 'fail').length
    : 0;
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
          {buildSignal ? (
            <>
              {' · '}
              <BuildSignalChip
                status={buildSignal.status}
                totalErrors={buildSignal.totalErrors}
                failedFiles={buildFailedFiles}
                cached={buildSignal.cached === true}
                fatalStderr={buildSignal.fatalStderr}
              />
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

/**
 * v0.5: session-header build-signal chip. Renders one of four states:
 *   - 'running' (spinner)
 *   - 'pass' (green check; cached hint in tooltip if applicable)
 *   - 'fail' (red alarm + error count + file count)
 *   - 'unknown' (gray; tooltip carries fatalStderr if any)
 */
function BuildSignalChip({
  status,
  totalErrors,
  failedFiles,
  cached,
  fatalStderr,
}: {
  status: 'unknown' | 'running' | 'pass' | 'fail';
  totalErrors: number;
  failedFiles: number;
  cached: boolean;
  fatalStderr: string | null;
}): JSX.Element {
  let text: string;
  let title: string;
  let className: string;
  switch (status) {
    case 'running':
      text = '⏳ tsc: running…';
      title = 'TypeScript compiler is running against the workspace.';
      className = styles.buildRunning ?? '';
      break;
    case 'pass':
      text = '✓ tsc: passed';
      title = cached
        ? 'tsc finished in <1.5 s with no diagnostics — this run used the incremental cache (.tsbuildinfo).'
        : 'TypeScript compiler completed cleanly. No errors or warnings emitted.';
      className = styles.buildPass ?? '';
      break;
    case 'fail':
      text = `🚨 tsc: ${totalErrors} ${totalErrors === 1 ? 'error' : 'errors'} in ${failedFiles} ${failedFiles === 1 ? 'file' : 'files'}`;
      title = 'TypeScript compiler reported errors. Affected hunks carry an inline 🚨 badge — review those first.';
      className = styles.buildFail ?? '';
      break;
    case 'unknown':
    default:
      text = 'tsc: unknown';
      title = fatalStderr
        ? `Build runner could not complete:\n${fatalStderr}`
        : 'Build signal is in an indeterminate state (cancelled, timed out, or no TypeScript project detected).';
      className = styles.buildUnknown ?? '';
      break;
  }
  // v0.5.1 (LH3): use TooltipPopover for multi-line `fatalStderr` content.
  // Native `title` attribute clipped messages across browsers; the popover
  // renders pre-wrap with max-width 480, accessible via hover + focus.
  return (
    <TooltipPopover content={title}>
      <span className={className} tabIndex={0}>
        {text}
      </span>
    </TooltipPopover>
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
