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

describe("single bottom scrollbar, always visible", () => {
  it("renders exactly one thumb below the vertical viewport (never in the row flow)", () => {
    expect(pageSrc).toContain('label="Bottom table scrollbar"');
    expect(pageSrc).not.toContain('label="Top table scrollbar"');
    expect(pageSrc).not.toContain('label="Secondary table scrollbar"');
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const tableEnd = pageSrc.indexOf("</Table>");
    expect(tableEnd).toBeGreaterThan(-1);
    expect(tableEnd).toBeLessThan(thumbIdx);
    // The vertical viewport closes BEFORE the strip: the strip is
    // a card-level sibling, so its visibility cannot depend on
    // row scroll position — first, middle, and last rows all show
    // it. No sticky-bottom reliance of any kind.
    const between = pageSrc.slice(tableEnd, thumbIdx);
    expect(between).toContain("</div>");
    expect(pageSrc).not.toContain("sticky bottom-0");
  });

  it("sits below the table and above pagination (covers neither)", () => {
    // Plain block sibling after the viewport, ahead of
    // pagination — always on screen with the card, never an
    // overlay over rows.
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const pagerIdx = pageSrc.indexOf("<WorkspacePagination", thumbIdx);
    expect(pagerIdx).toBeGreaterThan(thumbIdx);
    expect(pageSrc).toContain("border-t border-border bg-card");
  });

  it("fills the card width (aligned, never the sidebar, never overflow)", () => {
    // Block-level sibling of the viewport inside the same card:
    // width follows the card automatically — no measured inline
    // width that could desync.
    const thumbIdx = pageSrc.indexOf('label="Bottom table scrollbar"');
    const block = pageSrc.slice(Math.max(0, thumbIdx - 600), thumbIdx);
    expect(block).not.toContain("metrics.viewportWidth");
    expect(block).toContain("border-t border-border bg-card");
  });

  it("drives the table's own scroller, nothing else", () => {
    // The viewport div IS the scroller (globals.css neutralizes
    // the Table primitive's inner container to `visible`).
    expect(pageSrc).toContain("return viewportRef.current;");
  });

  it("hides the duplicate native horizontal track in every browser", () => {
    // overflow-x-hidden user-hides the axis (no WebKit-only
    // pseudo-element hacks, no Firefox fallback gap) while the
    // axis stays programmatically scrollable — thumb drags and
    // wheel input write scrollLeft directly.
    expect(pageSrc).toContain("overflow-x-hidden");
    expect(pageSrc).toContain("overflow-y-auto");
    expect(pageSrc).not.toContain("::-webkit-scrollbar");
  });
});

describe("single-source synchronization", () => {
  it("keeps one scroll container: no nested horizontal scrollers", () => {
    // A second overflow-x context would desynchronize positions;
    // the thumb repaints from the shared scroller instead.
    // Vertical scrolls natively; horizontal is user-hidden but
    // programmatically driven.
    expect(pageSrc).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-y-auto");
    expect(pageSrc).toContain("overflow-x-hidden");
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

  it("gives headers and body cells identical freeze offsets", () => {
    // No. header and No. body both pin at left: 0; Name header
    // and Name body both pin at the measured No. width — the
    // pairs move and align together at scroll 0 and at maximum.
    const noHeader = pageSrc.indexOf("...(freezeReady ? { left: 0 } : null)");
    expect(noHeader).toBeGreaterThan(-1);
    expect(pageSrc).toContain("left: nameLeft");
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

  it("paints every header from its own order slot (Dial helpers consume none)", () => {
    // Dial THs render between flow THs but consume no
    // visibleHeaderOrder/background slot (hardcoded geometry), so
    // headers index by ORDER position — the same slot whose
    // widthId the body cells resolve. Offsetting past Dials would
    // shift later headers into the wrong slot and the tail past
    // the array end (transparent, widthless headers that read as
    // unfrozen next to their opaque frozen body cells).
    expect(pageSrc).not.toContain("dialsBefore");
    expect(pageSrc).toContain("const headerIdx = (rowVisible ? 1 : 0) + flowIdx;");
  });

  it("keeps the frozen boundary on the existing cell dividers", () => {
    // No new border/shadow utilities on frozen cells: the
    // long-standing border-r separators mark the boundary.
    expect(pageSrc).not.toContain("STICKY_Z");
  });
});

describe("Shift+wheel and trackpad input", () => {
  it("swaps Shift+wheel deltas onto the horizontal axis", () => {
    expect(syncSrc).toContain("e.shiftKey");
    expect(syncSrc).toContain("e.preventDefault()");
    expect(syncSrc).toContain("passive: false");
    expect(syncSrc).toContain("deltaMode");
    expect(syncSrc).toContain("if (e.deltaY === 0) return;");
    expect(syncSrc).toContain("vp.scrollLeft += scale(e.deltaY, e.deltaMode);");
  });

  it("applies trackpad horizontal swipes manually (axis is user-hidden)", () => {
    // The native horizontal axis can't consume deltaX itself, so
    // the handler writes scrollLeft directly — and carries a
    // diagonal gesture's vertical component along so vertical
    // scrolling never stalls mid-swipe. Plain vertical wheel
    // passes through to the native vertical bar untouched.
    expect(syncSrc).toContain("e.deltaX");
    expect(syncSrc).toContain("if (e.deltaX === 0) return;");
    expect(syncSrc).toContain("vp.scrollLeft += scale(e.deltaX, e.deltaMode);");
    expect(syncSrc).toContain("vp.scrollTop += scale(e.deltaY, e.deltaMode);");
  });
});

describe("thumb visuals", () => {
  it("paints a grey thumb on a neutral track", () => {
    expect(syncSrc).toContain("bg-neutral-400");
    expect(syncSrc).toContain("rounded-full bg-muted");
  });

  it("renders the thumb ~30% longer with a responsive floor, clamped to the track", () => {
    // Longer grab target where space permits; the track-relative
    // floor keeps it usable on narrow viewports; the clamp keeps
    // it inside the track so both ends stay reachable.
    expect(syncSrc).toContain("proportional * 1.3");
    expect(syncSrc).toContain("Math.max(40, Math.round(trackW * 0.12))");
    expect(syncSrc).toContain("Math.min(trackW, Math.max(minW,");
  });

  it("keeps drag-to-scroll mapping exact at the wider width", () => {
    // Drag math measures the LIVE thumb width off the DOM
    // (offsetWidth) and spans the remaining track, so the wider
    // thumb controls the complete range accurately — far-left and
    // far-right stay reachable with no rescaling needed.
    expect(syncSrc).toContain("thumb.offsetWidth");
    expect(syncSrc).toContain("m.trackW - m.thumbW");
    expect(syncSrc).toContain("(trackW - thumbW)");
  });
});
