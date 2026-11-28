import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Workspace drag-and-drop column reordering contracts.
//
// The grid renders only in the browser, so interaction is pinned as
// source contracts here (same read-source pattern as the other
// workspace table tests): dnd-kit wiring, pinned-column rules,
// Dial attachment, save-on-drop-only persistence, reset wiring,
// and edge auto-scroll. Order math (stable ids, merge, pinning) is
// covered by workspace-column-order.test.ts.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);
const menuSrc = readFileSync(
  `${root}/src/components/workspace/columns-menu.tsx`,
  "utf8",
);
const routeSrc = readFileSync(
  `${root}/src/app/api/flows/[id]/column-orders/route.ts`,
  "utf8",
);

describe("dnd-kit wiring (existing deps only, horizontal sort)", () => {
  it("drives headers through DndContext + SortableContext + DragOverlay", () => {
    expect(pageSrc).toContain("<DndContext");
    expect(pageSrc).toContain("<SortableContext");
    expect(pageSrc).toContain("items={sortableColumnIds}");
    expect(pageSrc).toContain("strategy={horizontalListSortingStrategy}");
    expect(pageSrc).toContain("collisionDetection={closestCenter}");
    expect(pageSrc).toContain("<DragOverlay>");
    // No new DnD dependency: only @dnd-kit/core + @dnd-kit/sortable.
    expect(pageSrc).toContain("from '@dnd-kit/core'");
    expect(pageSrc).toContain("from '@dnd-kit/sortable'");
    expect(pageSrc).not.toContain("react-beautiful-dnd");
    expect(pageSrc).not.toContain("react-dnd");
  });

  it("uses guarded sensors (pointer distance, touch long-press, keyboard)", () => {
    expect(pageSrc).toContain("PointerSensor");
    expect(pageSrc).toContain("activationConstraint: { distance: 6 }");
    expect(pageSrc).toContain("TouchSensor");
    expect(pageSrc).toContain("activationConstraint: { delay: 200, tolerance: 6 }");
    expect(pageSrc).toContain("KeyboardSensor");
    expect(pageSrc).toContain("sortableKeyboardCoordinates");
  });

  it("never transforms table cells mid-drag (no layout jumping)", () => {
    // CSS transforms are unreliable on table-cell display types
    // and would fight the frozen offsets: the drag dims the
    // header, marks the drop target, and floats a preview instead.
    expect(pageSrc).not.toContain("CSS.Transform");
    expect(pageSrc).not.toContain("translate3d");
    expect(pageSrc).toContain("isDragging && 'opacity-40'");
  });
});

describe("drag handle (explicit, inert surroundings)", () => {
  it("renders one labelled grip per eligible header", () => {
    expect(pageSrc).toContain("Drag ${label} column to reorder");
    expect(pageSrc).toContain("<GripVertical");
    expect(pageSrc).toContain("{...listeners}");
  });

  it("starts drags only from the grip (never resize/rename/inputs/dial)", () => {
    // Listeners spread exactly once — on the grip button. Resize
    // handles, rename menus, and Dial buttons carry none.
    const spreads = pageSrc.split("{...listeners}").length - 1;
    expect(spreads).toBe(1);
    expect(pageSrc).toContain("cursor-grab");
    expect(pageSrc).toContain("active:cursor-grabbing");
  });
});

describe("pinned columns (No., Name, row actions)", () => {
  it("excludes row actions from the sortable set entirely", () => {
    expect(pageSrc).toContain(
      "orderedColumns.filter((e) => e.kind !== 'actions')",
    );
    expect(pageSrc).toContain("ACTIONS_ORDER_ID");
  });

  it("renders No. and Name fully inert (no drag, no drop, no indicator)", () => {
    // useSortable disabled=true disables both dragging AND
    // dropping for the pinned shells.
    expect(pageSrc).toContain('label="No."');
    expect(pageSrc).toContain("disabled={isNameCol || dragDisabled}");
    expect(pageSrc).toContain("showInsertionBar={false}");
    expect(pageSrc).toContain("showInsertionBar={!isNameCol && insertionFor(entry.id)}");
  });

  it("clamps every drop past the pinned block (pointer and keyboard)", () => {
    expect(pageSrc).toContain("pinnedColumnIdSet");
    expect(pageSrc).toContain("Math.max(to, pinnedCount)");
    expect(pageSrc).toContain("arrayMove(ids, from, Math.max(to, pinnedCount))");
  });

  it("disables every handle for viewers and mid-save", () => {
    expect(pageSrc).toContain(
      "const dragDisabled = !canSendMessages || savingOrder;",
    );
  });
});

