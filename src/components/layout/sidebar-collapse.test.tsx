import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  sidebarCollapsedStorageKey,
} from "@/hooks/use-sidebar-collapsed";
import { Sidebar } from "./sidebar";

// ---------------------------------------------------------------------------
// Sidebar collapse/expand — persisted rail behavior (15 points).
//
// Collapse is lg-scoped CSS only: the mobile drawer always renders
// full-width. SSR markup therefore carries both the labels (hidden
// via lg:hidden when collapsed) and the wiring (triggers, toggles).
// ---------------------------------------------------------------------------

const root = process.cwd();
const sidebarSrc = readFileSync(`${root}/src/components/layout/sidebar.tsx`, "utf8");
const shellSrc = readFileSync(
  `${root}/src/app/(dashboard)/dashboard-shell.tsx`,
  "utf8",
);

const h = vi.hoisted(() => ({
  pathname: "/inbox",
  tab: null as string | null,
  accountRole: "owner" as string,
  canEditSettings: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useSearchParams: () => ({ get: (k: string) => (k === "tab" ? h.tab : null) }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    profileLoading: false,
    account: {
      id: "acct-1",
      name: "Acme",
      default_currency: "INR",
      travel_crm_url: null,
    },
    accountRole: h.accountRole,
    canEditSettings: h.canEditSettings,
  }),
}));

vi.mock("@/hooks/use-total-unread", () => ({ useTotalUnread: () => 0 }));
vi.mock("@/hooks/use-unread-notifications", () => ({
  useUnreadNotifications: () => 0,
}));

function render(collapsed: boolean) {
  return renderToStaticMarkup(
    <Sidebar collapsed={collapsed} onToggleCollapse={vi.fn()} />,
  );
}

describe("preference storage (5/6)", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage);
  });

  it("1. starts expanded by default (missing/corrupt/anonymous)", () => {
    expect(loadSidebarCollapsed("acct-1")).toBe(false);
    expect(loadSidebarCollapsed(null)).toBe(false);
    store.set(sidebarCollapsedStorageKey("acct-1"), "banana");
    expect(loadSidebarCollapsed("acct-1")).toBe(false);
  });

  it("persists per account and clears back to default on expand", () => {
    expect(sidebarCollapsedStorageKey("acct-1")).toBe(
      "wacrm:sidebar-collapsed:v1:acct-1",
    );
    saveSidebarCollapsed("acct-1", true);
    expect(loadSidebarCollapsed("acct-1")).toBe(true);
    expect(loadSidebarCollapsed("acct-2")).toBe(false);
    saveSidebarCollapsed("acct-1", false);
    expect(store.has(sidebarCollapsedStorageKey("acct-1"))).toBe(false);
    expect(loadSidebarCollapsed("acct-1")).toBe(false);
  });
});

describe("2/3. collapse to rail, expand back", () => {
  it("expanded renders the full sidebar", () => {
    const html = render(false);
    expect(html).toContain("lg:w-60");
    expect(html).not.toContain("lg:w-16");
    expect(html).not.toContain('data-slot="tooltip-trigger"');
    expect(html).toContain('aria-label="Collapse sidebar"');
  });

  it("collapsed renders the icon rail", () => {
    const html = render(true);
    expect(html).toContain("lg:w-16");
    expect(html).not.toContain("lg:w-60");
    // Labels hide via CSS only on lg (drawer unaffected).
    expect(html).toContain("lg:hidden");
    expect(html).toContain('aria-label="Expand sidebar"');
    // Smooth width transition retained.
    expect(html).toContain("transition-[transform,width]");
  });
});

