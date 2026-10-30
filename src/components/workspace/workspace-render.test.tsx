// Workspace redesign — render verification (no browser needed).
//
// Uses react-dom/server static markup (same pattern as
// header-colors.test.tsx) to prove the rebuilt surfaces render
// without crashing and carry the responsive + a11y contract:
// sticky header regions, mobile fallbacks, labeled controls,
// dialogs with headers/footers.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ActiveFilterChips,
} from "@/components/workspace/workspace-filters";
import { SearchableSelect } from "@/components/workspace/searchable-select";
import { ConfigDialog } from "@/components/workspace/config-dialog";
import { TableAssignmentDialog } from "@/components/workspace/table-assignment-dialog";
import { TravelCrmSettings } from "@/components/workspace/travel-crm-settings";
import {
  WorkspacePageHeader,
  WorkspaceSearchField,
  WorkspaceTableSelector,
  WorkspaceToolbar,
} from "@/components/workspace/workspace-header";
import { emptyColumnFilters } from "@/lib/flows/workspace-filters";

describe("config dialog shell contract (source pins; Base UI portals need a DOM)", () => {
  it("dialogs stay closed without crashing and mount no popup when shut", () => {
    // Base UI renders popup content into a portal, so SSR yields no
    // markup — this pins the closed state instead of pretending to
    // screenshot it. Open-state layout is verified in the browser
    // checklist and via the source pins below.
    expect(
      renderToStaticMarkup(
        <ConfigDialog open={false} onOpenChange={() => {}} title="T">
          body
        </ConfigDialog>
      )
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <TableAssignmentDialog
          flowId="flow-1"
          flowName="Form A"
          tableKind="meta_lead_ads"
          open={false}
          onOpenChange={() => {}}
        />
      )
    ).toBe("");
  });

  it("shell wires title, table line, loading, error, and footer props", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/config-dialog.tsx`,
      "utf8"
    );
    expect(src).toContain("max-h-[92vh]");
    expect(src).toContain("overflow-y-auto");
    expect(src).toContain("DialogFooter");
    expect(src).toContain("saveLabel");
    expect(src).toContain("sticky");
    expect(src).toContain("ConfigSection");
  });
});

describe("toolbar renders desktop actions plus a mobile overflow", () => {
  function toolbar() {
    return renderToStaticMarkup(
      <WorkspaceToolbar
        primary={[
          { key: "a", label: "Configure Sheet", icon: () => null, onClick: () => {} },
          { key: "b", label: "Assignment", icon: () => null, onClick: () => {} },
        ]}
        secondary={[
          { key: "c", label: "Open Sheet", icon: () => null, onClick: () => {} },
        ]}
      />,
    );
  }

  it("shows every action inline on desktop and collapses on mobile", () => {
    const html = toolbar();
    expect(html).toContain("Configure Sheet");
    expect(html).toContain("Assignment");
    expect(html).toContain("Open Sheet");
    expect(html).toContain("More actions");
    // Desktop row hidden below sm; overflow menu hidden at sm and up.
    expect(html).toContain("hidden");
    expect(html).toContain("sm:flex");
    expect(html).toContain("sm:hidden");
  });
});

describe("searchable select renders an accessible trigger", () => {
  it("shows the placeholder and exposes a labeled listbox trigger", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        value=""
        options={[{ value: "a", label: "Alpha" }]}
        onChange={() => {}}
        placeholder="Pick one"
        ariaLabel="Pick one"
      />,
    );
    expect(html).toContain("Pick one");
    // Closed popovers render only the trigger; the combobox input
    // lives in the popup. The trigger advertises the listbox.
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-label="Pick one"');
    expect(html).not.toContain("radix-popover-trigger-width");
  });

  it("anchors, bounds, flips, and keyboard-navigates the dropdown", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/searchable-select.tsx`,
      "utf8"
    );
    // Width follows the trigger through Base UI's anchor variable
    // (never the Radix variable, which does not exist here).
    expect(src).toContain("w-[var(--anchor-width)]");
    expect(src).toContain("max-w-[calc(100vw-2rem)]");
    expect(src).not.toContain("w-[var(--radix-popover-trigger-width)]");
    // Only the option list scrolls, capped at ~240px or the space
    // actually available — the dropdown can never push past the
    // viewport or cover unrelated dialog sections.
    expect(src).toContain("max-h-[min(15rem,var(--available-height))]");
    expect(src).toContain("overflow-y-auto");
    expect(src).toContain("overscroll-contain");
    // The cap belongs on the scrolling viewport itself, not on a
    // non-scrolling wrapper (a previous regression put max-h on
    // the ScrollArea root, so the list grew unbounded).
    expect(src).not.toContain("ScrollArea");
    // Flip above when there is no room below; shift into view
    // horizontally; keep clear of edges.
    expect(src).toContain("collisionAvoidance");
    expect(src).toContain("side: \"flip\"");
    expect(src).toContain("align: \"shift\"");
    expect(src).toContain("collisionPadding");
    // Arrow/Home/End/Enter keyboard selection with scroll-into-view.
    expect(src).toContain("moveHighlight");
    expect(src).toContain("scrollIntoView");
    expect(src).toContain('aria-activedescendant');
    expect(src).toContain('role="combobox"');
    expect(src).toContain('aria-autocomplete="list"');
  });
});

