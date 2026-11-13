import { describe, expect, it } from "vitest";

import { hasCollapsedSidebarParam } from "./use-sidebar-collapsed";

// ---------------------------------------------------------------------------
// ?sidebar=collapsed deep-link request (Recordings / Recent Calls lead
// links open Workspace on the icon rail). Pure query-string check —
// no window needed when the search string is passed explicitly, so
// this runs in the node test environment like the rest of the suite.
// ---------------------------------------------------------------------------

describe("hasCollapsedSidebarParam", () => {
  it("is false without arguments outside the browser", () => {
    expect(hasCollapsedSidebarParam()).toBe(false);
  });

  it("recognizes the exact collapsed request", () => {
    expect(hasCollapsedSidebarParam("?sidebar=collapsed")).toBe(true);
    expect(
      hasCollapsedSidebarParam("?contact=c-1&sidebar=collapsed")
    ).toBe(true);
    expect(
      hasCollapsedSidebarParam("?sidebar=collapsed&highlight=only")
    ).toBe(true);
  });

  it("ignores other sidebar values and params", () => {
    expect(hasCollapsedSidebarParam("")).toBe(false);
    expect(hasCollapsedSidebarParam("?contact=c-1")).toBe(false);
    expect(hasCollapsedSidebarParam("?sidebar=expanded")).toBe(false);
    expect(hasCollapsedSidebarParam("?sidebar=")).toBe(false);
    expect(hasCollapsedSidebarParam("not a query string")).toBe(false);
  });
});