describe("4/15. content adjusts with no page offsets or overflow", () => {
  it("shell keeps the flex row (content flexes automatically)", () => {
    expect(shellSrc).toContain("flex h-screen overflow-hidden");
    expect(shellSrc).toContain("flex-1");
    expect(sidebarSrc).toContain("lg:relative");
    expect(sidebarSrc).not.toMatch(/ml-\[|ml-60|pl-\[.*sidebar/i);
  });
});

describe("5. preference survives navigation (shell-owned state)", () => {
  it("shell owns collapse state and hands it to the sidebar", () => {
    expect(shellSrc).toContain("useSidebarCollapsed(accountId)");
    expect(shellSrc).toContain("onToggleCollapse={toggleCollapse}");
    expect(shellSrc).toContain("collapsed={collapsed}");
    // Sidebar itself keeps no collapse state (drawer state excepted).
    expect(sidebarSrc).not.toContain("setCollapsed");
    expect(sidebarSrc).not.toContain("isCollapsed");
  });
});

describe("7. active navigation stays highlighted", () => {
  it("marks the active route in both states", () => {
    h.pathname = "/inbox";
    for (const collapsed of [false, true]) {
      const html = render(collapsed);
      expect(html).toContain('aria-current="page"');
      expect(html).toContain("bg-primary/10");
    }
  });
});

describe("8/9. tooltips, keyboard, toggle control", () => {
  it("collapsed icons get right-side tooltips on focusable links", () => {
    const html = render(true);
    const triggers =
      html.split('data-slot="tooltip-trigger"').length - 1;
    // Every nav row + travel card exposes a trigger.
    expect(triggers).toBeGreaterThanOrEqual(10);
    expect(sidebarSrc).toContain('side="right"');
    // Triggers render the links themselves (keyboard-focusable).
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('href="/workspace"');
  });

  it("toggle is a labeled button with expanded state", () => {
    expect(sidebarSrc).toContain("aria-expanded={!collapsed}");
    expect(sidebarSrc).toContain("ChevronRight");
    expect(sidebarSrc).toContain("ChevronLeft");
    expect(sidebarSrc).not.toContain("PanelLeftOpen");
    expect(sidebarSrc).not.toContain("PanelLeftClose");
    expect(sidebarSrc).toContain("focus-visible:ring-2");
  });

  it("toggle lives in the header beside the branding, not on the sidebar edge", () => {
    const headerRow = sidebarSrc
      .split("Header row")[1]
      .split("Main navigation")[0];
    // The header carries the collapse/expand control (beside brand).
    expect(headerRow).toContain("onToggleCollapse");
    expect(headerRow).toContain("Collapse sidebar");
    expect(headerRow).toContain("Expand sidebar");
    // Small subtle chevron button, vertically centered in the header.
    expect(headerRow).toContain("rounded-md");
    expect(headerRow).toContain("items-center");
    expect(headerRow).toContain("focus-visible:ring-2");
    // The old hover-edge control is gone.
    expect(sidebarSrc).not.toContain("group/edge");
    expect(sidebarSrc).not.toContain("-right-2");
    expect(sidebarSrc).not.toContain("top-1/2");
    // Exactly one toggle control — no duplicate.
    const toggles =
      sidebarSrc.split(
        'aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}',
      ).length - 1;
    expect(toggles).toBe(1);
  });
});

describe("10. Google Sheets navigation unchanged", () => {
  it("keeps routes, order, and single instances in both states", () => {
    // Default group state is collapsed: expanded hides both sheets
    // children on a non-sheets route (existing behavior); the
    // collapsed rail forces the icons visible instead.
    const expanded = render(false);
    expect(expanded).not.toContain('href="/chat-assignment"');
    expect(expanded).not.toContain('href="/data-export"');
    expect(expanded).not.toContain('href="/all-sheets"');
    const collapsed = render(true);
    expect(collapsed).toContain('href="/data-export"');
    expect(collapsed).toContain('href="/all-sheets"');
    expect(collapsed).not.toContain('href="/chat-assignment"');
    // Lead Assignment stays visible while Chat Assignment is hidden.
    expect(collapsed).toContain('href="/lead-assignment"');
    // No duplicates even with the group header inline.
    expect(collapsed.split("Flow Sheets").length - 1).toBe(1);
    expect(collapsed.split("All Sheets").length - 1).toBe(1);
    expect(sidebarSrc).toContain("GOOGLE SHEETS");
  });
});

describe("11. Travel Agency CRM in both states", () => {
  it("keeps destination/target with icon-only collapsed form", () => {
    // next/image rewrites src to an optimized URL — match the asset.
    for (const collapsed of [false, true]) {
      const html = render(collapsed);
      expect(html).toContain("travel-agency-crm.png");
      expect(html).toContain('target="_blank"');
      expect(html).toContain("Travel Agency CRM");
    }
    const collapsedHtml = render(true);
    expect(collapsedHtml).toContain("lg:hidden");
  });
});

describe("12/13/14. workspace, inbox, mobile intact", () => {
  it("mobile drawer is untouched by collapse", () => {
    const html = render(true);
    // Full drawer width + slide transform retained.
    expect(html).toContain("w-64");
    expect(html).toContain("-translate-x-full");
    // Desktop stays in the flex row (relative without offsets lays
    // out exactly like static) and anchors the edge control.
    expect(html).toContain("lg:relative");
    expect(html).not.toContain("lg:fixed");
    // Collapse hides via lg: only — never bare `hidden` on labels.
    expect(sidebarSrc).not.toMatch(/className="hidden"/);
  });

  it("logo uses /logo.png in both states", () => {
    for (const collapsed of [false, true]) {
      expect(render(collapsed)).toContain("logo.png");
    }
  });
});

describe("agent Workspace access (no Flow Tables, no admin areas)", () => {
  it("agents see Workspace but nothing owner/admin-only", () => {
    h.accountRole = "agent";
    h.canEditSettings = false;
    try {
      const html = render(false);
      expect(html).toContain('href="/workspace"');
      for (const href of [
        'href="/flows"',
        'href="/agents"',
        'href="/data-export"',
        'href="/chat-assignment"',
        'href="/lead-assignment"',
      ]) {
        expect(html).not.toContain(href);
      }
    } finally {
      h.accountRole = "owner";
      h.canEditSettings = true;
    }
  });
});
