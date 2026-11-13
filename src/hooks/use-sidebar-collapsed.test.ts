import { describe, expect, it, afterEach } from "vitest";

import {
  hasCollapsedSidebarParam,
  stripCollapsedSidebarParam,
} from "./use-sidebar-collapsed";

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

describe("stripCollapsedSidebarParam", () => {
  const realWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    if (realWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = realWindow;
    }
  });

  function fakeWindow(href: string) {
    let current = href;
    (globalThis as Record<string, unknown>).window = {
      location: {
        get href() {
          return current;
        },
      },
      history: {
        replaceState(_state: unknown, _title: string, url: string) {
          current = new URL(url, "https://app.example").toString();
        },
      },
    };
    return () => current;
  }

  it("is a no-op without a window (SSR)", () => {
    expect(() => stripCollapsedSidebarParam()).not.toThrow();
  });

  it("drops only the sidebar flag and preserves everything else", () => {
    const getHref = fakeWindow(
      "https://app.example/workspace?contact=c-1&sidebar=collapsed#notes",
    );
    stripCollapsedSidebarParam();
    expect(getHref()).toBe("https://app.example/workspace?contact=c-1#notes");
  });

  it("leaves the URL alone when the flag is absent", () => {
    const getHref = fakeWindow("https://app.example/workspace?contact=c-1");
    stripCollapsedSidebarParam();
    expect(getHref()).toBe("https://app.example/workspace?contact=c-1");
  });
});
