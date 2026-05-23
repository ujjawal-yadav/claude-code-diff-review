import { memo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { FileReview } from '../../src/types';
import { useUi } from '../store';
import { truncate } from '../utils/truncate';
import { FlagChip } from './FlagChip';
import styles from '../styles/FileList.module.css';

const SUBAGENT_CHIP_MAX = 32;

interface Props {
  files: FileReview[];
}

export function FileList({ files }: Props): JSX.Element {
  const selectedFile = useUi((s) => s.selectedFile);
  const selectFile   = useUi((s) => s.selectFile);
  const showFlaggedOnly = useUi((s) => s.showFlaggedOnly);

  // v0.4 (Wave 4): "show flagged only" filter (file-level per L3). A file
  // is flagged when it carries a file-level flag OR any of its hunks does.
  // Always render at least one row — falling all the way to zero is a
  // confusing dead-end; if everything filters out, show the unfiltered list.
  // v0.5.1 (LH9): use `display` directly. Previous code did `files = display`
  // which mutates the prop — React anti-pattern + interacts badly with
  // Virtuoso's internal key tracking on filter-toggle.
  const filtered = showFlaggedOnly
    ? files.filter((f) => (f.flags?.length ?? 0) > 0 || f.hunks.some((h) => (h.flags?.length ?? 0) > 0))
    : files;
  const display = filtered.length > 0 ? filtered : files;

  // Virtualise once we exceed the perf-budget cliff (TRD §15).
  const VIRTUALISE_AT = 50;
  if (display.length > VIRTUALISE_AT) {
    return (
      <nav className={styles.root} aria-label="Files in this session">
        <Virtuoso
          data={display}
          totalCount={display.length}
          itemContent={(_, file) => (
            <FileRow
              key={file.filePath}
              file={file}
              selected={selectedFile === file.filePath}
              onSelect={() => selectFile(file.filePath)}
            />
          )}
        />
      </nav>
    );
  }
  return (
    <nav className={styles.root} aria-label="Files in this session">
      {display.map((file) => (
        <FileRow
          key={file.filePath}
          file={file}
          selected={selectedFile === file.filePath}
          onSelect={() => selectFile(file.filePath)}
        />
      ))}
    </nav>
  );
}

/**
 * v0.5.1 (LH9): memoized so unrelated session mutations (build-signal
 * progress, other-file updates) don't re-render every row. `applyFileUpdate`
 * preserves reference equality for unchanged files; default shallow-equal
 * comparison correctly skips re-render in the steady state.
 */
const FileRow = memo(FileRowImpl);

function FileRowImpl({ file, selected, onSelect }: { file: FileReview; selected: boolean; onSelect(): void }): JSX.Element {
  const counts = countByStatus(file);
  const cls = [
    styles.row,
    selected ? styles.rowSelected : '',
    styles[`status_${file.status}`] ?? '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onSelect} aria-current={selected ? 'true' : 'false'}>
      <span className={styles.dot} aria-hidden="true" data-status={file.status} />
      <span className={styles.path}>{file.relPath}</span>
      <span className={styles.counts}>
        {file.isNew ? <span className={styles.tag}>NEW</span> : null}
        {file.isDeleted ? <span className={styles.tag}>DEL</span> : null}
        {file.isBinary ? <span className={styles.tag}>BIN</span> : null}
        {file.subagentId ? (
          <span
            className={styles.subagentChip}
            title={`Produced by Task: ${file.subagentId}`}
            aria-label={`Produced by Task: ${file.subagentId}`}
          >
            via {truncate(file.subagentId, SUBAGENT_CHIP_MAX)}
          </span>
        ) : null}
        {/* v0.3: risk-flag chip — most-severe flag visible, tooltip lists all */}
        <FlagChip flags={file.flags} />
        {/* v0.5: build-signal overlay — small dot conveying typecheck result. */}
        <BuildStatusDot status={file.buildStatus} />
        {counts.pending > 0 ? <span className={styles.pendingPill}>{counts.pending}</span> : null}
      </span>
    </button>
  );
}

function countByStatus(file: FileReview): { accepted: number; rejected: number; pending: number } {
  let accepted = 0, rejected = 0, pending = 0;
  for (const h of file.hunks) {
    if (h.status === 'accepted') accepted++;
    else if (h.status === 'rejected') rejected++;
    else pending++;
  }
  return { accepted, rejected, pending };
}

/**
 * v0.5: tiny dot conveying typecheck result for the file. Renders nothing
 * for `undefined` / `'unknown'` so files without a result stay clean.
 */
function BuildStatusDot({ status }: { status: FileReview['buildStatus'] }): JSX.Element | null {
  if (!status || status === 'unknown') return null;
  const map = {
    running: { cls: styles.buildDotRunning, title: 'tsc: running…' },
    pass:    { cls: styles.buildDotPass,    title: 'tsc: passed for this file' },
    fail:    { cls: styles.buildDotFail,    title: 'tsc: this file has errors' },
  } as const;
  const entry = map[status];
  return <span className={entry.cls} title={entry.title} aria-label={entry.title} />;
}

export const __test = { countByStatus };
