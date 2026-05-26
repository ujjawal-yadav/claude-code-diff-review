import { memo, useEffect, useRef } from 'react';
import type { HunkReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import { FlagBadges } from './FlagChip';
import { InlineExpandingPanel } from './InlineExpandingPanel';
import { TooltipPopover } from './TooltipPopover';
// v0.5.1 (LH5): pure cross-bundle helper (was duplicated here + in
// `src/reviewOrchestrator.ts`).
import { extractHunkAfterView } from '../../src/shared/hunkUtils.shared';
import styles from '../styles/HunkBlock.module.css';

const EDIT_BYTES_CAP   = 256 * 1024;
const REASON_BYTES_CAP = 4 * 1024;

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
  /**
   * v0.4 (A8 cheap): rename-group member lists, threaded down so the panel
   * can resolve `renameGroups[groupId]`. Optional; falls back to no panel.
   *
   * v0.6.1: narrowed from the whole `SessionReview` to just `renameGroups`.
   * The full-session prop minted a new reference on every `setBuildSignal`
   * (3-5×/sec during a tsc run), which silently broke this component's own
   * shallow-equal memo and re-rendered every hunk. `renameGroups` is
   * reference-stable across decision/build-signal mutations, so the memo
   * now actually holds.
   */
  renameGroups?: Record<string, Array<{ filePath: string; hunkIndex: number }>>;
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
/**
 * v0.5.1 (LH9): memoized so unrelated session mutations don't trigger a
 * cascade of HunkBlock re-renders. Hunk references are preserved across
 * `applyFileUpdate` for unchanged hunks, so default shallow-equal works.
 */
export const HunkBlock = memo(HunkBlockImpl);

function HunkBlockImpl({ filePath, hunk, viewType, selected, onSelect, subagentId, renameGroups }: Props): JSX.Element {
  const decided = hunk.status !== 'pending';
  const openChat = useUi((s) => s.openChat);
  const editMode = useUi((s) => s.editMode);
  const setEditMode = useUi((s) => s.setEditMode);
  const reasonInputOpen = useUi((s) => s.reasonInputOpen);
  const toggleReasonInput = useUi((s) => s.toggleReasonInput);
  const renameGroupOpen = useUi((s) => s.renameGroupOpen);
  const toggleRenameGroupPanel = useUi((s) => s.toggleRenameGroupPanel);
  const wrapLines = useUi((s) => s.wrapLines);

  const isEditing = editMode?.filePath === filePath && editMode?.hunkIndex === hunk.index;
  const reasonKey = `${filePath}::${hunk.index}`;
  const isReasonOpen = !!reasonInputOpen[reasonKey];
  const isGroupPanelOpen = !!renameGroupOpen[reasonKey];

  const cls = [styles.root, selected ? styles.selected : '', styles[`status_${hunk.status}`] ?? '', wrapLines ? styles.wrap : ''].filter(Boolean).join(' ');

  // v0.3 — when keyboard navigation selects this hunk, scroll it into view.
  // `block: 'nearest'` minimises scroll movement (only when out of viewport),
  // and the absence of `behavior: 'smooth'` keeps rapid j/k presses snappy.
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <section
      ref={ref}
      className={cls}
      onMouseDown={() => onSelect(hunk.index)}
      aria-labelledby={`hunk-header-${hunk.index}`}
    >
      <header
        className={styles.header}
        title={subagentId ? `Produced by Task: ${subagentId}` : undefined}
      >
        <code id={`hunk-header-${hunk.index}`} className={styles.hunkHeader}>{hunk.header}</code>
        {/* v0.3: per-hunk risk flag badges (deletion, large-hunk, removed-error-handling, etc.) */}
        <FlagBadges flags={hunk.flags} />
        {/* v0.5: per-hunk build-signal badge — surfaces when tsc errors fall
            within this hunk's line range. v0.5.1 (LH3): hover/focus renders
            a full popover (not the native `title` attribute, which clips
            multi-line content across browsers). */}
        {hunk.buildErrors && hunk.buildErrors.length > 0 && (
          <TooltipPopover
            content={hunk.buildErrors.map((e) => `TS${e.code} (line ${e.line}): ${e.message}`).join('\n')}
            ariaLabel={`${hunk.buildErrors.length} tsc error${hunk.buildErrors.length === 1 ? '' : 's'} affect this hunk`}
          >
            <span
              className={styles.buildErrorBadge}
              tabIndex={0}
            >
              🚨 {hunk.buildErrors.length} tsc {hunk.buildErrors.length === 1 ? 'error' : 'errors'}
            </span>
          </TooltipPopover>
        )}
        {/* v0.4 (A8 cheap): rename-group chip. Click to expand the inline group panel. */}
        {hunk.renameGroupId && renameGroups?.[hunk.renameGroupId] && (
          <button
            type="button"
            className={styles.renameChip}
            onClick={(ev) => { ev.stopPropagation(); toggleRenameGroupPanel(filePath, hunk.index); }}
            title={`Rename group: ${hunk.renameGroupId}`}
            aria-label={`Toggle rename group panel for ${hunk.renameGroupId}`}
          >
            ↻ rename · {Math.max(0, (renameGroups[hunk.renameGroupId]?.length ?? 1) - 1)} more
          </button>
        )}
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
          {/* v0.4 (A4): Edit button — pending only (L6). Pressing the keyboard
              shortcut `e` while this hunk is selected has the same effect. */}
          {!decided && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnEdit}`}
              onClick={() => setEditMode({ filePath, hunkIndex: hunk.index })}
              aria-label={`Edit hunk ${hunk.index + 1}`}
              title="Edit in place (e)"
            >
              ✎ Edit
            </button>
          )}
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
          {/* v0.4 (A5): on rejected hunks, offer "Add reason" so the user can
              attach a reason that funnels into the drafts queue. */}
          {hunk.status === 'rejected' && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnChat}`}
              onClick={() => toggleReasonInput(filePath, hunk.index)}
              aria-label={`Add rejection reason for hunk ${hunk.index + 1}`}
              title="Add reason"
            >
              💬 Add reason
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

      {/* v0.4 (A4): inline edit textarea, mounted when this hunk is in edit mode. */}
      {isEditing && hunk.status === 'pending' && (
        <InlineExpandingPanel
          mode="edit"
          initialValue={extractHunkAfterView(hunk)}
          maxBytes={EDIT_BYTES_CAP}
          placeholder="Edit the after-content of this hunk and click Save."
          saveLabel="Save edit"
          onCancel={() => setEditMode(null)}
          onSave={(value) => {
            send({ type: 'save-hunk-edit', filePath, hunkIndex: hunk.index, editedAfter: value });
            setEditMode(null);
          }}
        />
      )}

      {/* v0.4 (A5): inline reason textarea, mounted when "Add reason" is clicked. */}
      {isReasonOpen && hunk.status === 'rejected' && (
        <InlineExpandingPanel
          mode="reason"
          maxBytes={REASON_BYTES_CAP}
          placeholder="Why did you reject this hunk?"
          saveLabel="Save to drafts"
          onCancel={() => toggleReasonInput(filePath, hunk.index, false)}
          onSave={(value) => {
            send({ type: 'add-rejection-reason', filePath, hunkIndex: hunk.index, reason: value });
            toggleReasonInput(filePath, hunk.index, false);
          }}
        />
      )}

      {/* v0.4 (A8 cheap): inline rename-group panel. */}
      {isGroupPanelOpen && hunk.renameGroupId && renameGroups?.[hunk.renameGroupId] && (
        <InlineExpandingPanel
          mode="info"
          onCancel={() => toggleRenameGroupPanel(filePath, hunk.index, false)}
        >
          <RenameGroupPanel
            groupId={hunk.renameGroupId}
            members={renameGroups[hunk.renameGroupId]!}
            onClose={() => toggleRenameGroupPanel(filePath, hunk.index, false)}
          />
        </InlineExpandingPanel>
      )}
    </section>
  );
}

