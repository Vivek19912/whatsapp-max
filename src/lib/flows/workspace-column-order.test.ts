import { describe, expect, it } from "vitest";

import {
  ACTIONS_ORDER_ID,
  buildDefaultOrderIds,
  dialOrderId,
  flowOrderId,
  isDialOrderId,
  mergeColumnOrder,
  normalizeSavedOrder,
} from "./workspace-column-order";
import { ROW_VIS_ID } from "./workspace-visibility";

// ---------------------------------------------------------------------------
// Shared column-order model: stable ids, default construction,
// saved-order merge. Pure functions — the header/body parity of the
// whole drag-and-drop feature rests on these.
// ---------------------------------------------------------------------------

function flowCol(key: string, system = false) {
  return { key, label: key, system };
}

describe("stable order identities", () => {
  it("reuses existing stable ids (never index/label/position)", () => {
    expect(ACTIONS_ORDER_ID).toBe("core:actions");
    expect(ROW_VIS_ID).toBe("core:row");
    expect(flowOrderId(flowCol("phone", true))).toBe("sys:phone");
    expect(flowOrderId(flowCol("Budget"))).toBe("flow:Budget");
    // System vs flow key collision keeps separate identities.
    expect(flowOrderId(flowCol("name", true))).not.toBe(
      flowOrderId(flowCol("name", false)),
    );
  });

  it("derives dial identity from its phone column", () => {
    expect(dialOrderId("sys:phone")).toBe("dial:sys:phone");
    expect(isDialOrderId("dial:sys:phone")).toBe(true);
    expect(isDialOrderId("sys:phone")).toBe(false);
    expect(isDialOrderId("custom:abc")).toBe(false);
  });
});

describe("buildDefaultOrderIds", () => {
  const customs = ["custom:a", "custom:cr", "custom:b"];

  it("emits today's exact sequence (actions, row, flows, business)", () => {
    expect(
      buildDefaultOrderIds({
        includeActions: true,
        includeRow: true,
        flowColumns: [flowCol("name", true), flowCol("phone", true)],
        customIds: customs,
      }),
    ).toEqual([
      "core:actions",
      "core:row",
      "sys:name",
      "sys:phone",
      "custom:a",
      "custom:cr",
      "custom:b",
    ]);
  });

  it("honours the actions/row gates", () => {
    expect(
      buildDefaultOrderIds({
        includeActions: false,
        includeRow: false,
        flowColumns: [flowCol("Budget")],
        customIds: ["custom:a"],
      }),
    ).toEqual(["flow:Budget", "custom:a"]);
    expect(
      buildDefaultOrderIds({
        includeActions: false,
        includeRow: true,
        flowColumns: [],
        customIds: [],
      }),
    ).toEqual(["core:row"]);
  });
});

describe("mergeColumnOrder", () => {
  const def = ["core:actions", "core:row", "sys:name", "flow:Budget", "custom:a"];
  const pinned = ["core:actions", "core:row", "sys:name"];

  it("returns default when nothing was saved", () => {
    expect(mergeColumnOrder({ defaultIds: def, savedIds: null, pinnedIds: pinned })).toEqual(def);
  });

  it("keeps saved relative order for known ids", () => {
    expect(
      mergeColumnOrder({
        defaultIds: def,
        savedIds: ["core:row", "custom:a", "core:actions", "sys:name", "flow:Budget"],
        pinnedIds: pinned,
      }),
    ).toEqual(["core:actions", "core:row", "sys:name", "custom:a", "flow:Budget"]);
  });

  it("forces pinned ids first even from corrupt saves", () => {
    expect(
      mergeColumnOrder({
        defaultIds: def,
        savedIds: ["flow:Budget", "sys:name", "core:row"],
        pinnedIds: pinned,
      }),
    ).toEqual(["core:actions", "core:row", "sys:name", "flow:Budget", "custom:a"]);
  });

  it("drops unknown ids and appends new ids in default order", () => {
    expect(
      mergeColumnOrder({
        defaultIds: [...def, "custom:new"],
        savedIds: ["custom:a", "core:actions", "ghost:id", "core:row", "sys:name", "flow:Budget"],
        pinnedIds: pinned,
      }),
    ).toEqual([
      "core:actions",
      "core:row",
      "sys:name",
      "custom:a",
      "flow:Budget",
      "custom:new",
    ]);
  });

  it("drops retired followup-result ids without resetting saved arrangements", () => {
    // Saved preferences from the retired sequential Follow-up N
    // Result columns must be ignored — the rest of the user's
    // saved order survives verbatim.
    expect(
      mergeColumnOrder({
        defaultIds: def,
        savedIds: [
          "core:actions",
          "core:row",
          "sys:name",
          "followup-result:1",
          "custom:a",
          "followup-result:2",
          "flow:Budget",
        ],
        pinnedIds: pinned,
      }),
    ).toEqual(["core:actions", "core:row", "sys:name", "custom:a", "flow:Budget"]);
  });

  it("strips stray dial ids (they re-derive, never stored)", () => {
    expect(
      mergeColumnOrder({
        defaultIds: def,
        savedIds: ["core:actions", "core:row", "dial:sys:phone", "sys:name"],
        pinnedIds: pinned,
      }),
    ).toEqual(["core:actions", "core:row", "sys:name", "flow:Budget", "custom:a"]);
  });

  it("tolerates absent pinned ids (hidden/ungated columns)", () => {
    expect(
      mergeColumnOrder({
        defaultIds: ["flow:Budget", "custom:a"],
        savedIds: ["custom:a", "flow:Budget"],
        pinnedIds: ["core:actions", "core:row", "sys:name"],
      }),
    ).toEqual(["custom:a", "flow:Budget"]);
  });
});

describe("normalizeSavedOrder", () => {
  it("accepts clean string arrays and dedupes", () => {
    expect(normalizeSavedOrder(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(normalizeSavedOrder([])).toEqual([]);
  });

  it("rejects non-arrays, non-strings, blanks, oversize input", () => {
    expect(normalizeSavedOrder(null)).toBeNull();
    expect(normalizeSavedOrder("a")).toBeNull();
    expect(normalizeSavedOrder(["a", 1])).toBeNull();
    expect(normalizeSavedOrder(["a", " "])).toBeNull();
    expect(normalizeSavedOrder(["a", "x".repeat(121)])).toBeNull();
    expect(normalizeSavedOrder(new Array(501).fill("a"))).toBeNull();
  });
});
