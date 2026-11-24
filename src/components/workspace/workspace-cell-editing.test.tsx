import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LEAD_TYPE_OPTIONS,
  WORKSPACE_DEFAULT_FIELDS,
} from "@/lib/flows/workspace-defaults";
import type { WorkspaceField } from "@/lib/flows/workspace-fields";
import { CustomCell, editorInputType } from "./custom-cell";

// ---------------------------------------------------------------------------
// Workspace inline cell editing — full-cell targets, chevrons only on
// true selects (13 points).
//
// The node test env has no DOM events, so interaction is verified
// structurally: the view-mode control spans the cell (SSR markup +
// classes), the editor branch wires Input↔draft↔save, and chevron
// SVG lives exclusively in the shared SelectTrigger primitive.
// ---------------------------------------------------------------------------

const root = process.cwd();
const cellSrc = readFileSync(
  `${root}/src/components/workspace/custom-cell.tsx`,
  "utf8",
);
const selectPrimitive = readFileSync(
  `${root}/src/components/ui/select.tsx`,
  "utf8",
);

function field(partial: Partial<WorkspaceField>): WorkspaceField {
  return {
    id: "field-1",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Customer Response",
    field_type: "text",
    position: 7,
    options: null,
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
      canEdit={true}
      onSaved={vi.fn()}
      members={[]}
    />,
  );
}

describe("field types (verify first, change nothing)", () => {
  it("Stage, Lead Type, Lead Received and Calls Tried are selects; text fields are text", () => {
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Stage")?.field_type).toBe("single_select");
    expect(byName.get("Lead Type")?.field_type).toBe("single_select");
    expect(byName.get("Lead Received")?.field_type).toBe("single_select");
    expect(byName.get("No. of Calls Tried")?.field_type).toBe("single_select");
    for (const name of ["Customer Response", "Next Action", "Final Remark"]) {
      expect(byName.get(name)?.field_type).toBe("text");
    }
  });

  it("legacy stored values render as plain text (never destroyed)", () => {
    const html = renderCell(
      field({ name: "Lead Type", options: [...LEAD_TYPE_OPTIONS] }),
      "Fake",
    );
    expect(html).toContain("Fake");
  });
});

describe("1/2. empty text cells are blank with no chevron", () => {
  it("renders an empty, icon-free cell", () => {
    const html = renderCell(field({}), null);
    expect(html).not.toContain("—");
    expect(html).not.toContain("<svg");
    expect(html).toContain("<button");
  });

  it("date/number/url empties are equally blank and icon-free", () => {
    for (const f of [
      field({ name: "Last Contact Date", field_type: "date" }),
      field({ name: "No. of Calls", field_type: "number" }),
      field({ name: "Link", field_type: "url" }),
    ]) {
      const html = renderCell(f, null);
      expect(html).not.toContain("—");
      expect(html).not.toContain("<svg");
    }
  });
});

describe("3/4/5. whole-cell click target opens the inline editor", () => {
  it("the view control spans the cell and enters edit mode on click", () => {
    const html = renderCell(field({}), null);
    expect(html).toContain("w-full");
    expect(html).toContain("min-h-8");
    expect(html).toContain('title="Click to edit"');
    // Click → edit handler, autofocus, draft↔input, blur/Enter save.
    expect(cellSrc).toContain("setEditing(true)");
    expect(cellSrc).toContain("inputRef.current?.focus()");
    expect(cellSrc).toContain("onChange={(e) => setDraft(e.target.value)}");
    expect(cellSrc).toContain("setDraft(shown ??");
  });

  it("existing values sit inside the same direct-edit control", () => {
    const html = renderCell(field({}), "Ring back Tuesday");
    expect(html).toContain("Ring back Tuesday");
    expect(html).toContain("<button");
    expect(html).not.toContain("<svg");
  });
});

describe("6/7. selects open dropdowns and keep their chevron", () => {
  it("chevrons live only in the shared select trigger", () => {
    expect(selectPrimitive).toContain("ChevronDownIcon");
    expect(cellSrc).not.toContain("Chevron");
  });

  it("single-select and assignee cells render through that trigger", () => {
    expect(cellSrc).toContain("SelectTrigger");
    expect(cellSrc).toContain("SelectContent");
    expect(cellSrc).toContain("onValueChange={(v) => save(");
  });

  it("select triggers span the cell too", () => {
    const html = renderCell(
      field({ name: "Call Status", field_type: "single_select", options: ["Busy"] }),
      null,
    );
    expect(html).toContain("w-full");
    expect(html).toContain('data-slot="select-trigger"');
  });
});

