import { afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  authed: true,
  scopeOk: true,
  accountId: "acct-1",
  mappings: [] as Row[],
  profiles: [] as Row[],
  crmUsers: [
    { id: "crm-501", fullName: "Salesperson X", username: "salesx", email: "x@crm.test" },
    { id: "crm-502", fullName: "Salesperson Y", username: "salesy", email: "y@crm.test" },
  ] as Row[],
  crmDown: false,
  configured: true,
}));

function apiError(code: string, status: number) {
  const err = new Error(code) as Error & { code: string; status: number };
  err.code = code;
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/api-context", () => ({
  requireApiKey: async (_req: Request, scope?: string) => {
    if (!h.authed) throw apiError("unauthorized", 401);
    if (scope && !h.scopeOk) throw apiError("forbidden", 403);
    return {
      authType: "api_key",
      supabase: fakeSupabase(),
      accountId: h.accountId,
      keyId: "key-1",
      scopes: ["crm-mappings:manage"],
      createdBy: "u-owner",
    };
  },
}));

vi.mock("@/lib/api/v1/respond", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/v1/respond")>();
  return {
    ...mod,
    toApiErrorResponse: (err: unknown) => {
      const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "internal";
      return Response.json({ error: { code, message: "err" } }, { status });
    },
  };
});

vi.mock("@/lib/integrations/travel-crm/config", () => ({
  getTravelCrmConfig: () => ({
    baseUrl: "https://crm.example.com",
    secret: h.configured ? "wacrm_secret_123" : null,
  }),
}));

vi.mock("@/lib/integrations/travel-crm/account-owner", () => ({
  resolveAccountOwnerEmail: async () => "owner@acme.com",
}));

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
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => storeFor(table).filter((r) => filters.every((f) => f(r)));
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
        created_at: "2026-11-03T00:00:00.000Z",
        updated_at: "2026-11-03T00:00:00.000Z",
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
          if (hit) Object.assign(hit, patch);
          return { data: hit ?? null, error: hit ? null : { message: "no row" } };
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

function req(method: string, body?: unknown, key = "wacrm_live_testkey") {
  return new Request("https://app.test/api/v1/crm-user-mappings", {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seed() {
  h.authed = true;
  h.scopeOk = true;
  h.accountId = "acct-1";
  h.mappings = [];
  h.crmDown = false;
  h.configured = true;
  h.profiles = [
    { user_id: "u-owner", account_id: "acct-1", full_name: "Owner", email: "owner@acme.com", account_role: "owner" },
    { user_id: "u-agent", account_id: "acct-1", full_name: "Agent A", email: "agent@wacrm.test", account_role: "agent" },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("v1 CRM user mappings (machine-to-machine)", () => {
  it("401s without a valid key and 403s without the scope", async () => {
    seed();
    h.authed = false;
    expect((await GET(req("GET"))).status).toBe(401);
    h.authed = true;
    h.scopeOk = false;
    expect((await GET(req("GET"))).status).toBe(403);
    expect(h.mappings).toHaveLength(0);
  });

  it("lists mappings with resolved names, status and workspace users", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.mappings).toHaveLength(1);
    expect(json.data.mappings[0]).toMatchObject({
      wacrm_name: "Agent A",
      crm_name: "Salesperson X",
      status: "active",
    });
    expect(json.data.wacrm_users.map((u: { id: string }) => u.id)).toEqual(
      expect.arrayContaining(["u-owner", "u-agent"]),
    );
    expect(json.data.crm_reachable).toBe(true);
  });

  it("creates a mapping scoped to the key's account", async () => {
    seed();
    const res = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-502" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.mapping).toMatchObject({
      wacrm_user_id: "u-agent",
      wacrm_name: "Agent A",
      crm_user_id: "crm-502",
      crm_name: "Salesperson Y",
      status: "active",
    });
  });

  it("rejects duplicates, foreign salespeople and non-members", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    expect(
      (await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-502" }))).status,
    ).toBe(409);
    const foreign = await POST(req("POST", { wacrm_user_id: "u-owner", crm_user_id: "crm-evil" }));
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("crm_user_not_found");
    const stranger = await POST(req("POST", { wacrm_user_id: "u-stranger", crm_user_id: "crm-501" }));
    expect(stranger.status).toBe(400);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe("wacrm_user_not_found");
  });

  it("never leaks another account's rows (no cross-tenant oracle)", async () => {
    seed();
    h.mappings = [
      { id: "map-9", account_id: "acct-OTHER", wacrm_user_id: "u-x", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const list = await (await GET(req("GET"))).json();
    expect(list.data.mappings).toHaveLength(0);
    expect(
      (await PATCH(req("PATCH", { crm_user_id: "crm-502" }), { params: Promise.resolve({ id: "map-9" }) })).status,
    ).toBe(404);
    expect(
      (await DELETE(req("DELETE"), { params: Promise.resolve({ id: "map-9" }) })).status,
    ).toBe(404);
    expect(h.mappings).toHaveLength(1);
  });

  it("updates and deletes own rows", async () => {
    seed();
    h.mappings = [
      { id: "map-1", account_id: "acct-1", wacrm_user_id: "u-agent", crm_user_id: "crm-501", created_at: "x", updated_at: "x" },
    ];
    const patch = await PATCH(req("PATCH", { crm_user_id: "crm-502" }), { params: Promise.resolve({ id: "map-1" }) });
    expect(patch.status).toBe(200);
    expect(h.mappings[0]!.crm_user_id).toBe("crm-502");
    const del = await DELETE(req("DELETE"), { params: Promise.resolve({ id: "map-1" }) });
    expect(del.status).toBe(200);
    expect(h.mappings).toHaveLength(0);
  });

  it("degrades gracefully when Travel CRM is unreachable", async () => {
    seed();
    h.crmDown = true;
    const list = await (await GET(req("GET"))).json();
    expect(list.data.crm_reachable).toBe(false);
    const create = await POST(req("POST", { wacrm_user_id: "u-agent", crm_user_id: "crm-501" }));
    expect(create.status).toBe(502);
    expect(h.mappings).toHaveLength(0);
  });
});
