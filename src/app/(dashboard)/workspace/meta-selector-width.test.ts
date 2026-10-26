// Workspace Meta table selector — long names stay readable.
//
// Source assertions (the page is too heavy to render here, following
// the columns-menu test pattern). The selector lives in the shared
// workspace header now; this pins that:
//   * the Meta selector trigger is wider on desktop but capped at
//     the container (no page overflow), full-width on mobile;
//   * Flow Tables keep the original narrow trigger untouched;
//   * truncation always carries the full name as a tooltip;
//   * selection behavior (value/onValueChange/placeholder/search/
//     keyboard) is untouched — only widths and title attrs kept.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const header = () =>
  readFileSync(`${root}/src/components/workspace/workspace-header.tsx`, "utf8");
const page = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");

describe("workspace header — Meta table selector width", () => {
  it("widens only the Meta selector trigger, capped at the container", () => {
    const src = header();
    expect(src).toContain("sm:w-[min(24rem,100%)]");
    // Flow Tables keep the original width.
    expect(src).toContain('"border-border bg-card w-full sm:w-72"');
  });

  it("keeps the menu within the viewport on small screens", () => {
    expect(header()).toContain("max-w-[calc(100vw-2rem)]");
  });

  it("exposes full names via tooltip and ellipsizes instead of clipping", () => {
    const src = header();
    expect(src).toContain('<span className="block min-w-0 truncate" title={displayName(active.name)}>');
    expect(src).toContain("title={wide ? displayName(f.name) : undefined}");
    expect(src).toContain("[&>span]:min-w-0 [&>span]:shrink [&>span]:truncate");
  });

  it("preserves selection behavior, value, and placeholder", () => {
    const src = header();
    expect(src).toContain("onValueChange={(v) => {");
    expect(src).toContain("if (typeof v === \"string\" && v) onSelect(v)");
    expect(src).toContain('<SelectValue placeholder="Select Flow">');
    expect(src).toContain('aria-label="Select flow"');
    expect(src).toContain("{displayName(f.name)}");
    // Type-to-filter search box inside the menu.
    expect(src).toContain('placeholder="Search tables…"');
    expect(src).toContain('aria-label="Search tables"');
  });

  it("renders names verbatim — no renaming of tables", () => {
    const src = header();
    // The selector only displays displayName(name); nothing in
    // the selector writes back to flows or the database.
    expect(src).not.toMatch(/update\(.*name.*\)/);
    expect(src).toContain("{displayName(active.name)}");
  });

  it("the page renders the shared header with the table selector", () => {
    const src = page();
    expect(src).toContain("WorkspacePageHeader");
    expect(src).toContain("WorkspaceTableSelector");
    expect(src).toContain("flowDisplayName");
  });
});
