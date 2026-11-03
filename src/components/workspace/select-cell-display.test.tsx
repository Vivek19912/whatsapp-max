import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CustomCell } from "./custom-cell";
import { filterCellOptions, OPTION_SEARCH_THRESHOLD } from "./custom-cell";
import type { WorkspaceField } from "@/lib/flows/workspace-fields";

// ---------------------------------------------------------------------------
// Chevron-less select cells — one shared trigger style for every
// Workspace select field. SSR covers trigger markup (closed popups
// stay unmounted); pure helpers cover search filtering; source
// patterns cover wiring that needs interaction (open/save/keys),
// which Base UI continues to own unchanged.
// ---------------------------------------------------------------------------

const root = process.cwd();
const cellSrc = readFileSync(
  `${root}/src/components/workspace/custom-cell.tsx`,
  "utf8",
);
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

function field(partial?: Partial<WorkspaceField>): WorkspaceField {
  return {
    id: "field-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Lead Type",
    field_type: "single_select",
    position: 3,
    options: ["Fresh", "Hot", "Warm", "Cold", "Prospect"],
    default_value: null,
    currency_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function renderCell(f: WorkspaceField, stored: string | null) {
  return renderToStaticMarkup(
    <CustomCell
      flowId="flow-1"
      runId="run-1"
      field={f}
      stored={stored}
      canEdit
      onSaved={vi.fn()}
      members={[]}
    />,
  );
}

const STAGE_OPTIONS = [
  "New Lead",
  "Contacted",
  "Qualified",
  "Quotation Required",
  "Quotation Sent",
  "In Negotiation",
  "Ready To Book",
  "Booking Confirmed",
  "Follow Up",
  "Amendment",
  "Lost",
  "Cancelled",
  "Invalid",
  "On Hold",
  "Not connected",
];

describe("1–5. selected and empty cells show no visible arrow", () => {
  it.each([
    ["Type", field({ name: "Lead Type" }), "Fresh"],
    [
      "Stage",
      field({ name: "Stage", options: STAGE_OPTIONS }),
      "New Lead",
    ],
    [
      "Received",
      field({ name: "Lead Received", options: ["Website", "Facebook Ads"] }),
      "Facebook Ads",
    ],
    ["empty Type", field({ name: "Lead Type" }), null],
  ])("%s displays with the chevron hidden", (_label, f, stored) => {
    const html = renderCell(f, stored as string | null);
    expect(html).toContain("[&amp;_svg]:hidden");
    if (stored) expect(html).toContain(stored as string);
  });

  it("Assigned To displays with the chevron hidden", () => {
    const html = renderCell(
      field({ name: "Assigned To", options: ["Unassigned"] }),
      "Unassigned",
    );
    expect(html).toContain("[&amp;_svg]:hidden");
    expect(html).toContain("Unassigned");
  });

  it("both select branches share one trigger style (no one-off fixes)", () => {
    const uses = cellSrc.split("SELECT_CELL_TRIGGER_CLASS").length - 1;
    // Definition + assignee trigger + single-select trigger.
    expect(uses).toBe(3);
  });
});

describe("6+7. the whole cell opens the existing dropdown", () => {
  it("chip and empty space share a single full-cell trigger", () => {
    for (const stored of ["Hot", null]) {
      const html = renderCell(field(), stored);
      // Exactly one opener per cell: the full-width trigger. No
      // separate arrow button to hunt for.
      const buttons = html.split("<button").length - 1;
      expect(buttons).toBe(1);
      expect(html).toContain("w-full");
    }
  });

  it("trigger keeps keyboard focusability and the save wiring", () => {
    expect(cellSrc).toContain("focus-visible:ring-2");
    expect(cellSrc).toContain("onValueChange={(v) => save(");
  });
});

describe("8. options remain unchanged (search only filters display)", () => {
  it("filter matches labels and values case-insensitively", () => {
    const options = [
      { value: "NEW_LEAD", label: "New Lead" },
      { value: "CONTACTED", label: "Contacted" },
    ];
    expect(filterCellOptions(options, "")).toEqual(options);
    expect(filterCellOptions(options, "new")).toEqual([options[0]]);
    expect(filterCellOptions(options, "CONTACTED")).toEqual([options[1]]);
    expect(filterCellOptions(options, "zzz")).toEqual([]);
  });

  it("filtering never touches stored values (pure, new array)", () => {
    const options = [{ value: "a", label: "A" }];
    const out = filterCellOptions(options, "zzz");
    expect(out).toEqual([]);
    expect(options).toHaveLength(1);
  });

  it("search appears only past the threshold; Clear stays pinned first", () => {
    expect(OPTION_SEARCH_THRESHOLD).toBe(8);
    expect(cellSrc).toContain("fieldOptions.length > OPTION_SEARCH_THRESHOLD");
    // Clear renders before the search box in both dropdowns.
    const clearIdx = cellSrc.indexOf('<span className="text-muted-foreground">Clear</span>');
    const searchIdx = cellSrc.indexOf("<OptionSearchBox");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(clearIdx);
    // The query resets on close so the next open starts unfiltered.
    expect(cellSrc).toContain('if (!o) setOptionQuery("");');
  });
});

describe("9+10+16. values still change, Clear still works, saves intact", () => {
  it("selection and clear map to the existing save path", () => {
    expect(cellSrc).toContain('save(v === "__clear__" ? null : v)');
    expect(cellSrc).toContain("save(v === ASSIGNED_TO_CLEAR_SENTINEL ? null : v)");
    expect(cellSrc).toContain("/api/flows/${flowId}/workspace-values");
  });
});

describe("11+12. keyboard behavior stays with the dropdown", () => {
  it("selects remain uncontrolled (native open/Enter/Space/Escape)", () => {
    // No controlled open state introduced — Base UI keeps owning
    // focus, type-ahead, Enter/Space to open, and Escape to close.
    expect(cellSrc).not.toContain("open={optionQuery");
    expect(cellSrc).not.toMatch(/<Select[^>]*open=\{/);
  });
});

describe("13+14+15. chips and business defaults unchanged", () => {
  it("saved Hot keeps its chip styling", () => {
    const html = renderCell(field(), "Hot");
    expect(html).toContain("Hot");
    expect(html).toContain("background-color");
  });

  it("empty Type preselects Fresh, empty Stage preselects New Lead", () => {
    // Display-level defaults (read-only fallback); selects still
    // offer every option and Clear.
    const typeHtml = renderCell(field(), null);
    expect(typeHtml).toContain("Fresh");
    const stageHtml = renderCell(
      field({ name: "Stage", options: STAGE_OPTIONS }),
      null,
    );
    expect(stageHtml).toContain("New Lead");
  });
});

describe("17+18. text and date fields are unaffected", () => {
  it("text cells use the popover editor, never a combobox", () => {
    const html = renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={field({ name: "Customer Response", field_type: "text", options: null })}
        stored="hello"
        canEdit
        onSaved={vi.fn()}
        members={[]}
      />,
    );
    expect(html).toContain("popover-trigger");
    expect(html).not.toContain('role="combobox"');
  });

  it("date cells keep their inline editor, never a combobox", () => {
    const html = renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={field({ name: "When", field_type: "date", options: null })}
        stored={null}
        canEdit
        onSaved={vi.fn()}
        members={[]}
      />,
    );
    expect(html).not.toContain("popover-trigger");
    expect(html).not.toContain('role="combobox"');
  });
});

describe("19. column wiring unchanged", () => {
  it("the table still renders CustomCell for business fields", () => {
    expect(pageSrc).toContain("<CustomCell");
  });
});
