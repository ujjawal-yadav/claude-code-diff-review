import type { FileReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import { HunkBlock } from './HunkBlock';
import styles from '../styles/DiffPane.module.css';

function allDecided(file: FileReview): boolean {
  return file.hunks.length > 0 && file.hunks.every((h) => h.status !== 'pending');
}

interface Props {
  file: FileReview;
}

export function DiffPane({ file }: Props): JSX.Element {
  const viewType = useUi((s) => s.viewType);
  const expanded = useUi((s) => !!s.expanded[file.filePath] || s.session?.files.length === 1);
  const toggle   = useUi((s) => s.toggleExpanded);
  const selectedHunk = useUi((s) => s.selectedHunk);
  const selectHunk   = useUi((s) => s.selectHunk);
  // v0.4 (A8 cheap): thread session down so HunkBlock can resolve the
  // rename-group panel's member list. Optional in the HunkBlock API.
  const session  = useUi((s) => s.session);

  if (file.isBinary) {
    return (
      <article className={styles.root}>
        <FileHeader file={file} expanded={expanded} onToggle={() => toggle(file.filePath)} />
        <p className={styles.placeholder}>Binary file — diff not available.</p>
      </article>
    );
  }

  if (file.hunks.length === 0) {
    return (
      <article className={styles.root}>
        <FileHeader file={file} expanded={expanded} onToggle={() => toggle(file.filePath)} />
        <p className={styles.placeholder}>No changes.</p>
      </article>
    );
  }

  return (
    <article className={styles.root}>
      <FileHeader file={file} expanded={expanded} onToggle={() => toggle(file.filePath)} />
      {expanded ? (
        <div className={styles.hunks}>
          {file.warnings.includes('fuzz-failed-revert') ? (
            <div className={styles.fuzzBanner} role="alert">
              <p>Could not cleanly revert a hunk — the file has drifted from Claude's edit (e.g.,
                 a formatter ran). Per-hunk reject is unsafe; use the snapshot revert instead.</p>
              <button
                type="button"
                className={styles.fuzzRevertBtn}
                onClick={() => send({ type: 'revert-file-to-snapshot', filePath: file.filePath })}
              >
                Revert file to original snapshot
              </button>
            </div>
          ) : null}
          {file.warnings.includes('write-failed') || file.warnings.includes('read-failed') ? (
            <div className={styles.fuzzBanner} role="alert">
              <p>
                {file.warnings.includes('write-failed')
                  ? 'Failed to write the file. The on-disk content may not match what you see here.'
                  : 'Failed to read the current file content. Action skipped.'}
                {' '}Check disk permissions / available space, then retry. The orchestrator log
                ("Claude Review: Show Log") has the underlying error.
              </p>
              <button
                type="button"
                className={styles.fuzzRevertBtn}
                onClick={() => send({ type: 'revert-file-to-snapshot', filePath: file.filePath })}
              >
                Revert file to original snapshot
              </button>
            </div>
          ) : null}
          {file.warnings.includes('external-edit') ? (
            <div className={styles.externalEditBanner} role="status">
              File changed outside the review (saved manually) — diff has been refreshed.
            </div>
          ) : null}
          {file.hunks.map((h) => (
            <HunkBlock
              key={h.index}
              filePath={file.filePath}
              hunk={h}
              viewType={viewType}
              selected={selectedHunk === h.index}
              onSelect={selectHunk}
              {...(file.subagentId ? { subagentId: file.subagentId } : {})}
              {...(session ? { session } : {})}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function FileHeader({ file, expanded, onToggle }: { file: FileReview; expanded: boolean; onToggle(): void }): JSX.Element {
  return (
    <header className={styles.header}>
      <button
        type="button"
        className={styles.toggle}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`hunks-${file.filePath}`}
      >
        <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.path}>{file.relPath}</span>
        <span className={styles.tags}>
          {file.isNew ? <span className={styles.tag}>NEW</span> : null}
          {file.isDeleted ? <span className={styles.tag}>DEL</span> : null}
          {file.warnings.map((w) => (
            <span key={w} className={`${styles.tag} ${styles.tagWarn}`}>{w}</span>
          ))}
        </span>
      </button>
      <div className={styles.fileActions}>
        {/* Bug B fix: when a file has no hunks (binary file, or a touched-but-unchanged
            edge case that slipped through openReview's filter), the bulk-action
            buttons would silently no-op. Hide them entirely to remove the affordance. */}
        {file.hunks.length > 0 && (
          <>
            <button
              type="button"
              className={styles.btn}
              disabled={file.status === 'accepted' || allDecided(file)}
              onClick={() => send({ type: 'accept-file', filePath: file.filePath })}
              aria-label="Accept all hunks in this file"
              title={allDecided(file) ? 'Every hunk in this file has already been decided' : 'Accept every pending hunk in this file'}
            >
              ✓ File
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={file.status === 'rejected' || allDecided(file)}
              onClick={() => send({ type: 'reject-file', filePath: file.filePath })}
              aria-label="Reject all hunks in this file"
              title={allDecided(file) ? 'Every hunk in this file has already been decided' : 'Reject every pending hunk in this file (writes snapshot)'}
            >
              ✗ File
            </button>
          </>
        )}
      </div>
    </header>
  );
}
