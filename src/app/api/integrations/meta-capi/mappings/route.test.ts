// Meta Conversions API — mappings route.
//
// Guarantees: validation, tenant scoping, and duplicate-name handling.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  rows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  duplicate: false,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return { supabase: {}, accountId: h.accountId, userId: "u1" };
  },
  getCurrentAccount: async () => ({
    supabase: {},
    accountId: h.accountId,
    userId: "u1",
  }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  listMappings: async (_db: unknown, accountId: string) =>
    h.rows.filter((r) => r.account_id === accountId),
  insertMapping: async (_db: unknown, row: Record<string, unknown>) => {
    if (h.duplicate) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const created = {
      id: "m1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...row,
    };
    h.inserted.push(created);
    return created;
  },
}));

const { GET, POST } = await import("./route");

const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-capi/mappings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.rows = [];
  h.inserted = [];
  h.duplicate = false;
});

describe("POST /meta-capi/mappings", () => {
  it("creates a valid mapping for the caller's account", async () => {
    const res = await POST(
      post({
        name: "Lead enquiry",
        source_action: "meta_lead_received",
        meta_event_name: "Lead",
        enabled: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].account_id).toBe("acct-1");
  });

  it("rejects an unnamed mapping", async () => {
    const res = await POST(
      post({ source_action: "meta_lead_received", meta_event_name: "Lead" }),
    );
    expect(res.status).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });

  it("rejects a Purchase with no value/currency", async () => {
    const res = await POST(
      post({
        name: "Sale",
        source_action: "meta_lead_received",
        meta_event_name: "Purchase",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });

  it("maps a duplicate name to a 409", async () => {
    h.duplicate = true;
    const res = await POST(
      post({
        name: "Lead",
        source_action: "meta_lead_received",
        meta_event_name: "Lead",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("requires an admin role", async () => {
    h.roleOk = false;
    const res = await POST(
      post({ name: "x", source_action: "meta_lead_received", meta_event_name: "Lead" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /meta-capi/mappings", () => {
  it("returns only the caller's mappings", async () => {
    h.rows = [
      { id: "m1", account_id: "acct-1", name: "Mine" },
      { id: "m2", account_id: "acct-2", name: "Theirs" },
    ];
    const res = await GET();
    const json = (await res.json()) as { mappings: Array<{ name: string }> };
    expect(json.mappings.map((m) => m.name)).toEqual(["Mine"]);
  });
});
