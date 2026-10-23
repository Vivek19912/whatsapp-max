// Workspace Meta table selector — long names stay readable.
//
// Source assertions (the page is too heavy to render here, following
// the columns-menu test pattern). Pins that:
//   * the Meta selector trigger is wider on desktop but capped at
//     the container (no page overflow), full-width on mobile;
//   * Flow Tables keep the original narrow trigger untouched;
//   * truncation always carries the full name as a tooltip;
//   * selection behavior (value/onValueChange/placeholder/search/
//     keyboard) is untouched — only classes and title attrs changed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const page = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

describe("workspace page — Meta table selector width", () => {
  it("widens only the Meta selector trigger, capped at the container", () => {
    const src = page();
    expect(src).toContain("sm:w-[min(24rem,100%)]");
    // Flow Tables keep the original width.
    expect(src).toContain('"border-border bg-card w-full sm:w-72"');
  });

  it("keeps the menu within the viewport on small screens", () => {
    expect(page()).toContain("max-w-[calc(100vw-2rem)]");
  });

  it("exposes full names via tooltip and ellipsizes instead of clipping", () => {
    const src = page();
    expect(src).toContain('<span className="block min-w-0 truncate" title={activeFlowLabel}>');
    expect(src).toContain("title={isMetaTable ? flowDisplayName(f.name) : undefined}");
    expect(src).toContain("[&>span]:min-w-0 [&>span]:shrink [&>span]:truncate");
  });

  it("preserves selection behavior, value, and placeholder", () => {
    const src = page();
    expect(src).toContain("<Select value={flowId ?? ''} onValueChange={selectFlow}>");
    expect(src).toContain('<SelectValue placeholder="Select Flow">');
    expect(src).toContain('aria-label="Select flow"');
    expect(src).toContain("{flowDisplayName(f.name)}");
  });

  it("renders names verbatim — no renaming of tables", () => {
    const src = page();
    // The selector only displays flowDisplayName(name); nothing in
    // the selector writes back to flows or the database.
    expect(src).not.toMatch(/update\(.*name.*\)/);
    expect(src).toContain("{activeFlowLabel}");
  });
});
