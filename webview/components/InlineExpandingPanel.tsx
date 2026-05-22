import { useEffect, useRef, useState } from 'react';
import styles from '../styles/InlineExpandingPanel.module.css';

/**
 * v0.4 — reusable inline expanding text-input primitive.
 *
 * Three modes:
 *   - `edit`   : pre-populated with the hunk's current after view; Save
 *                emits the edited text.
 *   - `reason` : empty textarea; Save emits a rejection reason.
 *   - `info`   : no textarea — just renders `children` (used for the
 *                rename-group panel which has its own content).
 *
 * Single component family per L110 — avoids three near-identical inline
 * editors drifting apart over time. Focus is auto-acquired on mount so
 * the user can type immediately after pressing `e` / clicking the
 * affordance.
 */

interface PropsBase {
  mode: 'edit' | 'reason' | 'info';
  onCancel(): void;
  /** Optional placeholder for `edit` / `reason` modes. */
  placeholder?: string;
  /** Label on the primary action button. Defaults to "Save". */
  saveLabel?: string;
  /** Cap submitted text at this byte length (UTF-8); blocks Save above. */
  maxBytes?: number;
  /** Children render below the textarea (or in place of it for `info`). */
  children?: React.ReactNode;
}

interface EditOrReasonProps extends PropsBase {
  mode: 'edit' | 'reason';
  initialValue?: string;
  onSave(value: string): void;
}

interface InfoProps extends PropsBase {
  mode: 'info';
  initialValue?: undefined;
  onSave?: undefined;
}

type Props = EditOrReasonProps | InfoProps;

export function InlineExpandingPanel(props: Props): JSX.Element {
  const { mode, children } = props;
  const [value, setValue] = useState<string>(
    mode !== 'info' ? (props.initialValue ?? '') : '',
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Focus on mount so the user can type immediately. Defer one tick to
    // make sure the textarea is mounted (StrictMode double-mount-safe).
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  if (mode === 'info') {
    return (
      <div className={styles.root} role="region" aria-label="Info panel">
        {children}
      </div>
    );
  }
  return (
    <InlineEditor
      {...(props as EditOrReasonProps)}
      value={value}
      setValue={setValue}
      textareaRef={ref}
    />
  );
}

function InlineEditor({
  mode,
  onCancel,
  onSave,
  placeholder,
  saveLabel,
  maxBytes,
  value,
  setValue,
  textareaRef,
}: EditOrReasonProps & {
  value: string;
  setValue: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}): JSX.Element {
  const byteLength = new Blob([value]).size;
  const overSize = maxBytes !== undefined && byteLength > maxBytes;
  const canSave = value.length > 0 && !overSize;

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onCancel();
      return;
    }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      if (canSave) onSave(value);
      return;
    }
  };

  return (
    <div className={styles.root} role="region" aria-label={mode === 'edit' ? 'Edit hunk' : 'Rejection reason'}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={styles.textarea}
        rows={mode === 'edit' ? 12 : 4}
        spellCheck={mode === 'reason'}
      />
      <div className={styles.footer}>
        <span className={styles.hint}>
          {overSize
            ? `Too long (${byteLength.toLocaleString()} / ${(maxBytes ?? 0).toLocaleString()} bytes)`
            : 'Ctrl+Enter to save · Esc to cancel'}
        </span>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={styles.save}
            disabled={!canSave}
            onClick={() => { if (canSave) onSave(value); }}
          >
            {saveLabel ?? 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
