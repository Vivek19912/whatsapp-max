'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

type ScrollerGetter = () => HTMLElement | null;

/**
 * Shared horizontal-scroll infrastructure for the Workspace grid.
 *
 * One scroller owns the truth: the bordered
 * `.workspace-table-viewport` div itself. (The shadcn Table
 * primitive's inner container is neutralized to `visible` by
 * globals.css, precisely so a single native scrollbar pair serves
 * the table.) Every control — the sticky top strip, the
 * below-headers strip, native trackpad swipes, Shift+wheel — reads
 * or writes THAT element, never a second scroll position, so
 * nothing can desynchronize.
 *
 * Scroll position itself never touches React state: thumbs mutate
 * their own DOM directly on scroll events (passive listeners), so
 * dragging or wheeling causes zero re-renders. State only carries
 * slow-changing geometry (frozen offsets, viewport width).
 */

/** Blue thumb on a neutral track, shared by both strips. */
const TRACK_CLASS =
  'relative h-2 min-w-0 flex-1 cursor-pointer rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring';
const THUMB_CLASS =
  'absolute top-0 left-0 h-2 rounded-full bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400';

/**
 * Draggable + keyboard-operable horizontal scrollbar bound to the
 * table's own scroller. A viewport-width track with a proportional
 * thumb; drag, track-click, arrows/Home/End all drive the shared
 * scroller, and every scroll of that scroller repaints the thumb.
 */
export function TableHScrollbar({
  getScroller,
  getTable,
  contentKey,
  label,
  className,
}: {
  getScroller: ScrollerGetter;
  getTable: ScrollerGetter;
  /** Changes whenever rows/columns change, so metrics re-sync. */
  contentKey: string;
  label: string;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const thumbXRef = useRef(0);
  const dragRef = useRef<{
    startX: number;
    startScroll: number;
  } | null>(null);

  // Repaint the thumb from the scroller's live geometry. Called on
  // scroll (passive), on resize/content changes, and after mount.
  // Direct DOM writes only — never React state, so scrolling never
  // re-renders.
  const syncThumb = useCallback(() => {
    const scroller = getScroller();
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !track || !thumb) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const trackW = track.clientWidth;
    if (trackW <= 0) return;
    const thumbW = max > 0 ? Math.max(24, (trackW * scroller.clientWidth) / scroller.scrollWidth) : trackW;
    const x = max > 0 ? (scroller.scrollLeft / max) * (trackW - thumbW) : 0;
    thumb.style.width = `${thumbW}px`;
    thumb.style.transform = `translateX(${x}px)`;
    thumbXRef.current = x;
    thumb.setAttribute('aria-valuenow', String(Math.max(0, Math.round(scroller.scrollLeft))));
    thumb.setAttribute('aria-valuemax', String(Math.max(0, Math.round(max))));
  }, [getScroller]);

  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;
    syncThumb();
    scroller.addEventListener('scroll', syncThumb, { passive: true });
    const ro = new ResizeObserver(syncThumb);
    ro.observe(scroller);
    const table = getTable();
    if (table) ro.observe(table);
    return () => {
      scroller.removeEventListener('scroll', syncThumb);
      ro.disconnect();
    };
  }, [getScroller, getTable, syncThumb, contentKey]);

  const metricsFor = () => {
    const scroller = getScroller();
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !track || !thumb) return null;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const trackW = track.clientWidth;
    const thumbW = thumb.offsetWidth;
    if (max <= 0 || trackW <= thumbW) return null;
    return { scroller, max, trackW, thumbW };
  };

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const m = metricsFor();
    if (!m) return;
    const rect = trackRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x >= thumbXRef.current && x <= thumbXRef.current + m.thumbW) {
      dragRef.current = { startX: e.clientX, startScroll: m.scroller.scrollLeft };
      trackRef.current!.setPointerCapture(e.pointerId);
    } else {
      // Track click: jump so the thumb centers on the pointer.
      m.scroller.scrollLeft = ((x - m.thumbW / 2) / (m.trackW - m.thumbW)) * m.max;
    }
  };

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const m = metricsFor();
    if (!drag || !m) return;
    const span = m.trackW - m.thumbW;
    if (span <= 0) return;
    m.scroller.scrollLeft = drag.startScroll + ((e.clientX - drag.startX) / span) * m.max;
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const step = (dir: 1 | -1) => {
    const scroller = getScroller();
    if (!scroller) return;
    scroller.scrollBy({ left: dir * scroller.clientWidth * 0.8, behavior: 'smooth' });
  };

  const onThumbKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const scroller = getScroller();
    if (!scroller) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    if (e.key === 'ArrowLeft') scroller.scrollLeft -= 40;
    else if (e.key === 'ArrowRight') scroller.scrollLeft += 40;
    else if (e.key === 'Home') scroller.scrollLeft = 0;
    else if (e.key === 'End') scroller.scrollLeft = max;
    else return;
    e.preventDefault();
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        type="button"
        aria-label="Scroll table left"
        onClick={() => step(-1)}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
      <div
        ref={trackRef}
        role="presentation"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={TRACK_CLASS}
      >
        <div
          ref={thumbRef}
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={0}
          aria-valuenow={0}
          onKeyDown={onThumbKeyDown}
          className={THUMB_CLASS}
        />
      </div>
      <button
        type="button"
        aria-label="Scroll table right"
        onClick={() => step(1)}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

export interface TableFreezeMetrics {
  /** Rendered width of the No. column (0 when hidden). */
  noWidth: number;
  /** Visible width of the table viewport (0 until measured). */
  viewportWidth: number;
}

/**
 * Geometry for frozen columns, measured from the rendered DOM —
 * never hardcoded, so resizes, visibility toggles, and content
 * changes can't desync the sticky offsets. Updates only when a
 * measurement actually changes (no per-scroll work; scrolling
 * never touches this state).
 */
export function useTableFreezeMetrics(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  contentKey: string,
): {
  noHeadRef: React.RefObject<HTMLTableCellElement | null>;
  nameHeadRef: React.RefObject<HTMLTableCellElement | null>;
  metrics: TableFreezeMetrics;
} {
  const noHeadRef = useRef<HTMLTableCellElement | null>(null);
  const nameHeadRef = useRef<HTMLTableCellElement | null>(null);
  const [metrics, setMetrics] = useState<TableFreezeMetrics>({
    noWidth: 0,
    viewportWidth: 0,
  });

  useEffect(() => {
    const sync = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const noWidth = noHeadRef.current?.offsetWidth ?? 0;
      const viewportWidth = vp.clientWidth;
      setMetrics((prev) =>
        prev.noWidth === noWidth && prev.viewportWidth === viewportWidth
          ? prev
          : { noWidth, viewportWidth }
      );
    };
    sync();
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(sync);
    ro.observe(vp);
    const table = vp.querySelector('table');
    if (table) ro.observe(table);
    const head = vp.querySelector('thead');
    if (head) ro.observe(head);
    return () => ro.disconnect();
  }, [viewportRef, contentKey]);

  return { noHeadRef, nameHeadRef, metrics };
}

/**
 * Shift+mouse-wheel horizontal scrolling, scoped to the table
 * viewport only. Native listener (non-passive) so preventDefault
 * reliably swaps the vertical delta onto the horizontal axis.
 * Plain wheel (and native trackpad horizontal swipes) is never
 * intercepted, so vertical scrolling, trackpad swipes, inputs,
 * and everything outside the table behave exactly as before.
 */
export function useShiftWheel(viewportRef: React.RefObject<HTMLDivElement | null>, mountKey: string) {
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      vp.scrollLeft += dy;
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [viewportRef, mountKey]);
}
