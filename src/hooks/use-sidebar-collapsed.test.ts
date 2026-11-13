import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("toggle with a one-time deep-link flag", () => {
  const hookSrc = readFileSync(join(__dirname, "use-sidebar-collapsed.ts"), "utf8");
  const toggleSrc = hookSrc.slice(hookSrc.indexOf("const toggle = useCallback("));

  it("forgets a present flag via a plain history swap, never a Next.js navigation", () => {
    expect(toggleSrc).toContain("stripCollapsedSidebarParam();");
    expect(toggleSrc).not.toContain("router.replace(");
  });

  it("never persists a preference when expanding a link-only collapse", () => {
    // Link-only collapse (nothing stored, flag just forgotten) must
    // expand without writing storage: persisting there would leak a
    // per-tab request into the account-wide preference.
    expect(toggleSrc).toContain("if (!hadParam || stored) {");
  });

  it("still strips a redundant flag when toggling out of a stored collapse", () => {
    // Stored collapse + lingering flag: the strip runs first so the
    // flag cannot snap the rail back after the stored value flips.
    const stripIdx = toggleSrc.indexOf("stripCollapsedSidebarParam();");
    const saveIdx = toggleSrc.indexOf("saveSidebarCollapsed(accountId, !stored);");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(stripIdx);
  });
});
