import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "wacrm_secret_123";
const BASE = "https://crm.example.com";

const h = vi.hoisted(() => ({
  authed: true,
  lookups: {} as Record<string, unknown>,
  fail: false,
  accountId: "acct-1",
  ownerEmails: { "acct-1": "owner@acct1.test" } as Record<string, string | null>,
  requested: [] as Array<{ url: string; authorization: string | null }>,
  resolveArgs: [] as Array<{ accountId: string }>,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) {
      const err = new Error("Unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    }
    return { supabase: {}, accountId: h.accountId, userId: "user-1" };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

vi.mock("@/lib/integrations/travel-crm/account-owner", () => ({
  resolveAccountOwnerEmail: async (_db: unknown, accountId: string) => {
    h.resolveArgs.push({ accountId });
    return h.ownerEmails[accountId] ?? null;
  },
}));

beforeEach(() => {
  h.authed = true;
  h.fail = false;
  h.accountId = "acct-1";
  h.ownerEmails = { "acct-1": "owner@acct1.test" };
  h.requested = [];
  h.resolveArgs = [];
  h.lookups = {
    destinations: [{ value: "dest-sg", label: "Singapore" }],
    cities: [{ value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" }],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/integrations/wacrm/lookups")) {
      h.requested.push({
        url: u,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (h.fail) {
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, data: h.lookups }), {
        status: 200,
      });
    }
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch);
  vi.stubEnv("TRAVEL_CRM_BASE_URL", BASE);
  vi.stubEnv("TRAVEL_CRM_INTEGRATION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const { GET } = await import("./route");

describe("GET /api/integrations/travel-crm/lookups (itinerary proxy)", () => {
  it("8. returns Travel CRM destinations/cities without the secret", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      success: true,
      destinations: [{ value: "dest-sg", label: "Singapore", countryName: null, privateName: null }],
      cities: [{ value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" }],
    });
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("degrades to empty (never fake) when Travel CRM is down", async () => {
    h.fail = true;
    const res = await GET();
    const json = (await res.json()) as {
      success: boolean;
      destinations: unknown[];
      cities: unknown[];
    };
    expect(json.success).toBe(false);
    expect(json.destinations).toEqual([]);
    expect(json.cities).toEqual([]);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("prefers master IDs over legacy display names (no duplicate Singapore)", async () => {
    const SG_ID = "11111111-2222-3333-4444-555555555555";
    const SENTOSA_ID = "22222222-3333-4444-5555-666666666666";
    h.lookups = {
      destinations: [{ value: SG_ID, label: "Singapore" }],
      cities: [{ value: SENTOSA_ID, label: "Sentosa", destinationValue: SG_ID }],
      countries: ["Singapore", "Thailand"],
      citiesByDestination: {},
    };
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      destinations: Array<{ value: string; label: string }>;
      cities: Array<{ value: string; label: string; destinationValue: string | null }>;
    };
    // Exactly one Singapore — the master ID entry, never the legacy name.
    // Metadata rides along untouched (null when the feed omits it).
    expect(json.destinations).toEqual([
      { value: SG_ID, label: "Singapore", countryName: null, privateName: null },
    ]);
    expect(json.cities).toEqual([
      { value: SENTOSA_ID, label: "Sentosa", destinationValue: SG_ID },
    ]);
  });

  it("forwards upstream countryName/privateName metadata for grouped dropdowns", async () => {
    const SG_ID = "11111111-2222-3333-4444-555555555555";
    h.lookups = {
      destinations: [
        { value: SG_ID, label: "Singapore", countryName: "Singapore", privateName: "Lion City" },
      ],
      cities: [],
      citiesByDestination: {},
    };
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      destinations: Array<Record<string, unknown>>;
    };
    expect(json.destinations).toEqual([
      { value: SG_ID, label: "Singapore", countryName: "Singapore", privateName: "Lion City" },
    ]);
  });

  it("sends the authenticated account owner email as the lookup locator", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    // Resolved from the authenticated account's own rows…
    expect(h.resolveArgs).toEqual([{ accountId: "acct-1" }]);
    // …and sent upstream as a query locator.
    expect(h.requested).toHaveLength(1);
    const upstream = new URL(h.requested[0]!.url);
    expect(upstream.searchParams.get("assignedToEmail")).toBe("owner@acct1.test");
    // The secret stays in Authorization only — never in the URL.
    expect(h.requested[0]!.authorization).toBe(`Bearer ${SECRET}`);
    expect(h.requested[0]!.url).not.toContain(SECRET);
  });

  it("ignores request input: only the account-resolved email is sent", async () => {
    // The proxy takes no request input; even a crafted inbound URL
    // cannot inject the locator.
    const res = await GET();
    expect(res.status).toBe(200);
    const upstream = new URL(h.requested[0]!.url);
    expect(upstream.searchParams.get("assignedToEmail")).toBe("owner@acct1.test");
  });

  it("falls back to a locator-free fetch when the owner email is unresolvable", async () => {
    h.ownerEmails = { "acct-1": null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(h.requested).toHaveLength(1);
    expect(h.requested[0]!.url).toBe(`${BASE}/api/integrations/wacrm/lookups`);
    expect(h.requested[0]!.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("keeps account isolation: each account sends its own owner email", async () => {
    h.ownerEmails = { "acct-1": "owner@acct1.test", "acct-2": "owner@acct2.test" };
    h.accountId = "acct-1";
    await GET();
    h.accountId = "acct-2";
    await GET();
    expect(h.requested).toHaveLength(2);
    expect(new URL(h.requested[0]!.url).searchParams.get("assignedToEmail")).toBe(
      "owner@acct1.test",
    );
    expect(new URL(h.requested[1]!.url).searchParams.get("assignedToEmail")).toBe(
      "owner@acct2.test",
    );
    expect(h.resolveArgs).toEqual([{ accountId: "acct-1" }, { accountId: "acct-2" }]);
  });
});
