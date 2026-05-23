import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from '../styles/TooltipPopover.module.css';

/**
 * v0.5.1 (LH3) — reusable tooltip popover primitive.
 *
 * The native `title` attribute clips multi-line content inconsistently
 * (Safari: 1 line max; Chrome: ~5 lines then truncation). tsc errors with
 * 200+ char messages, or hunks with multiple errors, are unreadable via
 * native tooltips. This component fixes that by rendering a real DOM
 * popover via React Portal with `white-space: pre-wrap`, viewport-edge
 * flip, max-width, and accessible focus support.
 *
 * Design (LH10 + LH11):
 *   - Triggered by hover (mouseenter/leave) AND focus (focusin/focusout).
 *     Keyboard-only users get the tooltip too.
 *   - Positioned via `getBoundingClientRect()` on the anchor; flips above
 *     when the anchor is near the viewport bottom.
 *   - Rendered through `createPortal(..., document.body)` to escape any
 *     `overflow: hidden` parent (HunkBlock has clipped split cells).
 *   - `aria-describedby` wires the trigger to the tooltip for screen
 *     readers.
 *
 * Single child element required. The component clones it to attach event
 * handlers + ref + aria; existing handlers/refs on the child are merged.
 */

interface TooltipPopoverProps {
  /** Single trigger element (badge, chip, button). */
  children: React.ReactElement;
  /** Tooltip body — string or rich JSX. */
  content: React.ReactNode;
  /** ARIA label fallback if `children` is non-textual (icons). */
  ariaLabel?: string;
  /** Max width in pixels. Default 480. */
  maxWidth?: number;
  /** Optional className to pass through to the popover element. */
  className?: string;
}

interface PopoverCoords {
  x: number;
  y: number;
  flip: boolean;
}

const POPOVER_HEIGHT_BUDGET = 220;
const VIEWPORT_MARGIN = 8;

export function TooltipPopover({
  children,
  content,
  ariaLabel,
  maxWidth = 480,
  className,
}: TooltipPopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const computePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flip = r.bottom + POPOVER_HEIGHT_BUDGET > window.innerHeight - VIEWPORT_MARGIN;
    const x = Math.min(
      Math.max(VIEWPORT_MARGIN, r.left),
      window.innerWidth - maxWidth - VIEWPORT_MARGIN,
    );
    const y = flip ? r.top - VIEWPORT_MARGIN : r.bottom + VIEWPORT_MARGIN;
    setCoords({ x, y, flip });
  }, [maxWidth]);

  const showTooltip = useCallback(() => {
    computePosition();
    setOpen(true);
  }, [computePosition]);

  const hideTooltip = useCallback(() => {
    setOpen(false);
  }, []);

  // Recompute on scroll / resize while open so the popover tracks the anchor.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => computePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, computePosition]);

  // Compose props with whatever the child already has, preserving existing
  // handlers + refs.
  const childExisting = children.props as Record<string, unknown>;
  const childOnMouseEnter = childExisting.onMouseEnter as ((e: React.MouseEvent) => void) | undefined;
  const childOnMouseLeave = childExisting.onMouseLeave as ((e: React.MouseEvent) => void) | undefined;
  const childOnFocus      = childExisting.onFocus      as ((e: React.FocusEvent) => void) | undefined;
  const childOnBlur       = childExisting.onBlur       as ((e: React.FocusEvent) => void) | undefined;
  const childExistingRef  = (children as unknown as { ref?: React.Ref<HTMLElement> }).ref;

  const mergedRef = useCallback((node: HTMLElement | null) => {
    anchorRef.current = node;
    if (typeof childExistingRef === 'function') (childExistingRef as (n: HTMLElement | null) => void)(node);
    else if (childExistingRef && typeof childExistingRef === 'object' && 'current' in childExistingRef) {
      (childExistingRef as { current: HTMLElement | null }).current = node;
    }
  }, [childExistingRef]);

  const enhancedChild = React.cloneElement(children, {
    ref: mergedRef,
    onMouseEnter: (e: React.MouseEvent) => { childOnMouseEnter?.(e); showTooltip(); },
    onMouseLeave: (e: React.MouseEvent) => { childOnMouseLeave?.(e); hideTooltip(); },
    onFocus:      (e: React.FocusEvent) => { childOnFocus?.(e); showTooltip(); },
    onBlur:       (e: React.FocusEvent) => { childOnBlur?.(e); hideTooltip(); },
    'aria-describedby': open ? 'ccdr-tooltip-popover' : undefined,
    ...(ariaLabel && !childExisting['aria-label'] ? { 'aria-label': ariaLabel } : {}),
  } as React.HTMLAttributes<HTMLElement> & { ref: React.Ref<HTMLElement> });

  return (
    <>
      {enhancedChild}
      {open && coords
        ? createPortal(
            <div
              id="ccdr-tooltip-popover"
              role="tooltip"
              className={`${styles.tooltip} ${className ?? ''}`}
              style={{
                position: 'fixed',
                left: coords.x,
                top: coords.y,
                maxWidth,
                transform: coords.flip ? 'translateY(-100%)' : undefined,
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
