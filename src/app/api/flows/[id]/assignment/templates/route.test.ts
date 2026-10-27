// Per-table assignment templates picker — account scoping,
// APPROVED-only filtering, and sender status. No production I/O.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  flows: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
  sender: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: "owner-1",
    role: h.role,
  }),
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

type Filter = { col: string; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  if (table === "flows") return h.flows;
  if (table === "message_templates") return h.templates;
  if (table === "whatsapp_config") return h.sender ? [h.sender] : [];
  return [];
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    limitN: null as number | null,
  };
  const matched = () =>
    tableRows(state.table).filter((r) =>
      state.filters.every((f) => r[f.col] === f.val),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, val });
      return api;
    },
    order: (col: string) => {
      state.orderCol = col;
      return api;
    },
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      let list = matched();
      if (state.orderCol) {
        const col = state.orderCol;
        list = [...list].sort((a, b) =>
          String(a[col]) < String(b[col]) ? -1 : 1,
        );
      }
      if (state.limitN !== null) list = list.slice(0, state.limitN);
      return resolve({ data: list, error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.orderCol = null;
      state.limitN = null;
      return api;
    },
  };
}

const route = await import("./route");

const params = (flowId: string) => ({ params: Promise.resolve({ id: flowId }) });

function seed() {
  h.role = "owner";
  h.accountId = "acct-1";
  h.flows = [
    { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-1" },
    { id: "flow-plain", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null },
    { id: "flow-foreign", account_id: "acct-2", kind: "meta_lead_ads", meta_form_id: "formdb-x" },
  ];
  h.templates = [
    { account_id: "acct-1", name: "new_lead_assigned", language: "en_US", status: "APPROVED", category: "Utility" },
    { account_id: "acct-1", name: "new_lead_assigned", language: "en", status: "APPROVED", category: "Utility" },
    { account_id: "acct-1", name: "promo_blast", language: "en_US", status: "PENDING", category: "Marketing" },
    { account_id: "acct-2", name: "other_acct_tpl", language: "en_US", status: "APPROVED", category: "Utility" },
    { account_id: "acct-1", name: "zz_last", language: "en_US", status: "APPROVED", category: null },
  ];
  h.sender = { account_id: "acct-1", phone_number_id: "pn-1" };
}

beforeEach(seed);

describe("GET /flows/[id]/assignment/templates", () => {
  it("404s foreign or missing tables", async () => {
    expect((await route.GET(new Request("https://x/"), params("flow-foreign"))).status).toBe(404);
    expect((await route.GET(new Request("https://x/"), params("nope"))).status).toBe(404);
  });

  it("resolves Flow tables as well as Meta tables", async () => {
    const res = await route.GET(new Request("https://x/"), params("flow-plain"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { templates: unknown[] };
    expect(json.templates).toHaveLength(3);
  });

  it("returns only this account's APPROVED templates, ordered by name", async () => {
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      templates: Array<{ name: string; language: string; status: string; category: string | null }>;
      sender_connected: boolean;
    };
    expect(json.templates.map((t) => `${t.name}:${t.language}`).sort()).toEqual([
      "new_lead_assigned:en",
      "new_lead_assigned:en_US",
      "zz_last:en_US",
    ]);
    // Ordered by name (same-name languages keep server order).
    expect(json.templates.map((t) => t.name)).toEqual([
      "new_lead_assigned",
      "new_lead_assigned",
      "zz_last",
    ]);
    for (const t of json.templates) expect(t.status).toBe("APPROVED");
    // Real stored categories pass through; legacy rows without one
    // stay null so the UI can fall back instead of guessing.
    expect(json.templates.map((t) => t.category)).toEqual(["Utility", "Utility", null]);
    expect(json.sender_connected).toBe(true);
  });

  it("reports a disconnected sender without hiding templates", async () => {
    h.sender = null;
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      templates: unknown[];
      sender_connected: boolean;
    };
    expect(json.sender_connected).toBe(false);
    expect(json.templates).toHaveLength(3);
  });

  it("returns an empty list when nothing is approved", async () => {
    h.templates = h.templates.filter((t) => t.account_id !== "acct-1" || t.status !== "APPROVED");
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { templates: unknown[] };
    expect(json.templates).toEqual([]);
  });
});
