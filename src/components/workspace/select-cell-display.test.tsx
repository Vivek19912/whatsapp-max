import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CustomCell } from "./custom-cell";
import {
  CRM_TABLE_LOCKED_MESSAGE,
  filterCellOptions,
  leadQualityDeliveryLabel,
  OPTION_SEARCH_THRESHOLD,
} from "./custom-cell";
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
    // Definition + assignee trigger + single-select trigger +
    // Lead Quality trigger (badges reuse the same shared style).
    expect(uses).toBe(4);
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

describe("8. options remain unchanged (search only filters display)", () => {  it("filter matches labels and values case-insensitively", () => {
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

function leadQualityField(): WorkspaceField {
  return {
    id: "f-quality",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Lead Quality",
    field_type: "single_select",
    position: 3,
    options: ["Lead", "Interested Lead", "Qualified Lead", "Booking Confirmed", "Junk"],
    default_value: "Lead",
    currency_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function renderQualityCell(stored: string | null, crmAllowedFlowIds?: string[] | null) {
  return renderToStaticMarkup(
    <CustomCell
      flowId="flow-1"
      runId="run-1"
      field={leadQualityField()}
      stored={stored}
      canEdit
      onSaved={vi.fn()}
      members={[]}
      crmAllowedFlowIds={crmAllowedFlowIds}
    />,
  );
}

describe("21. Lead Quality read-only for unselected CRM tables", () => {
  it("locks the dropdown when the originating table is not selected", () => {
    const html = renderQualityCell("Qualified Lead", ["flow-other"]);
    // Badge stays visible with the saved value...
    expect(html).toContain("Qualified Lead");
    // ...plus the lock affordance and the exact read-only message...
    expect(html).toContain('aria-label="Qualified Lead. ' + CRM_TABLE_LOCKED_MESSAGE + '"');
    expect(html).toContain(`title="${CRM_TABLE_LOCKED_MESSAGE}"`);
    // ...and no interactive trigger that could open or save.
    expect(html).not.toContain("<button");
    expect(html).not.toContain('role="combobox"');
  });

  it("stays editable for selected tables, and when no selection exists", () => {
    for (const allowlist of [["flow-1"], null, undefined] as Array<string[] | null | undefined>) {
      const html = renderToStaticMarkup(
        <CustomCell
          flowId="flow-1"
          runId="run-1"
          field={leadQualityField()}
          stored="Qualified Lead"
          canEdit
          onSaved={vi.fn()}
          members={[]}
          crmAllowedFlowIds={allowlist}
        />,
      );
      // Editable dropdown trigger renders (opens on click)...
      expect(html).toContain("<button");
      // ...with no lock messaging.
      expect(html).not.toContain(CRM_TABLE_LOCKED_MESSAGE);
    }
  });

  it("locked cells expose no save path in the rendered output", () => {
    const html = renderQualityCell("Qualified Lead", []);
    expect(html).not.toContain("triggerCrmEvent");
    expect(html).not.toContain("__clear__");
  });

  it("derives locked state per row from the originating flow id", () => {
    // The view threads each row's own flow id (All Meta Leads rows
    // carry different origins) plus the shared allowlist.
    const viewSrc = readFileSync(
      `${root}/src/components/workspace/all-meta-leads-view.tsx`,
      "utf8",
    );
    expect(viewSrc).toContain("crmAllowedFlowIds");
    expect(viewSrc).toContain("flowId={row.flowId}");
    // Lock rule mirrors the backend allowlist semantics: only an
    // explicit list can lock; null/omitted stays editable.
    expect(cellSrc).toContain("crmAllowedFlowIds != null");
    expect(cellSrc).toContain("!crmAllowedFlowIds.includes(flowId)");
  });

  it("page fetches the CRM table selection once and threads it to both views", () => {
    expect(pageSrc).toContain("/api/integrations/meta-crm/config");
    expect(pageSrc).toContain("crmAllowedFlowIds");
    // Individual tables use their own flow id; All Meta Leads uses
    // each row's originating flow id (never the virtual id).
    expect(pageSrc).toContain("crmAllowedFlowIds={crmAllowedFlowIds}");
  });
});

describe("20. Lead Quality delivery badges", () => {
  it("labels recorded states honestly and never claims Sent prematurely", () => {
    expect(leadQualityDeliveryLabel("sent")).toBe("✓ Sent");
    expect(leadQualityDeliveryLabel("pending")).toBe("Queued");
    expect(leadQualityDeliveryLabel("failed")).toBe("Failed");
    expect(leadQualityDeliveryLabel("skipped")).toBe("Skipped");
    // Never-recorded (or unknown) states read as unsent.
    expect(leadQualityDeliveryLabel(undefined)).toBe("Not sent");
    expect(leadQualityDeliveryLabel("bogus")).toBe("Not sent");
  });

  it("sends the explicit-selection flag only from the Lead Quality dropdown", () => {
    // Only a real option pick flips the flag (never Clear, never the
    // assignee or generic single-select paths, which call save
    // without it).
    expect(cellSrc).toContain("onPick={(v) => save(v, { triggerCrmEvent: v !== null })}");
    expect(cellSrc).toContain("triggerCrmEvent === true");
  });

  it("Lead Quality dropdown never truncates: content-sized popup, wrapping options", () => {
    // The popup must not inherit the narrow column trigger width:
    // w-max sizes to the longest option, capped to the viewport.
    expect(cellSrc).toContain("w-max");
    expect(cellSrc).toContain("max-w-[min(22rem,calc(100vw-2rem))]");
    // Options (badge + delivery status) wrap instead of ellipsizing.
    expect(cellSrc).toContain("[&_[data-slot=select-item-text]]:whitespace-normal");
    expect(cellSrc).toContain("[&_[data-slot=select-item-text]]:break-words");
    expect(cellSrc).toContain("[&_[data-slot=select-item-text]]:flex-wrap");
  });
});
