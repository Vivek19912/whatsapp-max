import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceFilters } from "./workspace-filters";
import type { WorkspaceColumnFilters } from "@/lib/flows/workspace-filters";

// ---------------------------------------------------------------------------
// Workspace column filters UI — five collapsible sections inside the
// existing Filters panel (no separate interface).
//
// The panel mounts its content client-side (closed popovers render
// only the trigger in SSR), so section layout is pinned via source
// patterns — the same convention as the other workspace suites —
// while the badge (applied-state driven) is SSR-rendered.
// ---------------------------------------------------------------------------

const root = process.cwd();
const panelSrc = readFileSync(
  `${root}/src/components/workspace/workspace-filters.tsx`,
  "utf8",
);
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

const OPTIONS = {
  callStatus: ["Connected", "Not Answering", "Busy"],
  followUpStatus: ["Follow-up Pending", "Booked"],
  lastContactDate: true,
  nextFollowUp: true,
};

function renderPanel(appliedColumns: WorkspaceColumnFilters) {
  return renderToStaticMarkup(
    <WorkspaceFilters
      members={[]}
      appliedDate={null}
      appliedAssignee={{ type: "all" }}
      appliedColumns={appliedColumns}
      columnOptions={OPTIONS}
      onApply={vi.fn()}
    />,
  );
}

function activeColumns(): WorkspaceColumnFilters {
  return {
    callStatus: ["Connected", "Busy"],
    callsTried: { op: "between", min: 2, max: 5 },
    followUpStatus: [],
    lastContact: null,
    nextFollowUp: { mode: "overdue", from: null, to: "2026-10-15T12:00:00.000Z" },
  };
}

const EMPTY = {
  callStatus: [],
  callsTried: null,
  followUpStatus: [],
  lastContact: null,
  nextFollowUp: null,
};

describe("1. five collapsible sections live in the existing panel", () => {
  it("labels all five sections (no separate interface)", () => {
    for (const label of [
      "Call Status",
      "No. of Calls Tried",
      "Follow-Up Status",
      "Last Contact Date",
      "Next Follow-up Date & Time",
    ]) {
      expect(panelSrc).toContain(label);
    }
    expect(panelSrc).toContain("aria-expanded");
    expect(panelSrc).toContain("ChevronDown");
    expect(panelSrc).toContain("toggleSection");
  });

  it("uses checkboxes for categoricals and numeric/date controls otherwise", () => {
    expect(panelSrc).toContain("Checkbox");
    expect(panelSrc).toContain('type="number"');
    expect(panelSrc).toContain('type="date"');
    expect(panelSrc).toContain('type="datetime-local"');
    expect(panelSrc).toContain("CALLS_TRIED_OPS");
    expect(panelSrc).toContain("COLUMN_DATE_MODES");
    expect(panelSrc).toContain("FOLLOW_UP_MODES");
  });

  it("hides select sections whose column is missing (nothing to filter)", () => {
    expect(panelSrc).toContain("columnOptions.callStatus.length > 0");
    expect(panelSrc).toContain("columnOptions.followUpStatus.length > 0");
    expect(panelSrc).toContain("columnOptions.lastContactDate");
    expect(panelSrc).toContain("columnOptions.nextFollowUp");
  });
});

