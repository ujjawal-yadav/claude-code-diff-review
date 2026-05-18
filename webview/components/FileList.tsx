import { Virtuoso } from 'react-virtuoso';
import type { FileReview } from '../../src/types';
import { useUi } from '../store';
import { truncate } from '../utils/truncate';
import styles from '../styles/FileList.module.css';

const SUBAGENT_CHIP_MAX = 32;

interface Props {
  files: FileReview[];
}

export function FileList({ files }: Props): JSX.Element {
  const selectedFile = useUi((s) => s.selectedFile);
  const selectFile   = useUi((s) => s.selectFile);

  // Virtualise once we exceed the perf-budget cliff (TRD §15).
  const VIRTUALISE_AT = 50;
  if (files.length > VIRTUALISE_AT) {
    return (
      <nav className={styles.root} aria-label="Files in this session">
        <Virtuoso
          data={files}
          totalCount={files.length}
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
      {files.map((file) => (
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

function FileRow({ file, selected, onSelect }: { file: FileReview; selected: boolean; onSelect(): void }): JSX.Element {
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

export const __test = { countByStatus };
