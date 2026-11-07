import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Workspace synced horizontal scrolling: one sticky thumb strip
// above the table, a second strip below the headers, frozen No. +
// Name columns, Shift+wheel, and native trackpad swipes — all
// driving the table's own scroller. The grid renders only in the
// browser, so (like the grid tests) this pins the architecture as
// source assertions: shared scroller, ref-driven sync (no
// per-scroll renders), measured offsets, and scoped wheel input.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8"
);
const syncSrc = readFileSync(
  `${root}/src/components/workspace/table-scrollbars.tsx`,
  "utf8"
);

describe("sticky top scrollbar", () => {
  it("renders above the table and sticks to the container top", () => {
    const stripIdx = pageSrc.indexOf('label="Top table scrollbar"');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(pageSrc).toContain("sticky top-0 left-0 z-30");
    // The strip precedes the table: clean spacing above the
    // headers, inside the same scroll viewport.
    const tableIdx = pageSrc.indexOf("<Table>", stripIdx);
    expect(tableIdx).toBeGreaterThan(stripIdx);
  });

  it("drives the table's own scroller, nothing else", () => {
    // The viewport div IS the scroller (globals.css neutralizes
    // the Table primitive's inner container to `visible`, so one
    // native scrollbar pair serves the grid).
    expect(pageSrc).toContain("return viewportRef.current;");
  });
});

describe("secondary below-headers scrollbar", () => {
  it("sits in its own header row beneath the column headers", () => {
    expect(pageSrc).toContain('label="Secondary table scrollbar"');
    // Exact measured span: colSpan={0} ("span to end") is
    // inconsistently supported and fractures the header/body grid,
    // so the strip spans the counted rendered columns instead.
    // (JSX attribute check: the comment above names the old value,
    // so match the attribute line ending, not the bare token.)
    expect(pageSrc).not.toContain("colSpan={0}\n");
    expect(pageSrc).toContain("colSpan={stripColSpan}");
    expect(pageSrc).toContain("top: canSendMessages ? 80 : 60");
    expect(pageSrc).toContain("metrics.viewportWidth");
  });

  it("spans every rendered column of the first header row", () => {
    // actions? + No.? + flow THs + Dial helpers + customs, min 1 —
    // mirroring the header row exactly so the grid never fractures.
    expect(pageSrc).toContain("const stripColSpan");
    expect(pageSrc).toContain("flowColumnsVisible.filter((c) => c.system && c.key === 'phone').length");
    expect(pageSrc).toContain("customFieldsOrdered.length");
  });
});

describe("single-source synchronization", () => {
  it("keeps one scroll container: no nested horizontal scrollers", () => {
    // A second overflow-x context would desynchronize positions;
    // thumbs repaint from the shared scroller instead.
    expect(pageSrc).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-auto");
  });

  it("repaints thumbs from scroll events without re-rendering", () => {
    expect(syncSrc).toContain("addEventListener('scroll', syncThumb");
    expect(syncSrc).toContain("thumb.style.width");
    expect(syncSrc).toContain("thumb.style.transform");
    // Position state never exists: no per-scroll setState anywhere
    // in the strip component.
    expect(syncSrc).not.toContain("setThumb");
    expect(syncSrc).not.toContain("setScrollLeft");
  });

  it("supports drag, track-click, and keyboard on both thumbs", () => {
    expect(syncSrc).toContain("setPointerCapture");
    expect(syncSrc).toContain("ArrowLeft");
    expect(syncSrc).toContain("Home");
    expect(syncSrc).toContain('aria-label="Scroll table left"');
    expect(syncSrc).toContain('aria-label="Scroll table right"');
  });

  it("cleans up every listener on unmount", () => {
    expect(syncSrc).toContain("removeEventListener('scroll', syncThumb)");
    expect(syncSrc).toContain("ro.disconnect()");
    expect(syncSrc).toContain("removeEventListener('wheel', onWheel)");
  });
});

describe("frozen No. and Name columns", () => {
  it("pins No. at the viewport edge with stacking above rows", () => {
    expect(pageSrc).toContain("freezeReady && 'sticky left-0 z-[1]'");
    expect(pageSrc).toContain("sticky top-4 z-20");
  });

  it("pins Name after the measured No. width (never hardcoded)", () => {
    expect(pageSrc).toContain("left: nameLeft");
    expect(pageSrc).toContain("rowVisible ? metrics.noWidth : 0");
  });

  it("applies sticky positioning only once geometry is measured", () => {
    // First render must never pin Name over No. at offset 0:
    // all four frozen cells (both headers, both body cells) gate
    // on freezeReady (viewport measured).
    expect(pageSrc).toContain("const freezeReady = metrics.viewportWidth > 0;");
    expect(pageSrc).toContain("...(freezeReady ? { left: 0 } : null)");
    expect(pageSrc).toContain("isNameCol && freezeReady");
    expect(pageSrc).toContain("freezeName && freezeReady");
  });

  it("keeps header/body widths aligned across Dial helper columns", () => {
    // Dial THs sit between flow THs but are NOT in
    // visibleHeaderOrder — indices offset past them or every
    // header after Phone paints with the wrong slot's width.
    expect(pageSrc).toContain("dialsBefore");
  });

  it("keeps the frozen boundary on the existing cell dividers", () => {
    // No new border/shadow utilities on frozen cells: the
    // long-standing border-r separators mark the boundary.
    expect(pageSrc).not.toContain("STICKY_Z");
  });
});

describe("Shift+wheel and trackpad input", () => {
  it("swaps only Shift+wheel deltas onto the horizontal axis", () => {
    expect(syncSrc).toContain("e.shiftKey");
    expect(syncSrc).toContain("e.preventDefault()");
    expect(syncSrc).toContain("passive: false");
    expect(syncSrc).toContain("deltaMode");
    // Plain wheel (and everything else) passes through untouched.
    expect(syncSrc).toContain("if (!e.shiftKey || e.deltaY === 0) return;");
  });

  it("never intercepts native trackpad horizontal swipes", () => {
    // Horizontal swipe deltas flow to the table's own scroller
    // natively; the code must never read or override them.
    expect(syncSrc).not.toContain(".deltaX");
    expect(syncSrc).not.toContain("deltaX +");
    expect(syncSrc).not.toContain("deltaX*");
  });
});

describe("thumb visuals", () => {
  it("paints a blue thumb on a neutral track", () => {
    expect(syncSrc).toContain("bg-blue-600");
    expect(syncSrc).toContain("rounded-full bg-muted");
  });
});
