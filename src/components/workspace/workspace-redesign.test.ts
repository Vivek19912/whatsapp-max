// Workspace redesign pins — layout, density, and shared chrome.
//
// Source assertions (the page is too heavy to render here, following
// the columns-menu test pattern). Pins the redesign contract:
// compact header, one-row toolbar with mobile overflow, a uniform
// h-9 control row with removable filter chips, dense sticky grid
// headers, and one shared dialog shell for every table
// configuration surface.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("workspace redesign — shared tokens and shell", () => {
  it("defines one set of control heights, spacing, and dialog widths", () => {
    const tokens = src("src/components/workspace/workspace-tokens.ts");
    expect(tokens).toContain("WS_CONTROL_HEIGHT");
    expect(tokens).toContain("WS_CONTROL_BUTTON");
    expect(tokens).toContain("WS_DIALOG_WIDTH");
    expect(tokens).toContain('md: "sm:max-w-lg"');
    expect(tokens).toContain('lg: "sm:max-w-2xl"');
    expect(tokens).toContain('xl: "sm:max-w-3xl lg:max-w-4xl"');
    // TheASSIGNMENT dialog uses the widest preset...
    expect(src("src/components/workspace/table-assignment-dialog.tsx")).toContain(
      'width="xl"'
    );
    // ...sheets and WhatsApp use the large preset, Travel CRM medium.
    expect(src("src/components/workspace/meta-table-sheets-dialog.tsx")).toContain(
      'width="lg"'
    );
    expect(src("src/components/workspace/meta-table-whatsapp-dialog.tsx")).toContain(
      'width="lg"'
    );
    expect(src("src/components/workspace/travel-crm-settings.tsx")).toContain(
      'width="md"'
    );
  });

  it("config shell keeps header/footer visible with a scrolling body", () => {
    const shell = src("src/components/workspace/config-dialog.tsx");
    expect(shell).toContain("max-h-[92vh]");
    expect(shell).toContain("overflow-y-auto");
    expect(shell).toContain("sticky");
    expect(shell).toContain("DialogFooter");
    expect(shell).toContain("saveLabel");
    expect(shell).toContain("Cancel");
  });

  it("no dialog invents its own width or footer anymore", () => {
    for (const file of [
      "src/components/workspace/meta-table-sheets-dialog.tsx",
      "src/components/workspace/meta-table-whatsapp-dialog.tsx",
      "src/components/workspace/table-assignment-dialog.tsx",
      "src/components/workspace/travel-crm-settings.tsx",
    ]) {
      const s = src(file);
      expect(s).toContain("ConfigDialog");
      expect(s).not.toContain("DialogContent");
      expect(s).not.toContain("max-h-[90vh]");
      expect(s).not.toContain("max-h-[85vh]");
    }
  });
});

describe("workspace redesign — header and toolbar", () => {
  it("renders a compact title row with a table-kind badge", () => {
    const header = src("src/components/workspace/workspace-header.tsx");
    expect(header).toContain("text-xl font-semibold");
    expect(header).toContain("kindLabel");
    expect(header).toContain("Meta Lead Ads");
    expect(header).toContain("Flow");
  });

  it("keeps primary actions inline on desktop and behind More on mobile", () => {
    const header = src("src/components/workspace/workspace-header.tsx");
    expect(header).toContain("hidden");
    expect(header).toContain("sm:flex");
    expect(header).toContain("sm:hidden");
    expect(header).toContain("More actions");
    expect(header).toContain("DropdownMenu");
    expect(header).toContain('aria-label="Select flow"');
    expect(header).toContain("placeholder");
  });

  it("selector filters long table lists by typing", () => {
    const header = src("src/components/workspace/workspace-header.tsx");
    expect(header).toContain('placeholder="Search tables');
    expect(header).toContain("No tables match");
  });
});

