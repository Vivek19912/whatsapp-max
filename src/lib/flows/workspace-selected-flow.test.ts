import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadSelectedFlowId,
  resolveInitialFlowId,
  saveSelectedFlowId,
  selectedFlowStorageKey,
} from "./workspace-selected-flow";

// ---------------------------------------------------------------------------
// Workspace selected-flow persistence — the last Workspace flow per
// account (flow_id only) survives navigation and refresh; a stale
// id falls back to the first flow, never to another account.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

// localStorage stub (vitest runs in node: no DOM storage by default).
const backing = new Map<string, string>();
function stubStorage(throwOnWrite = false) {
  backing.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOnWrite) throw new Error("quota exceeded");
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
  });
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage key (account-scoped flow_id, never the name)", () => {
  it("uses wacrm:workspace-selected-flow:<accountId>", () => {
    expect(selectedFlowStorageKey("acct-1")).toBe(
      "wacrm:workspace-selected-flow:acct-1",
    );
    expect(selectedFlowStorageKey("acct-2")).not.toBe(
      selectedFlowStorageKey("acct-1"),
    );
  });
});

describe("1+2. selecting a flow persists its ID", () => {
  it("save stores the stable flow_id under the account key", () => {
    saveSelectedFlowId("acct-1", "flow-A");
    expect(backing.get("wacrm:workspace-selected-flow:acct-1")).toBe("flow-A");
    expect(loadSelectedFlowId("acct-1")).toBe("flow-A");
  });
});

describe("3+4. returning (or refreshing) reselects the remembered flow", () => {
  it("resolve prefers the saved id when still listed", () => {
    saveSelectedFlowId("acct-1", "flow-A");
    // Fresh mount reads the same key again (navigation + refresh).
    expect(resolveInitialFlowId(["flow-A", "flow-B"], loadSelectedFlowId("acct-1"))).toBe(
      "flow-A",
    );
    expect(resolveInitialFlowId(["flow-A", "flow-B"], loadSelectedFlowId("acct-1"))).toBe(
      "flow-A",
    );
  });
});

describe("5+6. changing the flow persists the new selection", () => {
  it("save overwrites; the next mount selects Flow B", () => {
    saveSelectedFlowId("acct-1", "flow-A");
    saveSelectedFlowId("acct-1", "flow-B");
    expect(loadSelectedFlowId("acct-1")).toBe("flow-B");
    expect(resolveInitialFlowId(["flow-A", "flow-B"], loadSelectedFlowId("acct-1"))).toBe(
      "flow-B",
    );
  });
});

describe("7. one account cannot affect another", () => {
  it("saved Flow A under Account A is invisible to Account B", () => {
    saveSelectedFlowId("acct-A", "flow-A");
    expect(loadSelectedFlowId("acct-B")).toBeNull();
    expect(resolveInitialFlowId(["flow-A", "flow-B"], loadSelectedFlowId("acct-B"))).toBe(
      "flow-A",
    );
  });
});

describe("8+9. fallbacks (deleted flow, empty list, corrupt storage)", () => {
  it("a deleted/inaccessible id falls back to the first available flow", () => {
    expect(resolveInitialFlowId(["flow-B", "flow-C"], "flow-deleted")).toBe("flow-B");
    expect(resolveInitialFlowId(["flow-B", "flow-C"], null)).toBe("flow-B");
  });

  it("no flows resolves to null (existing empty state)", () => {
    expect(resolveInitialFlowId([], "flow-A")).toBeNull();
    expect(resolveInitialFlowId([], null)).toBeNull();
  });

  it("blank or corrupt storage reads as absent", () => {
    backing.set("wacrm:workspace-selected-flow:acct-1", "   ");
    expect(loadSelectedFlowId("acct-1")).toBeNull();
    expect(loadSelectedFlowId(null)).toBeNull();
  });

  it("storage failures degrade to session-only selection (never throws)", () => {
    stubStorage(true);
    expect(() => saveSelectedFlowId("acct-1", "flow-A")).not.toThrow();
    expect(loadSelectedFlowId("acct-1")).toBeNull();
    expect(() => resolveInitialFlowId(["flow-A"], null)).not.toThrow();
  });
});

describe("10. page wiring (remembered flow drives the first table fetch)", () => {
  it("initial pick resolves from storage inside the flows load", () => {
    expect(pageSrc).toContain("loadSelectedFlowId(accountId)");
    expect(pageSrc).toContain("resolveInitialFlowId(");
    // setFlowId is set from the resolved id in the same flush as
    // the list — the table requestKey derives from flowId, so the
    // remembered flow's data is the first fetch (no wrong-flow flash).
    // Agents fetch the assigned-tables endpoint; everyone else the
    // full list — both resolve through the same flush.
    expect(pageSrc).toContain(
      "const flowsUrl = isAgent ? '/api/workspace/my-tables' : '/api/flows';",
    );
    const fetchIdx = pageSrc.indexOf("fetch(flowsUrl,");
    const resolveIdx = pageSrc.indexOf("resolveInitialFlowId(");
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(fetchIdx);
  });

  it("changing the flow persists immediately with the account scope", () => {
    expect(pageSrc).toContain("saveSelectedFlowId(accountId, id)");
  });

  it("empty state is preserved when no flows exist", () => {
    expect(pageSrc).toContain("No flows yet");
  });
});
