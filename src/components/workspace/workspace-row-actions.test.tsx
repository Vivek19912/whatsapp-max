import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HiddenRowsMenu } from "./hidden-rows-menu";
import { RowActionsMenu } from "./row-actions-menu";

// ---------------------------------------------------------------------------
// Workspace row pin/hide UI — actions column, menus, wiring (2/3/5/7).
//
// Interaction (drag/click) can't run in the node test env, so menus
// are verified structurally (SSR trigger markup + source patterns
// for items, pending guards, and persistence wiring), with the
// ordering/filtering math covered by workspace-row-prefs.test.ts
// and the API covered by row-prefs/route.test.ts.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);
const actionsSrc = readFileSync(
  `${root}/src/components/workspace/row-actions-menu.tsx`,
  "utf8",
);
const hiddenSrc = readFileSync(
  `${root}/src/components/workspace/hidden-rows-menu.tsx`,
  "utf8",
);

const HIDDEN = [
  { flow_run_id: "run-1", name: "Asha", phone: "+91111" },
  { flow_run_id: "run-2", name: null, phone: null },
];

describe("1. row actions column (narrow, first, writers only)", () => {
  it("adds a narrow actions header before the row-number column", () => {
    expect(pageSrc).toContain('aria-label="Row actions"');
    expect(pageSrc).toContain("w-12");
    const actionsIdx = pageSrc.indexOf('aria-label="Row actions"');
    // Row header paints positionally at index 0 of the rendered order.
    const rowIdx = pageSrc.indexOf("headStyleAt(0)");
    expect(actionsIdx).toBeGreaterThan(-1);
    expect(rowIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeLessThan(rowIdx);
  });

  it("gates the column on writers, like editing and resizing", () => {
    const headIdx = pageSrc.indexOf('aria-label="Row actions"');
    const gateIdx = pageSrc.lastIndexOf("canSendMessages && (", headIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    // The fixed actions column stays out of the width system.
    expect(pageSrc).not.toMatch(/columnWidthStyle\(.*ACTION/i);
  });

  it("every row renders one menu (never a button per cell)", () => {
    expect(pageSrc).toContain("<RowActionsMenu");
    expect(pageSrc).toContain("onTogglePin={() => handleTogglePin(row.runId)}");
    expect(pageSrc).toContain("onHide={() => handleHideRow(row.runId)}");
    expect(pageSrc).not.toContain("<Pin ");
  });
});

describe("2. row actions menu (pin/unpin/hide, no confirmation)", () => {
  function renderMenu(partial?: Partial<Parameters<typeof RowActionsMenu>[0]>) {
    return renderToStaticMarkup(
      <RowActionsMenu
        rowLabel="Asha"
        isPinned={false}
        pending={false}
        onTogglePin={vi.fn()}
        onHide={vi.fn()}
        {...partial}
      />,
    );
  }

  it("trigger is labelled and row clicks never open the drawer", () => {
    const html = renderMenu();
    expect(html).toContain("Row actions for Asha");
    expect(actionsSrc).toContain("e.stopPropagation()");
  });

  it("offers Pin row / Hide row, and Unpin row once pinned", () => {
    expect(actionsSrc).toContain("Pin row");
    expect(actionsSrc).toContain("Unpin row");
    expect(actionsSrc).toContain("Hide row");
    expect(renderMenu({ isPinned: true })).toContain('aria-label="Pinned"');
    expect(renderMenu()).not.toContain('aria-label="Pinned"');
  });

  it("menus escape the scroll viewport through a portal", () => {
    expect(actionsSrc).toContain("DropdownMenuContent");
    const ui = readFileSync(`${root}/src/components/ui/dropdown-menu.tsx`, "utf8");
    expect(ui).toContain("MenuPrimitive.Portal");
  });

  it("pending rows show a spinner and disable both actions (10)", () => {
    const html = renderMenu({ pending: true });
    expect(html).toContain("animate-spin");
    expect(actionsSrc).toContain("disabled={pending}");
    expect(pageSrc).toContain("rowActionPending.has(runId)");
    expect(pageSrc).toContain("if (!flowId || rowActionPending.has(runId)) return;");
  });
});

describe("3. pinned rows lead, highlighted, and stay subject to filters", () => {
  it("renders visible rows (hidden removed, pinned first) with row numbers intact", () => {
    expect(pageSrc).toContain("visibleRows.map((row, rowIndex)");
    expect(pageSrc).toContain("const visibleRows = useMemo(");
    expect(pageSrc).toContain("orderPinnedFirst(");
    expect(pageSrc).toContain("excludeHiddenRows(payload?.rows ?? [], hiddenIdSet)");
    expect(pageSrc).toContain("workspaceRowNumber({");
  });

  it("highlights pinned rows subtly without touching other styling", () => {
    expect(pageSrc).toContain("bg-amber-50/70 dark:bg-amber-950/20");
    expect(pageSrc).toContain("pinnedIds.has(row.runId)");
    // Existing 448px widths and two-line clamp are untouched.
    expect(pageSrc).toContain("max-w-112 whitespace-normal px-3 py-2");
    expect(pageSrc).toContain("twoLineClamp={isWideTextColumnName(f.name)}");
  });

  it("pin state never joins the table request (search/filters/tabs still rule)", () => {
    const keyLine = pageSrc.split("\n").find((l) => l.includes("const requestKey"));
    expect(keyLine).toBeDefined();
    expect(keyLine).not.toContain("pinned");
    expect(keyLine).not.toContain("hidden");
    expect(keyLine).not.toContain("rowPref");
  });
});

describe("4. hidden rows leave the table without touching lead data", () => {
  it("hiding flips a personal flag via PUT, then refetches table + prefs", () => {
    expect(pageSrc).toContain("handleHideRow");
    expect(pageSrc).toContain('method: \'PUT\'');
    expect(pageSrc).toContain("flow_run_id: runId");
    expect(pageSrc).toContain("await reloadRowPrefs();");
    expect(pageSrc).toContain("reloadTable();");
    // No delete/archive/complete call anywhere near hiding.
    const hideIdx = pageSrc.indexOf("const handleHideRow");
    const hideBlock = pageSrc.slice(hideIdx, hideIdx + 400);
    expect(hideBlock).not.toMatch(/delete|archive|complet/i);
  });

  it("failures roll back the optimistic snapshot with an error toast", () => {
    expect(pageSrc).toContain("setPinnedIds(prevPinned);");
    expect(pageSrc).toContain("setHiddenRows(prevHidden);");
    expect(pageSrc).toContain("toast.error(");
  });
});

describe("5. show-hidden control with per-row and bulk restore", () => {
  function renderHiddenMenu(count: number) {
    return renderToStaticMarkup(
      <HiddenRowsMenu
        hidden={HIDDEN.slice(0, count)}
        pendingIds={new Set()}
        restoreAllPending={false}
        onRestore={vi.fn()}
        onRestoreAll={vi.fn()}
      />,
    );
  }

  it("toolbar control shows the hidden count when available", () => {
    expect(renderHiddenMenu(2)).toContain("Hidden (2)");
    expect(renderHiddenMenu(0)).toContain("Hidden");
    expect(renderHiddenMenu(0)).not.toContain("Hidden (");
    expect(pageSrc).toContain("<HiddenRowsMenu");
    expect(pageSrc).toContain("onRestore={handleRestoreRow}");
    expect(pageSrc).toContain("onRestoreAll={handleRestoreAllHidden}");
  });

  it("panel lists identifiable rows with restore actions + restore all", () => {
    expect(hiddenSrc).toContain("hiddenRowLabel(h)");
    expect(hiddenSrc).toContain("Restore all");
    expect(hiddenSrc).toContain("No hidden rows");
    expect(hiddenSrc).toContain("onRestore(h.flow_run_id)");
    expect(hiddenSrc).toContain("onRestoreAll");
  });

  it("restore paths refetch table + prefs; bulk restore needs an explicit flag", () => {
    expect(pageSrc).toContain("handleRestoreRow");
    expect(pageSrc).toContain("handleRestoreAllHidden");
    expect(pageSrc).toContain("all_hidden: true");
    expect(pageSrc).toContain("method: 'DELETE'");
  });
});

describe("6. persistence is per user per flow in the database (6/8)", () => {  it("prefs load per flow and reset on flow switches (no cross-flow flash)", () => {
    expect(pageSrc).toContain("/row-prefs");
    expect(pageSrc).toContain("reloadRowPrefs");
    expect(pageSrc).toContain("setPinnedIds(new Set());");
    expect(pageSrc).toContain("setHiddenRows([]);");
    expect(pageSrc).toContain("[flowId, reloadRowPrefs]");
  });

  it("mutations validate ids server-side through the row-prefs API", () => {
    const matches = pageSrc.split("/row-prefs").length - 1;
    // GET prefs + PUT pref + DELETE restore-all.
    expect(matches).toBeGreaterThanOrEqual(3);
  });
});

describe("7. hidden-rows dropdown matches Workspace row formatting", () => {
  it("shows name and phone in separate distinguishable fields", () => {
    // Menu content mounts client-side (closed menus render only
    // the trigger in SSR), so row layout is pinned via source
    // patterns — same convention as the rest of this file.
    // Primary field: table-body typography (text-sm, medium,
    // foreground); secondary field: muted + tabular numbers, like
    // table metadata.
    expect(hiddenSrc).toContain("text-sm font-medium text-foreground");
    expect(hiddenSrc).toContain("{name ?? phone ?? \"Lead\"}");
    expect(hiddenSrc).toContain("tabular-nums");
    expect(hiddenSrc).toContain("{phone}");
    expect(hiddenSrc).toContain("{name && phone ? (");
    // The old single combined label survives only in the
    // accessible name — visible text is two separate fields.
    expect(hiddenSrc).toContain("aria-label={`Restore ${hiddenRowLabel(h)}`}");
  });

  it("handles missing phone, missing name, and long text without overlap", () => {
    // Phone line renders only when both fields exist; otherwise
    // the single known field (or the plain "Lead" fallback) stands
    // alone — no invented placeholders.
    expect(hiddenSrc).toContain("{name ?? phone ?? \"Lead\"}");
    expect(hiddenSrc).not.toContain("?? \"Unknown");
    // Long values truncate with full text in the tooltip; the
    // Restore action is pinned right and can never be overlapped.
    expect(hiddenSrc).toContain("truncate");
    expect(hiddenSrc).toContain("shrink-0");
    expect(hiddenSrc).toContain("title={name ?? phone ?? undefined}");
    expect(hiddenSrc).toContain("title={phone}");
  });

  it("delineates rows with separators and keeps Restore-all in a divided footer", () => {
    expect(hiddenSrc).toContain("divide-y divide-border");
    const footerIdx = hiddenSrc.lastIndexOf("Restore all");
    const listIdx = hiddenSrc.indexOf("divide-y divide-border");
    expect(footerIdx).toBeGreaterThan(listIdx);
    // The footer stays divided from the list by a border.
    const between = hiddenSrc.slice(listIdx, footerIdx);
    expect(between).toContain("DropdownMenuSeparator");
  });

  it("sizes the panel for readability and scrolls many rows", () => {
    expect(hiddenSrc).toContain("w-80 max-h-80");
    // Vertical scrolling comes from the shared menu primitive.
    const ui = readFileSync(`${root}/src/components/ui/dropdown-menu.tsx`, "utf8");
    expect(ui).toContain("overflow-y-auto");
  });

  it("restoring still works per row, with loading state on the action", () => {
    // Pending rows swap Restore for a spinner (menu content mounts
    // client-side, so this is pinned via source).
    expect(hiddenSrc).toContain("animate-spin");
    expect(hiddenSrc).toContain("pending ? (");
    expect(hiddenSrc).toContain("onRestore(h.flow_run_id)");
    expect(hiddenSrc).toContain("aria-label={`Restore ${hiddenRowLabel(h)}`}");
  });
});
