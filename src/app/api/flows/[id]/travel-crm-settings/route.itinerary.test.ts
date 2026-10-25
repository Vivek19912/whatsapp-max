import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  authed: true,
  role: "viewer",
  accountId: "acct-1",
  userId: "user-1",
  flows: [] as Row[],
  settings: [] as Row[],
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId };
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

function fakeSupabase() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const rows = table === "flows" ? h.flows : h.settings;
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    const matched = () => rows.filter((r) => filters.every((f) => f(r)));
    q.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    q.single = async () => {
      const hit = matched()[0] ?? null;
      return hit
        ? { data: hit, error: null }
        : { data: null, error: { message: "no row", code: "PGRST116" } };
    };
    q.upsert = (obj: Row) => {
      const at = rows.findIndex(
        (r) => r.account_id === obj.account_id && r.flow_id === obj.flow_id,
      );
      const saved = { ...obj };
      if (at >= 0) rows[at] = { ...rows[at], ...saved };
      else rows.push(saved);
      return {
        select: () => ({ single: async () => ({ data: saved, error: null }) }),
      };
    };
    return q;
  };
  return api;
}

const { GET, PUT } = await import("./route");

function req(method: string, body?: unknown) {
  return new Request("https://app.test/api/flows/flow-1/travel-crm-settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "flow-1" }) };

beforeEach(() => {
  h.authed = true;
  h.role = "viewer";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.flows = [{ id: "flow-1", account_id: "acct-1" }];
  h.settings = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1. itinerary defaults save per account + flow", () => {
  it("saves rows with stable IDs and reads them back", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: [],
        itinerary: [
          { destination: "dest-sg", city: "city-marina", nights: 4 },
          { destination: "dest-bali", city: "city-kuta", nights: 3 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-bali", city: "city-kuta", nights: 3 },
      ],
      departure: null,
    });
    const reread = await GET(req("GET"), params);
    expect(await reread.json()).toEqual({
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-bali", city: "city-kuta", nights: 3 },
      ],
      departure: null,
    });
  });

  it("supports unlimited rows (many) and zero rows", async () => {
    h.role = "agent";
    const many = Array.from({ length: 10 }, (_, i) => ({
      destination: `dest-${i}`,
      city: `city-${i}`,
      nights: i + 1,
    }));
    const saved = await PUT(req("PUT", { services: [], itinerary: many }), params);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { itinerary: unknown[] }).itinerary).toHaveLength(10);
    const cleared = await PUT(req("PUT", { services: [], itinerary: [] }), params);
    expect(((await cleared.json()) as { itinerary: unknown[] }).itinerary).toEqual([]);
  });

  it("drops empty rows without rejecting the save", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: [],
        itinerary: [
          { destination: "", city: "", nights: "" },
          { destination: "dest-sg", city: "city-marina", nights: 4 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [],
      itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
      departure: null,
    });
  });

  it("rejects invalid nights", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: [],
        itinerary: [{ destination: "d", city: "c", nights: 0 }],
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(h.settings).toHaveLength(0);
  });

  it("accepts city-less rows (Destination + Nights only)", async () => {
    h.role = "agent";
    const res = await PUT(
      req("PUT", {
        services: [],
        itinerary: [
          { destination: "dest-sg", nights: 4 },
          { destination: "dest-bali", nights: "3" },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [],
      itinerary: [
        { destination: "dest-sg", city: "", nights: 4 },
        { destination: "dest-bali", city: "", nights: 3 },
      ],
      departure: null,
    });
  });

  it("reads back legacy city-carrying rows verbatim (load stays safe)", async () => {
    h.role = "agent";
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
      }),
      params,
    );
    const reread = await GET(req("GET"), params);
    expect(await reread.json()).toEqual({
      services: [],
      itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
      departure: null,
    });
  });

  it("services-only PUT preserves existing itinerary (backward compatible)", async () => {
    h.role = "agent";
    await PUT(
      req("PUT", {
        services: ["Hotel"],
        itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
      }),
      params,
    );
    await PUT(req("PUT", { services: ["Flight"] }), params);
    const reread = (await (await GET(req("GET"), params)).json()) as {
      services: string[];
      itinerary: unknown[];
    };
    expect(reread.services).toEqual(["Flight"]);
    expect(reread.itinerary).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
    ]);
  });
});

describe("2. different flows have different itinerary defaults", () => {
  it("isolates by flow", async () => {
    h.role = "agent";
    h.flows = [
      { id: "flow-1", account_id: "acct-1" },
      { id: "flow-2", account_id: "acct-1" },
    ];
    await PUT(
      req("PUT", {
        services: [],
        itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
      }),
      params,
    );
    const other = await GET(req("GET"), {
      params: Promise.resolve({ id: "flow-2" }),
    });
    expect(await other.json()).toEqual({ services: [], itinerary: [], departure: null });
  });
});

describe("14. existing Services Defaults still work alongside itinerary", () => {
  it("saves both together and services validation still rejects unknowns", async () => {
    h.role = "agent";
    const ok = await PUT(
      req("PUT", {
        services: ["Hotel", "Flight"],
        itinerary: [{ destination: "d", city: "c", nights: 2 }],
      }),
      params,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      services: ["Hotel", "Flight"],
      itinerary: [{ destination: "d", city: "c", nights: 2 }],
      departure: null,
    });
    const bad = await PUT(
      req("PUT", { services: ["Teleport"], itinerary: [] }),
      params,
    );
    expect(bad.status).toBe(400);
  });
});
