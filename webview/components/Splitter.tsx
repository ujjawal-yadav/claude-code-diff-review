import { useCallback, useRef } from 'react';
import { useUi } from '../store';
import styles from '../styles/Splitter.module.css';

/**
 * Vertical drag-handle between the file list and the diff pane.
 *
 * Pointer-events with `setPointerCapture` so the drag follows the cursor
 * even when it leaves the splitter element. The store action clamps and
 * persists; we just feed it the running pointer X.
 */
export function Splitter(): JSX.Element {
  const setSidebarWidth = useUi((s) => s.setSidebarWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragRef.current = { startX: ev.clientX, startWidth: useUi.getState().sidebarWidth };
  }, []);

  const onPointerMove = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    setSidebarWidth(drag.startWidth + dx);
  }, [setSidebarWidth]);

  const onPointerUp = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    ev.currentTarget.releasePointerCapture(ev.pointerId);
    dragRef.current = null;
  }, []);

  const onDoubleClick = useCallback(() => {
    setSidebarWidth(260);
  }, [setSidebarWidth]);

  return (
    <div
      className={styles.root}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file list"
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