describe("helper columns (Dial attachment, actions position)", () => {
  it("keeps Dial outside the sortable node, attached to Phone", () => {
    expect(pageSrc).toContain("dialAfter={");
    expect(pageSrc).toContain("dialAfter?: React.ReactNode");
    expect(pageSrc).toContain("{dialAfter}");
    expect(pageSrc).toContain("dialOrderId(entry.id)");
    // Dial still renders immediately after Phone, unchanged.
    expect(pageSrc).toContain("c.system && c.key === 'phone'");
  });

  it("shows a floating preview and a thin insertion bar mid-drag", () => {
    expect(pageSrc).toContain("activeColumnId");
    expect(pageSrc).toContain("overColumnId");
    expect(pageSrc).toContain("showInsertionBar");
    expect(pageSrc).toContain("bg-primary pointer-events-none absolute");
    expect(pageSrc).toContain("onDragStart={handleColumnDragStart}");
    expect(pageSrc).toContain("onDragOver={handleColumnDragOver}");
    expect(pageSrc).toContain("onDragEnd={handleColumnDragEnd}");
    expect(pageSrc).toContain("onDragCancel={handleColumnDragCancel}");
  });
});

describe("persistence (save only on drop, per user per table)", () => {
  it("persists the complete order only in the drop handler", () => {
    expect(pageSrc).toContain("saveOrder(next)");
    expect(pageSrc).toContain("handleColumnDragEnd");
    // Hover tracking never persists: the over handler only moves
    // the insertion bar.
    const overHandler = pageSrc.slice(
      pageSrc.indexOf("handleColumnDragOver = useCallback"),
      pageSrc.indexOf("handleColumnDragOver = useCallback") + 600,
    );
    expect(overHandler).toContain("setOverColumnId");
    expect(overHandler).not.toContain("saveOrder");
  });

  it("rolls back with a toast when the save fails", () => {
    expect(pageSrc).toContain("Could not save the column order. Reverted.");
    expect(pageSrc).toContain("Column order saved.");
  });

  it("scopes the API to the caller (user_id) with validated input", () => {
    expect(routeSrc).toContain('.eq("user_id", userId)');
    expect(routeSrc).toContain('requireRole("agent")');
    expect(routeSrc).toContain("onConflict: \"user_id,account_id,flow_id\"");
    expect(routeSrc).toContain("ordered_ids must be an array");
  });
});

describe("reset to default (ordering only)", () => {
  it("offers an unobtrusive reset inside the Columns menu", () => {
    expect(menuSrc).toContain("onResetOrder");
    expect(menuSrc).toContain("Reset column order");
    expect(pageSrc).toContain("onResetOrder={canSendMessages ? handleResetColumnOrder : undefined}");
    expect(pageSrc).toContain("handleResetColumnOrder");
    expect(pageSrc).toContain("Column order reset to default.");
  });

  it("reset clears the preference without touching other settings", () => {
    expect(pageSrc).toContain("resetOrder()");
    expect(routeSrc).toContain(".delete()");
    // Reset path never writes widths, colors, or visibility.
    expect(pageSrc).not.toContain("resetOrder widths");
  });
});

describe("edge auto-scroll (programmatic viewport)", () => {
  it("nudges the overflow-x-hidden viewport near either edge mid-drag", () => {
    expect(pageSrc).toContain("useColumnDragAutoscroll(viewportRef, activeColumnId !== null)");
    expect(pageSrc).toContain("requestAnimationFrame(tick)");
    expect(pageSrc).toContain("viewport.scrollLeft +=");
    expect(pageSrc).toContain("pointermove");
    // Shift+wheel and trackpad handlers are untouched.
    expect(pageSrc).toContain("useShiftWheel(viewportRef, tableKey)");
  });
});

const prefH = vi.hoisted(() => ({
  dbCalls: [] as string[],
}));