describe("workspace redesign — controls row and filters", () => {
  it("uses one h-9 control height across search, filters, columns, and actions", () => {
    const page = src("src/app/(dashboard)/workspace/page.tsx");
    expect(page).toContain("WorkspaceSearchField");
    expect(page).toContain("flex flex-wrap items-center gap-2");
    const filters = src("src/components/workspace/workspace-filters.tsx");
    expect(filters).toContain("WS_CONTROL_BUTTON");
    const columns = src("src/components/workspace/columns-menu.tsx");
    expect(columns).toContain("h-9");
  });

  it("surfaces removable filter chips above the grid", () => {
    const page = src("src/app/(dashboard)/workspace/page.tsx");
    expect(page).toContain("ActiveFilterChips");
    expect(page).toContain("onClearDate");
    expect(page).toContain("onClearAssignee");
    expect(page).toContain("onClearColumn");
    const filters = src("src/components/workspace/workspace-filters.tsx");
    expect(filters).toContain("aria-label=\"Active filters\"");
    expect(filters).toContain("Clear all");
  });

  it("keeps every filter semantic: server-side, AND across sections", () => {
    const filters = src("src/components/workspace/workspace-filters.tsx");
    // Same funnel, same resolvers — only the panel chrome changed.
    expect(filters).toContain("resolveWorkspaceDateRange");
    expect(filters).toContain("resolveCallsTriedFilter");
    expect(filters).toContain("resolveColumnDateFilter");
    expect(filters).toContain("resolveFollowUpFilter");
    expect(filters).toContain("handleApply");
    expect(filters).toContain("handleClearAll");
  });
});

describe("workspace redesign — dense sticky grid", () => {
  it("shrinks header height and keeps sticky positioning", () => {
    const page = src("src/app/(dashboard)/workspace/page.tsx");
    expect(page).toContain("sticky top-0 z-20");
    expect(page).toContain("h-11");
    expect(page).not.toContain("h-16 truncate");
    expect(page).toContain("[&_tr]:border-b-0");
  });

  it("compacts body cells without touching truncation or selection", () => {
    const page = src("src/app/(dashboard)/workspace/page.tsx");
    expect(page).toContain("px-2.5 py-1.5");
    expect(page).toContain("max-w-56 truncate");
    expect(page).toContain("workspace-table-viewport");
    // Row selection, pinning, and dial actions are untouched.
    expect(page).toContain("setSelected(row)");
    expect(page).toContain("RowActionsMenu");
    expect(page).toContain("DialAction");
  });
});

describe("workspace redesign — assignment dialog structure", () => {
  it("uses radio cards for distribution and a searchable timezone", () => {
    const dialog = src("src/components/workspace/table-assignment-dialog.tsx");
    expect(dialog).toContain("RadioGroup");
    expect(dialog).toContain('value="round_robin"');
    expect(dialog).toContain('value="percentage"');
    expect(dialog).toContain("SearchableSelect");
    expect(dialog).toContain("Asia/Kolkata");
  });

  it("shows assignees as a table on desktop and cards on mobile", () => {
    const dialog = src("src/components/workspace/table-assignment-dialog.tsx");
    expect(dialog).toContain("hidden overflow-x-auto rounded-lg border border-border md:block");
    expect(dialog).toContain("md:hidden");
  });

  it("collapses delivery history and keeps the footer visible", () => {
    const dialog = src("src/components/workspace/table-assignment-dialog.tsx");
    expect(dialog).toContain("Accordion");
    expect(dialog).toContain("Recent alert deliveries");
    expect(dialog).toContain("ConfigFooterActions");
    expect(dialog).toContain('saveLabel="Save Assignment Settings"');
  });
});

describe("workspace redesign — Travel CRM parity", () => {
  it("shares the dialog shell with sections for defaults and itineraries", () => {
    const dialog = src("src/components/workspace/travel-crm-settings.tsx");
    expect(dialog).toContain("ConfigDialog");
    expect(dialog).toContain("ConfigSection");
    expect(dialog).toContain("ConfigFooterActions");
    expect(dialog).toContain("Travel CRM Defaults");
    expect(dialog).toContain("Itinerary Defaults");
    // Validation, API contract, and empty states are untouched.
    expect(dialog).toContain("Each itinerary row needs a destination and nights");
    expect(dialog).toContain("validateNightsInput");
  });
});
