import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/font/google only resolves inside a Next.js build — stub the
// loader so importing the page module works under vitest.
vi.mock("next/font/google", () => ({
  DM_Sans: () => ({ className: "font-dm-sans-stub" }),
}));

import { cellText } from "@/app/(dashboard)/workspace/page";
import type { FlowTableColumn, FlowTableRow } from "@/lib/flows/flow-tables";
import {
  displayWorkspaceValue,
  type WorkspaceField,
} from "@/lib/flows/workspace-fields";
import { CustomCell } from "./custom-cell";

// ---------------------------------------------------------------------------
// Workspace Sheets-style grid — blank empties + cell borders (12 points).
//
// Display-only refinement: the data layer (stored values,
// validation, defaults) is untouched — emptiness still means
// null, it just PAINTS as blank. Grid lines reuse the table's
// border-collapse architecture (adjacent borders merge — no
// doubles) with the existing border token.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);
const cellSrc = readFileSync(
  `${root}/src/components/workspace/custom-cell.tsx`,
  "utf8",
);

function textField(partial?: Partial<WorkspaceField>): WorkspaceField {
  return {
    id: "field-text",
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

function singleField(name: string, options: string[]): WorkspaceField {
  return textField({ id: `field-${name}`, name, field_type: "single_select", options });
}

function baseRow(partial?: Partial<FlowTableRow>): FlowTableRow {
  return {
    runId: "run-1",
    contactId: "c-1",
    conversationId: null,
    name: null,
    phone: null,
    startedAt: "2026-09-18T10:00:00.000Z",
    lastAdvancedAt: null,
    completedAt: null,
    status: "completed",
    runStatus: "completed",
    answers: {},
    ...partial,
  };
}

function col(key: string): FlowTableColumn {
  return { key, label: key, system: key !== "Answer" };
}

describe("1. empty table cells render blank (no dash)", () => {
  it("cellText returns blank for missing name/phone/answers", () => {
    const row = baseRow();
    expect(cellText(row, col("name"))).toBe("");
    expect(cellText(row, col("phone"))).toBe("");
    expect(cellText(row, col("Answer"))).toBe("");
    expect(cellText(row, col("name"))).not.toContain("—");
  });

  it("cellText preserves present values byte-for-byte", () => {
    const row = baseRow({ name: "Rahul", phone: "+91111", answers: { Answer: "October" } });
    expect(cellText(row, col("name"))).toBe("Rahul");
    expect(cellText(row, col("phone"))).toBe("+91111");
    expect(cellText(row, col("Answer"))).toBe("October");
  });

  it("read-only custom cells render blank with no dash", () => {
    const noop = vi.fn();
    for (const field of [
      textField(),
      singleField("Call Status", ["Connected", "Busy"]),
      singleField("Assigned To", ["Unassigned"]),
      textField({ name: "Tags", field_type: "multi_select", options: ["A"] }),
    ]) {
      const html = renderToStaticMarkup(
        <CustomCell
          flowId="flow-1"
          runId="run-1"
          field={field}
          stored={null}
          canEdit={false}
          onSaved={noop}
          members={[]}
        />,
      );
      expect(html).not.toContain("—");
      expect(html).not.toContain(">-<");
    }
  });

  it("editable single-select triggers render blank with no dash", () => {
    const html = renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={singleField("Lead Quality", ["Hot", "Warm"])}
        stored={null}
        canEdit={true}
        onSaved={vi.fn()}
        members={[]}
      />,
    );
    expect(html).not.toContain("—");
  });

  it("dropdown behavior is unchanged (Clear + options still offered)", () => {
    expect(cellSrc).toContain('save(v === "__clear__" ? null : v)');
    expect(cellSrc).toContain("field.options");
  });
});

describe("Name vs WhatsApp Name value sources (column identity, not key text)", () => {
  function waRow(): FlowTableRow {
    return baseRow({
      name: "nikitajoshi464",
      phone: "918917378479",
      answers: { full_name: "Nikita Joshi", name: "Nikita Joshi" },
    });
  }

  it("flow Name cell shows the flow answer, never the contact name", () => {
    expect(
      cellText(waRow(), { key: "full_name", label: "Name", system: false }),
    ).toBe("Nikita Joshi");
  });

  it("WhatsApp Name cell shows the contact name, never the flow answer", () => {
    expect(
      cellText(waRow(), { key: "name", label: "WhatsApp Name", system: true }),
    ).toBe("nikitajoshi464");
  });

  it("a colliding var_key 'name' still resolves by identity", () => {
    const row = waRow();
    expect(
      cellText(row, { key: "name", label: "WhatsApp Name", system: true }),
    ).toBe("nikitajoshi464");
    expect(
      cellText(row, { key: "name", label: "Name", system: false }),
    ).toBe("Nikita Joshi");
  });

  it("Phone Number cell keeps the WhatsApp contact phone", () => {
    expect(
      cellText(
        baseRow({ phone: "+971501234567" }),
        { key: "phone", label: "Phone Number", system: true },
      ),
    ).toBe("+971501234567");
  });

  it("Indian Phone Number cell hides +91 (display-only)", () => {
    expect(
      cellText(
        baseRow({ phone: "919890431234" }),
        { key: "phone", label: "Phone Number", system: true },
      ),
    ).toBe("9890431234");
  });
});

describe("2. underlying empty/null values are unchanged", () => {
  it("the data layer still means null (blank is paint-only)", () => {
    expect(displayWorkspaceValue({ default_value: null }, null)).toBeNull();
    expect(displayWorkspaceValue({ default_value: null }, undefined)).toBeNull();
    expect(displayWorkspaceValue({ default_value: "New" }, null)).toBe("New");
  });
});

describe("3/4/5. vertical + horizontal grid lines", () => {
  it("every header cell carries a vertical separator (last column exempt)", () => {
    // Matches both orderings ("border-r border-b …" on headers,
    // "… border-r border-border" on body cells) but never the
    // last-column exemption itself.
    const verticals = pageSrc.match(/border-r border/g) ?? [];
    expect(verticals.length).toBeGreaterThanOrEqual(6);
    expect(pageSrc).toContain("last:border-r-0");
  });

  it("rows keep their horizontal separators", () => {
    const tablePrimitive = readFileSync(`${root}/src/components/ui/table.tsx`, "utf8");
    expect(tablePrimitive).toContain("border-b");
    expect(pageSrc).toContain("border-b border-border");
  });

  it("separators use the subtle theme token (no heavy/black/double styling)", () => {
    expect(pageSrc).toContain("border-border");
    expect(pageSrc).not.toContain("border-black");
    expect(pageSrc).not.toContain("border-2");
    expect(pageSrc).not.toContain("border-double");
    expect(pageSrc).not.toContain("shadow-");
  });
});

describe("6/7/8/9. alignment, sticky borders, scroll, header intact", () => {
  it("column siblings use namespaced render keys (never bare display keys)", () => {
    // A flow answer may share its logical key with a system column
    // (e.g. var_key "name" beside system Name) — keying by c.key
    // alone rendered duplicate React keys.
    const namespaced = pageSrc.split("key={flowColumnRenderKey(c)}").length - 1;
    expect(namespaced).toBeGreaterThanOrEqual(3);
    expect(pageSrc).not.toContain("key={c.key}");
  });

  it("header and body size from one width source, nothing pinned", () => {
    expect(pageSrc).not.toContain("resolveStickyLayouts(");
    expect(pageSrc).not.toContain("stickyLayouts[");
    // Headers paint positionally (index-aligned with the rendered
    // order); widths still resolve from the one width source.
    expect(pageSrc).toContain("headStyleAt(");
    expect(pageSrc).not.toContain("STICKY_Z.corner");
  });

  it("the single scroll viewport and sticky header are untouched", () => {
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-auto");
    expect(pageSrc).toContain("sticky top-0");
    expect(pageSrc).not.toMatch(/overflow-x-(auto|scroll)/);
  });

  it("wide-column headers center their labels; body text stays left-aligned", () => {
    // Customer Response / Next Action headers center within the
    // full 448px cell, matched by stored-name identity (never
    // positional indexes) — header cells only.
    expect(pageSrc).toContain("isWideTextColumnName(f.name) && 'text-center'");
    // Vertical centering, background, sizing, and resizing come
    // from the untouched header path.
    expect(pageSrc).toContain("align-middle");
    // Headers paint by rendered position (never by key lookup, so
    // a system/flow key collision cannot share one slot); the
    // business header passes its rendered index.
    expect(pageSrc).toContain("headStyleAt(");
    expect(pageSrc).toContain("flowColumnsVisible.length");
    expect(pageSrc).toContain("customIdx");
    expect(pageSrc).toContain("ColumnResizeHandle");
    // Body cells keep no centering: the wide body cap and the text
    // trigger stay left-aligned (including two-line truncation).
    expect(pageSrc).toContain("'max-w-112 whitespace-normal px-3 py-2'");
    expect(cellSrc).toContain("text-left");
  });
});

describe("10/11. chips and behavior unchanged", () => {
  it("colored chips still render (cells only, never whole-cell paint)", () => {
    expect(cellSrc).toContain("<SelectChipView");
    expect(cellSrc).toContain("getSelectChip(field.name, shown)");
    expect(cellSrc).toContain("assigneeChipFor(");
  });
});

describe("12. Google Sheets unaffected", () => {
  it("sheets paths reference none of the grid work", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("border-r");
      expect(src).not.toContain("SelectChipView");
    }
  });
});
