// Workspace lead ownership checks (agent scoping for Meta tables).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flows: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
}));

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Array<{ col: string; op: string; val: unknown }>,
  };
  const matched = () =>
    (state.table === "flows"
      ? h.flows
      : state.table === "workspace_fields"
        ? h.fields
        : h.values
    ).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, op: "in", val: vals });
      return api;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const list = matched();
      if (state.table === "workspace_fields") return resolve({ data: list, error: null });
      if (state.table === "workspace_values") return resolve({ data: list, error: null });
      return resolve({ data: list, error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      return api;
    },
  };
}

const { isMetaFlow, isRunOwnedByUser } = await import("./workspace-ownership");

beforeEach(() => {
  h.flows = [
    { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-wa", account_id: "acct-1", kind: "whatsapp_flow" },
  ];
  h.fields = [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-meta", name: "Assigned To" },
  ];
  h.values = [
    { account_id: "acct-1", field_id: "f-assign", flow_run_id: "run-mine", value_text: "u-agent" },
    { account_id: "acct-1", field_id: "f-assign", flow_run_id: "run-un", value_text: "Unassigned" },
  ];
});

describe("isMetaFlow", () => {
  it("is true only for this account's Meta tables", async () => {
    const db = fakeSupabase();
    expect(await isMetaFlow(db as never, "acct-1", "flow-meta")).toBe(true);
    expect(await isMetaFlow(db as never, "acct-1", "flow-wa")).toBe(false);
    expect(await isMetaFlow(db as never, "acct-1", "flow-missing")).toBe(false);
    expect(await isMetaFlow(db as never, "other-acct", "flow-meta")).toBe(false);
  });
});

describe("isRunOwnedByUser", () => {
  it("matches only the exact assigned user id", async () => {
    const db = fakeSupabase();
    expect(
      await isRunOwnedByUser(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta",
        runId: "run-mine",
        userId: "u-agent",
      }),
    ).toBe(true);
    expect(
      await isRunOwnedByUser(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta",
        runId: "run-mine",
        userId: "u-other",
      }),
    ).toBe(false);
  });

  it("treats unassigned, cleared, and missing columns as not owned", async () => {
    const db = fakeSupabase();
    expect(
      await isRunOwnedByUser(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta",
        runId: "run-un",
        userId: "u-agent",
      }),
    ).toBe(false);
    expect(
      await isRunOwnedByUser(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta",
        runId: "run-new",
        userId: "u-agent",
      }),
    ).toBe(false);
    h.fields = [];
    expect(
      await isRunOwnedByUser(db as never, {
        accountId: "acct-1",
        flowId: "flow-meta",
        runId: "run-mine",
        userId: "u-agent",
      }),
    ).toBe(false);
  });
});