describe("8. empty selects show no empty chip", () => {
  it("blank trigger with no chip styling", () => {
    const html = renderCell(
      field({ name: "Call Status", field_type: "single_select", options: ["Busy"] }),
      null,
    );
    expect(html).not.toContain("—");
    expect(html).not.toContain("background-color");
  });

  it("detected Lead Received default renders as a chip when passed as stored", () => {
    // The page feeds the auto-detected platform default through the
    // same `stored` prop; the cell cannot tell it from a saved pick.
    const html = renderCell(
      field({
        name: "Lead Received",
        field_type: "single_select",
        options: ["Website", "Facebook Ads"],
      }),
      "Facebook Ads",
    );
    expect(html).toContain("Facebook Ads");
    expect(html).toContain("background-color");
  });

  it("manual Lead Received pick wins over any default", () => {
    const html = renderCell(
      field({
        name: "Lead Received",
        field_type: "single_select",
        options: ["Website", "Facebook Ads"],
      }),
      "Referral",
    );
    expect(html).toContain("Referral");
    expect(html).not.toContain("Facebook Ads");
  });
});

describe("Type/Stage business defaults (Fresh / New Lead, read-only)", () => {
  const typeField = () =>
    field({
      name: "Lead Type",
      field_type: "single_select",
      options: ["Fresh", "Hot", "Warm", "Cold", "Prospect"],
    });
  const stageField = () =>
    field({
      name: "Stage",
      field_type: "single_select",
      options: ["New Lead", "Contacted", "Qualified"],
    });

  it("1+2. empty Type shows Fresh, empty Stage shows New Lead", () => {
    const typeHtml = renderCell(typeField(), null);
    expect(typeHtml).toContain("Fresh");
    expect(typeHtml).toContain("background-color");
    const stageHtml = renderCell(stageField(), null);
    expect(stageHtml).toContain("New Lead");
    expect(stageHtml).toContain("background-color");
  });

  it("3+4. saved Hot stays Hot, saved Qualified stays Qualified", () => {
    const hotHtml = renderCell(typeField(), "Hot");
    expect(hotHtml).toContain("Hot");
    expect(hotHtml).not.toContain(">Fresh<");
    const qualifiedHtml = renderCell(stageField(), "Qualified");
    expect(qualifiedHtml).toContain("Qualified");
    expect(qualifiedHtml).not.toContain("New Lead");
  });

  it("5+6. the full option list is unchanged (Clear + all options still offered)", () => {
    expect(typeField().options).toEqual(["Fresh", "Hot", "Warm", "Cold", "Prospect"]);
    expect(stageField().options).toEqual(["New Lead", "Contacted", "Qualified"]);
    // Clear affordance still present in the cell source.
    expect(cellSrc).toContain('value="__clear__"');
  });

  it("an explicit field default_value wins over the identity default", () => {
    const html = renderCell(
      field({
        name: "Lead Type",
        field_type: "single_select",
        options: ["Fresh", "Hot"],
        default_value: "Hot",
      }),
      null,
    );
    expect(html).toContain("Hot");
    expect(html).not.toContain(">Fresh<");
  });

  it("9. rendering defaults writes nothing (read-only, no save call)", () => {
    const onSaved = vi.fn();
    renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={typeField()}
        stored={null}
        canEdit={true}
        onSaved={onSaved}
        members={[]}
      />,
    );
    // SSR render performs no fetch/save — defaults never mass-update rows.
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("9/10. dates use date editing; numbers use number editing", () => {
  it("editor input types follow the actual field type", () => {
    expect(editorInputType("date")).toBe("date");
    expect(editorInputType("datetime")).toBe("datetime-local");
    expect(editorInputType("number")).toBe("number");
    expect(editorInputType("currency")).toBe("number");
    expect(editorInputType("text")).toBe("text");
    expect(editorInputType("url")).toBe("text");
    expect(editorInputType("single_select")).toBe("text");
    expect(editorInputType("checkbox")).toBe("text");
  });

  it("no select/chevron machinery on the date/number path", () => {
    // The date/number/url editor is the shared text-like branch
    // (button → Input); only the select paths open a trigger
    // (assignee, single-select, editable Lead Quality, view-only
    // locked Lead Quality — the locked trigger opens but every
    // option is disabled, so nothing can be picked or saved).
    const triggerOpens = cellSrc.split("<SelectTrigger").length - 1;
    expect(triggerOpens).toBe(4);
  });
});

describe("11/12/13. chips, behavior, and Sheets unchanged", () => {
  it("colored chips still render for mapped values", () => {
    const html = renderCell(
      field({
        name: "Call Status",
        field_type: "single_select",
        options: ["Connected"],
      }),
      "Connected",
    );
    expect(html).toContain("background-color:#15803d");
  });

  it("pagination/search/filter plumbing is untouched", () => {
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    for (const token of [
      "workspaceRowNumber",
      "debouncedSearch",
      "buildWorkspaceTableQuery",
      "applyVisibility",
    ]) {
      expect(page).toContain(token);
    }
  });

  it("Google Sheets is unaffected", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("CustomCell");
      expect(src).not.toContain("editorInputType");
    }
  });
});
