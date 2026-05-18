import type { HunkReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import styles from '../styles/HunkBlock.module.css';

interface Props {
  filePath: string;
  hunk: HunkReview;
  viewType: 'split' | 'unified';
  selected: boolean;
  onSelect(hunkIndex: number): void;
  /**
   * M9.6: file-level sub-agent attribution. When non-null, the hunk
   * header tooltip surfaces the full Task description. File-level, not
   * hunk-level, so all hunks of a file share the same attribution.
   */
  subagentId?: string;
}

/**
 * Renders a single hunk with per-hunk Accept / Reject / Ask Claude buttons.
 *
 * Why we render the diff ourselves
 * --------------------------------
 * `react-diff-view` is shipped as a dependency for future use, but its
 * decoration model treats per-hunk widgets as render-prop ornaments which
 * complicates strict CSP nonce wiring. For v1.0 we render our own line list:
 * full keyboard control, predictable accessibility, no library version drift.
 * The `viewType` prop is wired so a future swap is local to this component.
 */
export function HunkBlock({ filePath, hunk, viewType, selected, onSelect, subagentId }: Props): JSX.Element {
  const decided = hunk.status !== 'pending';
  const openChat = useUi((s) => s.openChat);
  const cls = [styles.root, selected ? styles.selected : '', styles[`status_${hunk.status}`] ?? ''].filter(Boolean).join(' ');

  return (
    <section
      className={cls}
      onMouseDown={() => onSelect(hunk.index)}
      aria-labelledby={`hunk-header-${hunk.index}`}
    >
      <header
        className={styles.header}
        title={subagentId ? `Produced by Task: ${subagentId}` : undefined}
      >
        <code id={`hunk-header-${hunk.index}`} className={styles.hunkHeader}>{hunk.header}</code>
        <div className={styles.actions} role="group" aria-label="Hunk actions">
          <button
            type="button"
            className={`${styles.btn} ${styles.btnAccept}`}
            disabled={decided}
            onClick={() => send({ type: 'accept-hunk', filePath, hunkIndex: hunk.index })}
            aria-label={`Accept hunk ${hunk.index + 1}`}
          >
            ✓ Accept
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnReject}`}
            disabled={decided}
            onClick={() => send({ type: 'reject-hunk', filePath, hunkIndex: hunk.index })}
            aria-label={`Reject hunk ${hunk.index + 1}`}
          >
            ✗ Reject
          </button>
          {decided && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnChat}`}
              onClick={() => send({ type: 'undo-hunk-decision', filePath, hunkIndex: hunk.index })}
              aria-label={`Undo decision on hunk ${hunk.index + 1}`}
              title="Undo this decision (within-turn)"
            >
              ↶ Undo
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnChat}`}
            onClick={() => openChat(filePath, hunk.index)}
            aria-label={`Ask Claude about hunk ${hunk.index + 1}`}
            title="Ask Claude"
          >
            💬 Ask
          </button>
        </div>
      </header>
      {viewType === 'split' ? <SplitView hunk={hunk} /> : <UnifiedView hunk={hunk} />}
    </section>
  );
}

function UnifiedView({ hunk }: { hunk: HunkReview }): JSX.Element {
  return (
    <pre className={styles.unified} aria-label="Unified diff">
      <ol className={styles.lines}>
        {hunk.lines.map((line, i) => {
          const kind = classifyLine(line);
          return (
            <li key={i} className={styles[`line_${kind}`]}>
              <span className={styles.gutter}>{kind === 'add' ? '+' : kind === 'del' ? '-' : ' '}</span>
              <span className={styles.lineText}>{line.slice(1)}</span>
            </li>
          );
        })}
      </ol>
    </pre>
  );
}

function SplitView({ hunk }: { hunk: HunkReview }): JSX.Element {
  // Pair adjacent +/- lines; unpaired changes get a blank cell on the other side.
  const rows = pairLines(hunk.lines);
  return (
    <div className={styles.split} role="table" aria-label="Split diff">
      <div className={styles.splitHeader} role="rowgroup">
        <div role="columnheader">Before</div>
        <div role="columnheader">After</div>
      </div>
      <ol className={styles.splitBody}>
        {rows.map((row, i) => (
          <li key={i} className={styles.splitRow}>
            <pre className={`${styles.splitCell} ${styles[`cell_${row.left.kind}`]}`}>
              <span className={styles.gutter}>{row.left.kind === 'del' ? '-' : ' '}</span>
              <span className={styles.lineText}>{row.left.text}</span>
            </pre>
            <pre className={`${styles.splitCell} ${styles[`cell_${row.right.kind}`]}`}>
              <span className={styles.gutter}>{row.right.kind === 'add' ? '+' : ' '}</span>
              <span className={styles.lineText}>{row.right.text}</span>
            </pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

type Kind = 'add' | 'del' | 'ctx' | 'empty';

function classifyLine(line: string): Kind {
  const c = line.charCodeAt(0);
  if (c === 0x2b /* + */) return 'add';
  if (c === 0x2d /* - */) return 'del';
  return 'ctx';
}

interface SplitRow {
  left: { kind: Kind; text: string };
  right: { kind: Kind; text: string };
}

function pairLines(lines: string[]): SplitRow[] {
  const rows: SplitRow[] = [];
  const dels: string[] = [];
  const adds: string[] = [];
  const flush = () => {
    const pairs = Math.max(dels.length, adds.length);
    for (let i = 0; i < pairs; i++) {
      const d = dels[i] ?? null;
      const a = adds[i] ?? null;
      rows.push({
        left:  d != null ? { kind: 'del', text: d } : { kind: 'empty', text: '' },
        right: a != null ? { kind: 'add', text: a } : { kind: 'empty', text: '' },
      });
    }
    dels.length = 0;
    adds.length = 0;
  };
  for (const line of lines) {
    const kind = classifyLine(line);
    if (kind === 'add') {
      adds.push(line.slice(1));
    } else if (kind === 'del') {
      dels.push(line.slice(1));
    } else {
      flush();
      const text = line.slice(1);
      rows.push({ left: { kind: 'ctx', text }, right: { kind: 'ctx', text } });
    }
  }
  flush();
  return rows;
}

export const __test = { classifyLine, pairLines };
