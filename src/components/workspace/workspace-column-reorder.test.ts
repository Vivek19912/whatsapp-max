import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
