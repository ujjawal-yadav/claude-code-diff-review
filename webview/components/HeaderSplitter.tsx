import { useCallback, useRef } from 'react';
import { useUi } from '../store';
import styles from '../styles/HeaderSplitter.module.css';

/**
 * Horizontal drag-handle below the session header (change-summary banner).
 *
 * Mirrors the existing vertical `<Splitter />` between file list and diff,
 * but resizes the banner's HEIGHT — useful when the `lastAssistantMessage`
 * runs long (multi-paragraph summaries). Double-click resets to default.
 *
 * Pointer-events with `setPointerCapture` so the drag follows the cursor
 * even when it leaves the element.
 */
export function HeaderSplitter(): JSX.Element {
  const setHeaderHeight = useUi((s) => s.setHeaderHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragRef.current = { startY: ev.clientY, startHeight: useUi.getState().headerHeight };
  }, []);

  const onPointerMove = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dy = ev.clientY - drag.startY;
    setHeaderHeight(drag.startHeight + dy);
  }, [setHeaderHeight]);

  const onPointerUp = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.releasePointerCapture(ev.pointerId);
    dragRef.current = null;
  }, []);

  const onDoubleClick = useCallback(() => {
    setHeaderHeight(140);
  }, [setHeaderHeight]);

  return (
    <div
      className={styles.root}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize change summary"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
    >
      <div className={styles.indicator} aria-hidden="true" />
    </div>
  );
}
