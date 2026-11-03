import { afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: "admin",
  accountId: "acct-1",
  userId: "u-owner",
  mappings: [] as Row[],
  profiles: [] as Row[],
  crmUsers: [
    { id: "crm-501", fullName: "Salesperson X", username: "salesx", email: "x@crm.test" },
    { id: "crm-502", fullName: "Salesperson Y", username: "salesy", email: "different@other.test" },
  ] as Row[],
  crmDown: false,
  configured: true,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status });
  },
}));

vi.mock("@/lib/integrations/travel-crm/config", () => ({
  getTravelCrmConfig: () => ({
    baseUrl: "https://crm.example.com",
    secret: h.configured ? "wacrm_secret_123" : null,
  }),
  travelCrmLeadUrl: (base: string, id: string) => `${base}/queries/${id}`,
}));

vi.mock("@/lib/integrations/travel-crm/account-owner", () => ({
  resolveAccountOwnerEmail: async () => "owner@acme.com",
}));

// The roster fetch goes through the shared client — stub at the network.
vi.mock("@/lib/integrations/travel-crm/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/integrations/travel-crm/client")>();
  return {
    ...mod,
    fetchTravelCrmLookups: async () => {
      if (h.crmDown) throw new Error("unreachable");
      return { assignableUsers: h.crmUsers };
    },
  };
});

function storeFor(table: string): Row[] {
  if (table === "crm_user_mappings") return h.mappings;
  if (table === "profiles") return h.profiles;
  return [];
}

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orderings: Array<{ col: string; asc: boolean }> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = (col: string, opts?: { ascending?: boolean }) => {
      orderings.push({ col, asc: opts?.ascending !== false });
      return q;
    };
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => {
      const rows = storeFor(table).filter((r) => filters.every((f) => f(r)));
      for (const o of orderings) {
        rows.sort((a, b) => {
          const av = String(a[o.col] ?? "");
          const bv = String(b[o.col] ?? "");
          return o.asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return rows;
    };
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.then = (resolve: (v: unknown) => void) => resolve({ data: matched(), error: null });
    q.insert = (obj: Row) => {
      const created = {
        id: `map-${storeFor(table).length + 1}`,
        created_at: "2026-11-02T00:00:00.000Z",
        updated_at: "2026-11-02T00:00:00.000Z",
        ...obj,
      };
      storeFor(table).push(created);
      return { select: () => ({ single: async () => ({ data: created, error: null }) }) };
    };
    q.update = (patch: Row) => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.select = () => ({
        single: async () => {
          const hit = matched()[0];
          if (!hit) return { data: null, error: { message: "no row" } };
          Object.assign(hit, patch);
          return { data: hit, error: null };
        },
      });
      return chain;
    };
    q.delete = () => {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        const rows = storeFor(table);
        for (const r of matched()) rows.splice(rows.indexOf(r), 1);
        resolve({ error: null });
      };
      return chain;
    };
    return q;
  };
  return api;
}

const { GET, POST } = await import("./route");
const { PATCH, DELETE } = await import("./[id]/route");

function seed() {
  h.role = "admin";
  h.mappings = [];
  h.crmDown = false;
  h.configured = true;
  h.crmUsers = [
    { id: "crm-501", fullName: "Salesperson X", username: "salesx", email: "x@crm.test" },
    { id: "crm-502", fullName: "Salesperson Y", username: "salesy", email: "different@other.test" },
  ];
  h.profiles = [
    { user_id: "u-owner", account_id: "acct-1", full_name: "Owner", email: "owner@acme.com", account_role: "owner", created_at: "2026-01-01" },
    { user_id: "u-agent", account_id: "acct-1", full_name: "Agent A", email: "agent-a@wacrm.test", account_role: "agent", created_at: "2026-01-02" },
  ];
}

function req(method: string, body?: unknown) {
  return new Request("https://app.test/api/settings/crm-user-mappings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CRM user mappings API", () => {
  it("lists mappings with resolved names and active status", async () => {
    seed();
    h.mappings = [
      {
        id: "map-1",
        account_id: "acct-1",
        wacrm_user_id: "u-agent",
        crm_user_id: "crm-502",
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    ];
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.mappings).toHaveLength(1);
    // Different emails across systems — joined by ID, not email.
    expect(json.mappings[0]).toMatchObject({
      wacrm_user_id: "u-agent",
      wacrm_name: "Agent A",
      wacrm_email: "agent-a@wacrm.test",
      crm_user_id: "crm-502",
      crm_name: "Salesperson Y",
      crm_email: "different@other.test",
      status: "active",
    });
  });

  it("flags a stale salesperson mapping instead of dropping it", async () => {
    seed();
    h.crmUsers = [h.crmUsers[0]!];
    h.mappings = [
      {
        id: "map-1",
        account_id: "acct-1",
        wacrm_user_id: "u-agent",
        crm_user_id: "crm-999",
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    ];
    const json = await (await GET()).json();
    expect(json.mappings[0].status).toBe("crm-user-removed");
  });

  it("creates a mapping after live CRM validation", async () => {
    seed();
    const res = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-501" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.mapping).toMatchObject({ wacrm_user_id: "u-agent", crm_user_id: "crm-501" });
    expect(h.mappings).toHaveLength(1);
  });

  it("409s a duplicate mapping for the same user", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const res = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-502" }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("MAPPING_EXISTS");
  });

  it("rejects a foreign CRM user id", async () => {
    seed();
    const res = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-evil-other-account" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CRM_USER_NOT_FOUND");
    expect(h.mappings).toHaveLength(0);
  });

  it("rejects a WACRM user outside the account", async () => {
    seed();
    const res = await POST(req("POST", { wacrm_user_id: "u-stranger", crm_user_id: "crm-501" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("WACRM_USER_NOT_FOUND");
  });

  it("updates the salesperson on PATCH with re-validation", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const res = await PATCH(req("PATCH", { crm_user_id: "crm-502" }), { params: Promise.resolve({ id: "map-1" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping.crm_user_id).toBe("crm-502");
  });

  it("404s PATCH for another workspace's row", async () => {
    seed();
    h.mappings = [
      { id: "map-9", account_id: "acct-OTHER", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const res = await PATCH(req("PATCH", { crm_user_id: "crm-502" }), { params: Promise.resolve({ id: "map-9" }) });
    expect(res.status).toBe(404);
  });

  it("deletes a mapping", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const res = await DELETE(req("DELETE"), { params: Promise.resolve({ id: "map-1" }) });
    expect(res.status).toBe(200);
    expect(h.mappings).toHaveLength(0);
  });

  it("403s agents on every mapping write and read", async () => {
    seed();
    h.role = "agent";
    expect((await GET()).status).toBe(403);
    expect((await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-501" }))).status).toBe(403);
    expect((await PATCH(req("PATCH", { crm_user_id: "crm-502" }), { params: Promise.resolve({ id: "x" }) })).status).toBe(403);
    expect((await DELETE(req("DELETE"), { params: Promise.resolve({ id: "x" }) })).status).toBe(403);
    expect(h.mappings).toHaveLength(0);
  });

  it("502s the create when Travel CRM is unreachable", async () => {
    seed();
    h.crmDown = true;
    const res = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-501" }));
    expect(res.status).toBe(502);
    expect(h.mappings).toHaveLength(0);
  });
});