function RenameGroupPanel({
  groupId,
  members,
  onClose,
}: {
  groupId: string;
  members: ReadonlyArray<{ filePath: string; hunkIndex: number }>;
  onClose(): void;
}): JSX.Element {
  const [oldTok, newTok] = groupId.split('->');
  return (
    <div className={styles.renameGroupPanel}>
      <div className={styles.renameGroupHeader}>
        <strong>{oldTok}</strong> → <strong>{newTok}</strong> across {members.length} hunks
      </div>
      <ul className={styles.renameGroupList}>
        {members.map((m) => (
          <li key={`${m.filePath}::${m.hunkIndex}`}>
            <code>{m.filePath}</code> · hunk {m.hunkIndex + 1}
          </li>
        ))}
      </ul>
      <div className={styles.renameGroupActions}>
        <button
          type="button"
          className={styles.renameGroupAccept}
          onClick={() => { send({ type: 'decide-rename-group', groupId, action: 'accept' }); onClose(); }}
        >
          ✓ Accept all ({members.length})
        </button>
        <button
          type="button"
          className={styles.renameGroupReject}
          onClick={() => { send({ type: 'decide-rename-group', groupId, action: 'reject' }); onClose(); }}
        >
          ✗ Reject all ({members.length})
        </button>
        <button type="button" className={styles.renameGroupCancel} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
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
              {/* v0.3: `title` shows full content on hover — long lines clip
                  silently now (no per-line scrollbars; see HunkBlock.module.css). */}
              <span className={styles.lineText} title={row.left.text || undefined}>
                {row.left.text}
              </span>
            </pre>
            <pre className={`${styles.splitCell} ${styles[`cell_${row.right.kind}`]}`}>
              <span className={styles.gutter}>{row.right.kind === 'add' ? '+' : ' '}</span>
              <span className={styles.lineText} title={row.right.text || undefined}>
                {row.right.text}
              </span>
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
