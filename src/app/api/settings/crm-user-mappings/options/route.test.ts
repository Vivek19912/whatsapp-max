import { afterEach, describe, expect, it, vi } from "vitest";

// The salesperson dropdown must be tenant-scoped server-side: the
// route forwards the account owner's email as the Travel CRM locator
// and never accepts a company/tenant identifier from the browser.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: "admin",
  accountId: "acct-1",
  profiles: [] as Row[],
  mappings: [] as Row[],
  lookups: {
    assignableUsers: [
      { id: "crm-a1", fullName: "Alpha Sales", username: "asales", email: "a@alpha.test" },
    ],
  } as Record<string, unknown>,
  lastLookupsUrl: "",
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    }
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: "u-owner", role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: "error" }, { status });
  },
}));

vi.mock("@/lib/integrations/travel-crm/config", () => ({
  getTravelCrmConfig: () => ({ baseUrl: "https://crm.example.com", secret: "wacrm_secret_123" }),
}));

vi.mock("@/lib/integrations/travel-crm/account-owner", () => ({
  resolveAccountOwnerEmail: async () => "owner@acme.com",
}));

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const store = table === "profiles" ? h.profiles : h.mappings;
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    q.then = (resolve: (v: unknown) => void) =>
      resolve({ data: store.filter((r) => filters.every((f) => f(r))), error: null });
    return q;
  };
  return api;
}

function mockLookupsFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    h.lastLookupsUrl = String(url);
    return new Response(JSON.stringify({ success: true, data: h.lookups }), { status: 200 });
  }) as typeof fetch);
}

const { GET } = await import("./route");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("crm-user-mappings options tenant scoping", () => {
  it("forwards the server-resolved owner email as the CRM locator", async () => {
    h.role = "admin";
    h.profiles = [
      { account_id: "acct-1", user_id: "u-owner", full_name: "Owner", email: "owner@acme.com", account_role: "owner" },
    ];
    h.mappings = [];
    mockLookupsFetch();

    const res = await GET();
    expect(res.status).toBe(200);
    // Tenant resolution travels in the server-built query string —
    // derived from the account's own rows, never browser input.
    expect(h.lastLookupsUrl).toContain("assignedToEmail=owner%40acme.com");
    const json = await res.json();
    expect(json.crm_users).toEqual([
      { id: "crm-a1", fullName: "Alpha Sales", username: "asales", email: "a@alpha.test" },
    ]);
    expect(json.wacrm_users).toEqual([
      { id: "u-owner", name: "Owner", email: "owner@acme.com", role: "owner", has_mapping: false },
    ]);
  });

  it("ignores any browser-supplied company identifier", async () => {
    h.role = "admin";
    h.profiles = [
      { account_id: "acct-1", user_id: "u-owner", full_name: "Owner", email: "owner@acme.com", account_role: "owner" },
    ];
    h.mappings = [];
    mockLookupsFetch();

    // Even with a spoofed tenant hint in the URL, the route must not
    // forward it — the request takes no input at all.
    const res = await GET();
    expect(res.status).toBe(200);
    expect(h.lastLookupsUrl).not.toContain("company");
    expect(h.lastLookupsUrl).not.toContain("evil");
    expect(h.lastLookupsUrl).toContain("assignedToEmail=owner%40acme.com");
  });

  it("403s non-admin callers before any upstream call", async () => {
    h.role = "agent";
    h.profiles = [];
    h.mappings = [];
    h.lastLookupsUrl = "";
    mockLookupsFetch();
    const res = await GET();
    expect(res.status).toBe(403);
    expect(h.lastLookupsUrl).toBe("");
  });
});