describe("2. badge, apply, clear, and draft restore", () => {
  it("badge counts active sections (applied state, SSR-visible)", () => {
    // Three active sections (call status + calls tried + follow-up) → badge "3".
    expect(renderPanel(activeColumns())).toContain(">3<");
    expect(renderPanel(EMPTY)).not.toMatch(/>\d+</);
  });

  it("Apply validates through the resolvers; invalid input toasts and aborts", () => {
    expect(panelSrc).toContain("resolveCallsTriedFilter(callsTriedOp, {");
    expect(panelSrc).toContain("resolveColumnDateFilter(lastContactMode, {");
    expect(panelSrc).toContain("resolveFollowUpFilter(nextFollowUpMode, {");
    expect(panelSrc).toContain("toast.error(");
    expect(panelSrc).toContain("onApply(date, assignee, columns);");
  });

  it("Clear all resets every filter and applies immediately", () => {
    expect(panelSrc).toContain("onApply(null, { type: 'all' }, emptyColumnFilters());");
  });

  it("reopening restores drafts from applied filters (active sections expand)", () => {
    expect(panelSrc).toContain("setCallStatusDraft([...applied.callStatus]);");
    expect(panelSrc).toContain("setFollowUpStatusDraft([...applied.followUpStatus]);");
    expect(panelSrc).toContain("setLastContactMode(");
    expect(panelSrc).toContain("setNextFollowUpMode(");
    expect(panelSrc).toContain("setCallsTriedOp(applied.callsTried?.op ?? '');");
    expect(panelSrc).toContain("active.add(");
  });

  it("per-section Clear resets one section without touching the rest", () => {
    expect(panelSrc).toContain("clearSection");
    expect(panelSrc).toContain("aria-label={`Clear ${COLUMN_SECTION_LABELS[key]} filter`}");
  });
});

describe("3. mode coverage per column", () => {
  it("calls-tried offers eq/gt/lt/between with matching inputs", () => {
    expect(panelSrc).toContain("callsTriedValue");
    expect(panelSrc).toContain("callsTriedMin");
    expect(panelSrc).toContain("callsTriedMax");
    expect(panelSrc).toContain("callsTriedOp === 'between'");
  });

  it("date sections offer specific/range/before/after; follow-up adds today/overdue/upcoming", () => {
    expect(panelSrc).toContain("COLUMN_DATE_MODE_LABELS");
    expect(panelSrc).toContain("FOLLOW_UP_MODE_LABELS");
    expect(panelSrc).toContain("nextFollowUpMode === 'before'");
    expect(panelSrc).toContain("nextFollowUpMode === 'after'");
  });
});

describe("4. page wiring (server-side, conjunctive, page-safe)", () => {
  it("applied columns ride the table request and reset the page", () => {
    expect(pageSrc).toContain("appliedColumns");
    // The request serializes the KPI-composed columns (the KPI bucket
    // range is AND-ed with the user's own nextFollowUp column filter
    // via intersectFollowUpRanges; with no KPI active it is identical
    // to the applied columns).
    expect(pageSrc).toContain("columnFiltersRequestKey(effectiveColumns)");
    expect(pageSrc).toContain("columns: effectiveColumns,");
    expect(pageSrc).toContain("intersectFollowUpRanges");
    expect(pageSrc).toContain("setAppliedColumns(columns);");
    // applyFilters still resets to page 0 (no stale-page empties).
    const applyIdx = pageSrc.indexOf("const applyFilters");
    const applyBlock = pageSrc.slice(applyIdx, applyIdx + 500);
    expect(applyBlock).toContain("setPage(0);");
  });

  it("options derive from the flow's own fields; empty states see the filters", () => {
    expect(pageSrc).toContain("columnFilterOptions");
    expect(pageSrc).toContain("callStatus: selectOptions('call status')");
    expect(pageSrc).toContain("columns: appliedColumns,");
    expect(pageSrc).toContain("<WorkspaceFilters");
  });

  it("preserves widths, clamp, header centering, and pin/hide", () => {
    expect(pageSrc).toContain("max-w-112 whitespace-normal px-3 py-2");
    expect(pageSrc).toContain("twoLineClamp={isWideTextColumnName(f.name)}");
    expect(pageSrc).toContain("isWideTextColumnName(f.name) && 'text-center'");
    expect(pageSrc).toContain("visibleRows.map((row, rowIndex)");
    expect(pageSrc).toContain("<HiddenRowsMenu");
    expect(pageSrc).toContain("<RowActionsMenu");
  });
});
