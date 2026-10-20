// Meta Lead Ads — per-form custom header names.
//
// Pins the Meta-only contract:
//   * GET/PUT work only on the caller's own Meta Lead Ads tables
//     (foreign accounts and non-Meta flows get a generic 404);
//   * only current Instant Form question columns may be renamed;
//   * empty names are rejected, never stored;
//   * restore deletes exactly one override;
//   * one form's overrides never affect another form;
//   * renaming never touches flows, flow_nodes, or lead data.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  flows: [] as Row[],
  nodes: [] as Row[],
  labels: [] as Row[],
  writes: [] as Array<{ table: string; op: string }>,
}));

function makeDb() {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "upsert" | "delete" = "select";
    let payload: Row = {};
    const store = () =>
      table === "flows" ? h.flows : table === "flow_nodes" ? h.nodes : h.labels;
    const matched = () => store().filter((r) => filters.every(([c, v]) => r[c] === v));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      upsert: (row: Row) => {
        op = "upsert";
        payload = row;
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === "upsert") {
          h.writes.push({ table, op });
          const rows = store();
          const idx = rows.findIndex(
            (r) =>
              r.account_id === payload.account_id &&
              r.flow_id === payload.flow_id &&
              r.column_key === payload.column_key,
          );
          if (idx >= 0) rows[idx] = { ...rows[idx], ...payload };
          else rows.push({ ...payload });
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        if (op === "delete") {
          h.writes.push({ table, op });
          const rows = store();
          for (let i = rows.length - 1; i >= 0; i--) {
            if (filters.every(([c, v]) => rows[i][c] === v)) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: matched(), error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: makeDb(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  requireRole: async () => {
    if (!h.roleOk) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return { supabase: makeDb(), accountId: h.accountId, userId: "user-1" };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

const { GET, PUT } = await import("./route");

const get = (flowId: string) =>
  new Request(
    `https://app.test/api/integrations/meta-lead-ads/flows/${flowId}/header-labels`,
  );
const put = (flowId: string, body: unknown) =>
  new Request(
    `https://app.test/api/integrations/meta-lead-ads/flows/${flowId}/header-labels`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
const params = (flowId: string) => ({ params: Promise.resolve({ flowId }) });

function seed() {
  h.flows = [
    { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-other", account_id: "acct-2", kind: "meta_lead_ads" },
    { id: "flow-chat", account_id: "acct-1", kind: "whatsapp_flow" },
  ];
  const question = (key: string, label: string) => ({
    node_type: "collect_input",
    config: { var_key: key, prompt_text: label },
  });
  h.nodes = [
    { flow_id: "flow-a", ...question("experience", "How much experience?") },
    { flow_id: "flow-a", ...question("meta_lead_source", "Source") },
    { flow_id: "flow-b", ...question("budget", "What is your budget?") },
    { flow_id: "flow-chat", ...question("name", "Your name?") },
  ];
  h.labels = [];
  h.writes = [];
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  seed();
});

describe("GET header labels", () => {
  it("returns this form's overrides keyed by stable column identity", async () => {
    h.labels = [
      {
        account_id: "acct-1",
        flow_id: "flow-a",
        column_key: "flow:experience",
        label: "Experience",
      },
    ];
    const res = await GET(get("flow-a"), params("flow-a"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: { "flow:experience": "Experience" } });
  });

  it("404s another account's table without leaking it", async () => {
    const res = await GET(get("flow-other"), params("flow-other"));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("acct-2");
  });

  it("404s Flow Tables — Meta overrides never apply there", async () => {
    const res = await GET(get("flow-chat"), params("flow-chat"));
    expect(res.status).toBe(404);
  });
});

describe("PUT header labels", () => {
  it("renames a question column and persists the override", async () => {
    const res = await PUT(
      put("flow-a", { column_key: "experience", label: "  Experience  " }),
      params("flow-a"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ column_key: "experience", label: "Experience" });
    expect(h.labels).toEqual([
      {
        account_id: "acct-1",
        flow_id: "flow-a",
        column_key: "flow:experience",
        label: "Experience",
      },
    ]);
  });

  it("survives a refresh: a later GET returns the saved override", async () => {
    await PUT(
      put("flow-a", { column_key: "experience", label: "Experience" }),
      params("flow-a"),
    );
    const res = await GET(get("flow-a"), params("flow-a"));
    expect(await res.json()).toEqual({ labels: { "flow:experience": "Experience" } });
  });

  it("rejects empty or whitespace-only names without storing anything", async () => {
    for (const label of ["", "   "]) {
      const res = await PUT(
        put("flow-a", { column_key: "experience", label }),
        params("flow-a"),
      );
      expect(res.status).toBe(400);
    }
    expect(h.labels).toHaveLength(0);
  });

  it("rejects unknown columns, system columns, and the Source column", async () => {
    for (const key of ["nope", "name", "submission_time", "meta_lead_source"]) {
      const res = await PUT(
        put("flow-a", { column_key: key, label: "X" }),
        params("flow-a"),
      );
      expect(res.status).toBe(400);
    }
    expect(h.labels).toHaveLength(0);
  });

  it("restores the original name by deleting only that column's override", async () => {
    h.labels = [
      { account_id: "acct-1", flow_id: "flow-a", column_key: "flow:experience", label: "Experience" },
      { account_id: "acct-1", flow_id: "flow-a", column_key: "flow:budget", label: "Budget" },
    ];
    // NOTE: flow:budget is not a question of flow-a (it belongs to
    // flow-b); seed it directly to prove restore is scoped by key.
    const res = await PUT(
      put("flow-a", { column_key: "experience", label: null }),
      params("flow-a"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ column_key: "experience", label: null });
    expect(h.labels).toEqual([
      { account_id: "acct-1", flow_id: "flow-a", column_key: "flow:budget", label: "Budget" },
    ]);
  });

  it("keeps one form's overrides out of another form's table", async () => {
    await PUT(
      put("flow-a", { column_key: "experience", label: "Experience" }),
      params("flow-a"),
    );
    const res = await GET(get("flow-b"), params("flow-b"));
    expect(await res.json()).toEqual({ labels: {} });
  });

  it("blocks cross-account writes and non-Meta flows", async () => {
    h.accountId = "acct-2";
    const foreign = await PUT(
      put("flow-a", { column_key: "experience", label: "X" }),
      params("flow-a"),
    );
    expect(foreign.status).toBe(404);
    const chat = await PUT(
      put("flow-chat", { column_key: "name", label: "X" }),
      params("flow-chat"),
    );
    expect(chat.status).toBe(404);
    expect(h.labels).toHaveLength(0);
  });

  it("never touches flows, nodes, or lead data", async () => {
    const flowsBefore = JSON.stringify(h.flows);
    const nodesBefore = JSON.stringify(h.nodes);
    await PUT(
      put("flow-a", { column_key: "experience", label: "Experience" }),
      params("flow-a"),
    );
    await PUT(
      put("flow-a", { column_key: "experience", label: null }),
      params("flow-a"),
    );
    expect(JSON.stringify(h.flows)).toBe(flowsBefore);
    expect(JSON.stringify(h.nodes)).toBe(nodesBefore);
    expect(h.writes.every((w) => w.table === "meta_lead_header_labels")).toBe(true);
  });
});