function prefFakeSupabase() {
  const chain: Record<string, (...args: never[]) => unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.in = () => chain;
  chain.maybeSingle = async () => {
    prefH.dbCalls.push("maybeSingle");
    return { data: null, error: null };
  };
  // Awaitable directly for plain select chains.
  (chain as { then: unknown }).then = (
    resolve: (v: { data: unknown; error: null }) => unknown,
  ) => resolve({ data: [], error: null });
  return {
    from: (table: string) => {
      prefH.dbCalls.push(`from:${table}`);
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: prefFakeSupabase(),
    accountId: "acct-1",
    userId: "u-1",
    role: "owner",
    account: { id: "acct-1", name: "Test" },
  }),
  requireRole: async () => ({
    supabase: prefFakeSupabase(),
    accountId: "acct-1",
    userId: "u-1",
    role: "owner",
    account: { id: "acct-1", name: "Test" },
  }),
  toErrorResponse: () =>
    Response.json({ error: "Internal server error" }, { status: 500 }),
}));

const { GET: getOrders, PUT: putOrders, DELETE: deleteOrders } =
  await import("../../app/api/flows/[id]/column-orders/route");
const { GET: getWidths } = await import(
  "../../app/api/flows/[id]/column-widths/route"
);
const { GET: getColors } = await import(
  "../../app/api/flows/[id]/header-colors/route"
);
const { GET: getRowPrefs } = await import(
  "../../app/api/flows/[id]/row-prefs/route"
);

function virtualReq(method = "GET", body?: unknown) {
  return new Request("http://localhost/api/flows/all-meta-leads/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function virtualParams() {
  return { params: Promise.resolve({ id: "all-meta-leads" }) };
}

describe("virtual All Meta Leads table (non-UUID id)", () => {
  // Regression tests for the HTTP 500
  // `invalid input syntax for type uuid: "all-meta-leads"`: the
  // virtual id must short-circuit before any UUID-column query,
  // returning each endpoint's default shape. Writes stay rejected
  // with the existing 404 contract.
  beforeEach(() => {
    prefH.dbCalls = [];
  });

  it("column-orders GET returns the default without touching the database", async () => {
    const res = await getOrders(virtualReq(), virtualParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ordered_ids: null });
    expect(prefH.dbCalls).toEqual([]);
  });

  it("column-widths GET returns the default without touching the database", async () => {
    const res = await getWidths(virtualReq(), virtualParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ widths: {} });
    expect(prefH.dbCalls).toEqual([]);
  });

  it("header-colors GET returns the default without touching the database", async () => {
    const res = await getColors(virtualReq(), virtualParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ colors: {} });
    expect(prefH.dbCalls).toEqual([]);
  });

  it("row-prefs GET returns the default without touching the database", async () => {
    const res = await getRowPrefs(virtualReq(), virtualParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: [], hidden: [] });
    expect(prefH.dbCalls).toEqual([]);
  });

  it("writes to the virtual table are rejected as unknown flows", async () => {
    const putRes = await putOrders(
      virtualReq("PUT", { ordered_ids: ["flow:name"] }),
      virtualParams(),
    );
    expect(putRes.status).toBe(404);
    const deleteRes = await deleteOrders(virtualReq("DELETE"), virtualParams());
    expect(deleteRes.status).toBe(404);
    expect(prefH.dbCalls).toEqual([]);
  });

  it("guards precede every UUID-column query in source", () => {
    const widthsSrc = readFileSync(
      `${root}/src/app/api/flows/[id]/column-widths/route.ts`,
      "utf8",
    );
    const colorsSrc = readFileSync(
      `${root}/src/app/api/flows/[id]/header-colors/route.ts`,
      "utf8",
    );
    const prefsSrc = readFileSync(
      `${root}/src/app/api/flows/[id]/row-prefs/route.ts`,
      "utf8",
    );
    for (const s of [routeSrc, widthsSrc, colorsSrc, prefsSrc]) {
      expect(s).toContain("id === ALL_META_LEADS_ID");
      // The short-circuit sits before the first UUID-based flow
      // lookup in every handler.
      expect(s.indexOf("if (id === ALL_META_LEADS_ID)")).toBeLessThan(
        s.indexOf("loadFlowAccount(supabase, accountId, id)"),
      );
    }
  });
});
