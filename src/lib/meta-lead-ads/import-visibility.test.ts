// Meta Lead Ads — historical import becomes visible in Workspace.
//
// Regression for the production failure where a lead was recorded in
// `meta_lead_submissions` but never appeared in the Workspace: the Graph
// lead fetch requested the nonexistent `page_id` field, every processing
// attempt failed, and no `flow_runs` row was ever written. The import
// toast also reported success because it only looked at `imported`.
//
// This test drives the real `importFormLeads` pipeline (Graph + storage
// mocked) and asserts the lead materializes as ONE completed `flow_runs`
// row on the form's Meta virtual flow, which the Completed view counts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyFlowRun } from "@/lib/flows/flow-tables";

import type { MetaLeadAdsConfig } from "./config";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  leads: [] as Array<Row>,
  lead: null as Row | null,
}));

vi.mock("./graph-client", () => ({
  listFormLeads: async () => ({ leads: h.leads, nextCursor: null }),
  getLead: async () => h.lead,
  MetaGraphError: class MetaGraphError extends Error {},
}));

vi.mock("./store", () => ({
  getPageToken: async () => "page-token",
  markNeedsReauth: async () => {},
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  onMetaLeadReceived: async () => {},
}));

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 1;

  function builder(table: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown = null;
    let patch: Row = {};
    const filters: Array<{ col: string; val: unknown; kind: string }> = [];
    let orExpr: string | null = null;

    const matches = (): Row[] => {
      let rows = (data[table] ?? []).filter((r) =>
        filters.every((f) => {
          if (f.kind === "neq") return r[f.col] !== f.val;
          return r[f.col] === f.val;
        }),
      );
      if (orExpr) {
        const parts = orExpr.split(",");
        rows = rows.filter((r) =>
          parts.some((p) => {
            const m = /^([a-z_]+)\.(is|null)\.?(.*)$/.exec(p.trim());
            if (m && m[2] === "null") return r[m[1]] == null;
            const lt = /^([a-z_]+)\.lt\.(.*)$/.exec(p.trim());
            if (lt) return String(r[lt[1]]) < lt[2];
            return true;
          }),
        );
      }
      return rows;
    };

    const run = () => {
      if (op === "insert") {
        if (!data[table]) data[table] = [];
        const row: Row = { id: `gen-${idCounter++}`, ...(payload as Row) };
        data[table].push(row);
        return { data: row, error: null };
      }
      if (op === "update") {
        for (const r of matches()) Object.assign(r, patch);
        return { data: null, error: null };
      }
      if (op === "delete") {
        data[table] = (data[table] ?? []).filter((r) => !matches().includes(r));
        return { data: null, error: null };
      }
      return { data: matches(), error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => {
        op = "insert";
        payload = p;
        return b;
      },
      update: (p: Row) => {
        op = "update";
        patch = p;
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val, kind: "eq" });
        return b;
      },
      neq: (col: string, val: unknown) => {
        filters.push({ col, val, kind: "neq" });
        return b;
      },
      or: (expr: string) => {
        orExpr = expr;
        return b;
      },
      like: (col: string, val: string) => {
        filters.push({ col, val, kind: "like" });
        return b;
      },
      is: () => b,
      not: () => b,
      lte: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      single: async () => {
        const r = run();
        return { data: r.data ?? matches()[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    data,
  };
}

const CONFIG: MetaLeadAdsConfig = {
  appId: "1",
  appSecret: "secret",
  webhookVerifyToken: "verify",
  graphVersion: "v21.0",
};

vi.mock("./config", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return actual;
});

import { importFormLeads, type SyncFormRow } from "./sync";

const FORM: SyncFormRow = {
  id: "form-1",
  account_id: "acct-1",
  page_id: "P1",
  form_id: "F1",
  form_name: "Travel Agency Customers",
  enabled: true,
  import_status: "importing",
  import_cursor: null,
  imported_count: 0,
  last_lead_at: null,
  last_polled_at: null,
};

function seed() {
  return makeDb({
    accounts: [{ id: "acct-1", owner_user_id: "user-1" }],
    whatsapp_config: [],
    meta_lead_pages: [{ id: "p-1", account_id: "acct-1", page_id: "P1" }],
    meta_lead_forms: [{ ...FORM }],
    meta_lead_submissions: [],
    flows: [],
    flow_nodes: [],
    contacts: [],
    flow_runs: [],
  });
}

beforeEach(() => {
  h.leads = [{ id: "L1", created_time: "2026-01-01T00:00:00Z" }];
  h.lead = {
    id: "L1",
    created_time: "2026-01-01T00:00:00Z",
    platform: "facebook",
    field_data: [
      { name: "full_name", values: ["Asha"] },
      { name: "phone_number", values: ["+14155550123"] },
    ],
  };
});

describe("historical Meta lead import → Workspace Completed view", () => {
  it("materializes exactly one completed run on the form's virtual flow", async () => {
    const { db, data } = seed();

    const result = await importFormLeads(db, CONFIG, {
      accountId: "acct-1",
      form: { ...FORM },
    });

    expect(result).toMatchObject({
      imported: 1,
      processed: 1,
      failed: 0,
      error: null,
    });

    // The virtual flow is the form's flow, in the form's account.
    expect(data.flows).toHaveLength(1);
    const flow = data.flows[0];
    expect(flow).toMatchObject({
      kind: "meta_lead_ads",
      account_id: "acct-1",
      meta_form_id: "form-1",
    });
    // The DB default is NULL; the fake only stores explicit columns.
    expect(flow.completion_node_id ?? null).toBeNull();

    // Exactly one run, owned by that flow, terminally completed.
    expect(data.flow_runs).toHaveLength(1);
    const run = data.flow_runs[0];
    expect(run).toMatchObject({
      flow_id: flow.id,
      account_id: "acct-1",
      status: "completed",
      current_node_key: null,
      end_reason: "meta_lead_ads",
    });

    // The submission points at the run (no orphan ledger rows).
    expect(data.meta_lead_submissions).toHaveLength(1);
    expect(data.meta_lead_submissions[0]).toMatchObject({
      status: "processed",
      flow_run_id: run.id,
    });

    // Both the RPC predicate and the route renderer put it in Completed.
    expect(
      classifyFlowRun({
        status: String(run.status),
        reachedAt: null,
        completionNodeId: (flow.completion_node_id as string | null) ?? null,
      }),
    ).toBe("completed");
  });

  it("surfaces processing failures instead of reporting a successful import", async () => {
    h.lead = null; // Graph returned nothing → processing must fail.
    const { db, data } = seed();

    const result = await importFormLeads(db, CONFIG, {
      accountId: "acct-1",
      form: { ...FORM },
    });

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    expect(data.flow_runs).toHaveLength(0);
    expect(data.meta_lead_submissions[0]).toMatchObject({ status: "failed" });
  });
});