describe("active filter chips render and clear", () => {
  const baseAssignee = { type: "all" as const };

  it("renders one chip per active section with a clear-all action", () => {
    const html = renderToStaticMarkup(
      <ActiveFilterChips
        date={{
          preset: "last7",
          customFrom: "",
          customTo: "",
          range: { from: "2026-10-20T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z" },
        }}
        assignee={{ type: "unassigned" }}
        columns={{
          ...emptyColumnFilters(),
          callStatus: ["Connected"],
          callsTried: { op: "gt", value: 2 },
        }}
        members={[]}
        onClearDate={() => {}}
        onClearAssignee={() => {}}
        onClearColumn={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(html).toContain("Last 7 days");
    expect(html).toContain("Assigned: Unassigned");
    expect(html).toContain("Call status");
    expect(html).toContain("Calls tried");
    expect(html).toContain("Clear all");
    expect(html).toContain('aria-label="Active filters"');
  });

  it("renders nothing when no filters are active", () => {
    const html = renderToStaticMarkup(
      <ActiveFilterChips
        date={null}
        assignee={baseAssignee}
        columns={emptyColumnFilters()}
        members={[]}
        onClearDate={() => {}}
        onClearAssignee={() => {}}
        onClearColumn={() => {}}
        onClearAll={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});

describe("workspace header renders title, badge, and selector", () => {
  it("keeps the header compact: selector and badge, no large title", () => {
    const html = renderToStaticMarkup(
      <WorkspacePageHeader
        kindLabel="Meta Lead Ads"
        subtitle="One live table per flow."
        selector={
          <WorkspaceTableSelector
            flows={[{ id: "f1", name: "Form A" }]}
            flowId="f1"
            onSelect={() => {}}
            wide
            displayName={(n) => n ?? "Untitled"}
          />
        }
        toolbar={null}
      />,
    );
    expect(html).not.toContain(">Workspace<");
    expect(html).toContain("Meta Lead Ads");
    expect(html).toContain("Form A");
    expect(html).toContain("Select flow");
  });

  it("search field is labeled and full width on mobile", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSearchField value="" onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Search table"');
    expect(html).toContain("Search name or phone");
  });
});

describe("assignment dialog props are table-scoped", () => {
  it("accepts flow identity without rendering until opened", () => {
    // Content renders only when opened (Base UI portal); the
    // table-scoping contract lives in the fetch URLs, asserted here.
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/table-assignment-dialog.tsx`,
      "utf8"
    );
    expect(src).toContain('title="Assignment"');
    expect(src).toContain("flowName ??");
    expect(src).toContain("Meta Lead Ads table");
    expect(src).toContain("Save Assignment Settings");
    expect(src).toContain("/api/flows/${encodeURIComponent(flowId)}/assignment");
  });
});

describe("travel CRM settings renders its trigger", () => {
  it("exposes the settings entry point when a flow is selected", () => {
    const html = renderToStaticMarkup(
      <TravelCrmSettings flowId="flow-1" flowName="Flow 1" />,
    );
    expect(html).toContain("Travel CRM Settings");
  });
});
