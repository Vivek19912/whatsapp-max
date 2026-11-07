import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Workspace horizontal scrolling: exactly ONE visible scrollbar — a
// sticky bottom thumb strip driving the table's own scroller — with
// frozen No. + Name columns, Shift+wheel, and native trackpad
// swipes. The grid renders only in the browser, so (like the grid
// tests) this pins the architecture as source assertions: no top
// strips, no strip rows, a shared scroller, ref-driven sync (no
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
const cssSrc = readFileSync(
  `${root}/src/app/globals.css`,
  "utf8"
);

describe("both top scrollbars are gone", () => {
  it("renders no top strip above the table", () => {
    expect(pageSrc).not.toContain('label="Top table scrollbar"');
    expect(pageSrc).not.toContain("sticky top-0 left-0 z-30");
  });

  it("renders no secondary strip row below the headers", () => {
    expect(pageSrc).not.toContain('label="Secondary table scrollbar"');
    expect(pageSrc).not.toContain("const stripColSpan");
    expect(pageSrc).not.toContain("colSpan={stripColSpan}");
    // The thead holds exactly one row (the header row) — no
    // placeholder strip rows left behind.
    expect(pageSrc).not.toContain("Secondary thumb strip");
  });

  it("leaves no strip spacing behind (headers stick to the top)", () => {
    expect(pageSrc).not.toContain("sticky top-4 z-20");
    expect(pageSrc).not.toContain("top: canSendMessages ? 80 : 60");
  });
});

describe("single sticky bottom scrollbar", () => {
  it("renders exactly one thumb, after the table, stuck to the viewport bottom", () => {
    expect(pageSrc).toContain('label="Bottom table scrollbar"');
    expect(pageSrc).not.toContain('label="Top table scrollbar"');
    expect(pageSrc).not.toContain('label="Secondary table scrollbar"');
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const tableEnd = pageSrc.indexOf("</Table>", thumbIdx - 4000);
    expect(tableEnd).toBeGreaterThan(-1);
    expect(tableEnd).toBeLessThan(thumbIdx);
    expect(pageSrc).toContain("sticky bottom-0 left-0 z-30");
  });

  it("stays in-flow (never an overlay over rows or pagination)", () => {
    // In-flow block after </Table>, inside the viewport, ahead of
    // pagination — stickiness keeps it visible while rows scroll.
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const pagerIdx = pageSrc.indexOf("<WorkspacePagination", thumbIdx);
    expect(pagerIdx).toBeGreaterThan(thumbIdx);
    expect(pageSrc).toContain("border-t border-border bg-card");
  });

  it("tracks the measured viewport width (never the sidebar, never overflow)", () => {
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const block = pageSrc.slice(Math.max(0, thumbIdx - 600), thumbIdx);
    expect(block).toContain("metrics.viewportWidth");
  });

  it("drives the table's own scroller, nothing else", () => {
    // The viewport div IS the scroller (globals.css neutralizes
    // the Table primitive's inner container to `visible`).
    expect(pageSrc).toContain("return viewportRef.current;");
  });

  it("hides the duplicate native horizontal track", () => {
    expect(cssSrc).toContain(
      ".workspace-table-viewport::-webkit-scrollbar:horizontal"
    );
  });
});

describe("single-source synchronization", () => {
  it("keeps one scroll container: no nested horizontal scrollers", () => {
    // A second overflow-x context would desynchronize positions;
    // the thumb repaints from the shared scroller instead.
    expect(pageSrc).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-auto");
  });

  it("repaints the thumb from scroll events without re-rendering", () => {
    expect(syncSrc).toContain("addEventListener('scroll', syncThumb");
    expect(syncSrc).toContain("thumb.style.width");
    expect(syncSrc).toContain("thumb.style.transform");
    // Position state never exists: no per-scroll setState anywhere
    // in the strip component.
    expect(syncSrc).not.toContain("setThumb");
    expect(syncSrc).not.toContain("setScrollLeft");
  });

  it("supports drag, track-click, and keyboard on the thumb", () => {
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
    expect(pageSrc).toContain("sticky top-0 z-20");
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
