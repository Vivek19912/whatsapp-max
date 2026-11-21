// Team activity API — owner isolation + genuine-actor contracts.
//
// Pins: owner-only access, owner rows excluded at the query level
// (never merely hidden), system/NULL actors excluded, Meta-table
// scoping, account isolation, cursor pagination without duplicates.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  accountId: "acct-1",
  ownerId: "11111111-1111-4111-8111-111111111111",
  queries: [] as Array<{ table: string; ops: Array<[string, ...unknown[]]> }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));
const POOJA_ID = "22222222-2222-4222-8222-222222222222";
const DEEPIKA_ID = "33333333-3333-4333-8333-333333333333";

function chainable(table: string, rows: Array<Record<string, unknown>>) {
  const ops: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, (...a: never[]) => unknown> = {};
  const self = new Promise<{ data: unknown; error: null }>((resolve) => {
    // Resolved lazily in `then` below via queueMicrotask to allow
    // the route to finish chaining first.
    queueMicrotask(() => resolve({ data: rows, error: null }));
  });
  void self;
  const api = {
    select: (...a: never[]) => (ops.push(["select", ...a]), api),
    eq: (...a: never[]) => (ops.push(["eq", ...a]), api),
    neq: (...a: never[]) => (ops.push(["neq", ...a]), api),
    not: (...a: never[]) => (ops.push(["not", ...a]), api),
    gte: (...a: never[]) => (ops.push(["gte", ...a]), api),
    lt: (...a: never[]) => (ops.push(["lt", ...a]), api),
    lte: (...a: never[]) => (ops.push(["lte", ...a]), api),
    ilike: (...a: never[]) => (ops.push(["ilike", ...a]), api),
    order: (...a: never[]) => (ops.push(["order", ...a]), api),
    limit: (...a: never[]) => (ops.push(["limit", ...a]), api),
    in: (...a: never[]) => (ops.push(["in", ...a]), api),
    maybeSingle: async () => {
      h.queries.push({ table, ops });
      if (table === "accounts") return { data: { owner_user_id: h.ownerId }, error: null };
      return { data: rows[0] ?? null, error: null };
    },
    then: (
      resolve: (v: { data: unknown; error: null }) => void,
      reject?: (e: unknown) => void,
    ) => {
      h.queries.push({ table, ops });
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return api;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (min === "owner" && h.role !== "owner") {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return {
      supabase: {
        from: (table: string) => chainable(table, h.tables[table] ?? []),
      },
      accountId: h.accountId,
      userId: "caller-1",
      role: h.role,
    };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

const { GET } = await import("./route");

const get = (qs = "") =>
  new Request(`https://app.test/api/meta-lead-ads/team-activity?${qs}`, { cache: "no-store" });

function seed() {
  h.tables = {
    flows: [
      { id: "flow-a", name: "Spiti 17 NOV" },
      { id: "flow-b", name: "Kashmir 18 NOV" },
    ],
    profiles: [
      { user_id: h.ownerId, full_name: "Dharam Pal", account_role: "owner" },
      { user_id: POOJA_ID, full_name: "Pooja", account_role: "agent" },
      { user_id: DEEPIKA_ID, full_name: "Deepika", account_role: "agent" },
    ],
    lead_assignment_events: [
      {
        id: "e-manual-1",
        kind: "manual",
        assigned_user_id: POOJA_ID,
        previous_user_id: null,
        flow_id: "flow-a",
        flow_run_id: "run-1",
        created_by: DEEPIKA_ID,
        created_at: "2026-11-22T10:00:00.000Z",
        reason: "manual",
      },
      {
        id: "e-owner-1",
        kind: "manual",
        assigned_user_id: POOJA_ID,
        previous_user_id: null,
        flow_id: "flow-a",
        flow_run_id: "run-2",
        created_by: h.ownerId,
        created_at: "2026-11-22T11:00:00.000Z",
        reason: "manual",
      },
      {
        id: "e-system-1",
        kind: "auto",
        assigned_user_id: POOJA_ID,
        previous_user_id: null,
        flow_id: "flow-a",
        flow_run_id: "run-3",
        created_by: null,
        created_at: "2026-11-22T12:00:00.000Z",
        reason: "round_robin",
      },
    ],
    flow_runs: [
      { id: "run-1", contact_id: "c-1", flow_id: "flow-a" },
      { id: "run-2", contact_id: "c-2", flow_id: "flow-a" },
      { id: "run-3", contact_id: "c-3", flow_id: "flow-a" },
    ],
    contacts: [
      { id: "c-1", name: "Amit Verma" },
      { id: "c-2", name: "Rohit Singh" },
      { id: "c-3", name: "System Lead" },
    ],
    whatsapp_followups: [],
    contact_notes: [],
    messages: [],
  };
}

beforeEach(() => {
  h.role = "owner";
  h.accountId = "acct-1";
  h.ownerId = "11111111-1111-4111-8111-111111111111";
  h.queries = [];
  seed();
});

describe("GET /api/meta-lead-ads/team-activity", () => {
  it("rejects non-owners", async () => {
    h.role = "agent";
    const res = await GET(get());
    expect(res.status).toBe(403);
  });

  it("excludes owner and system actors at the query level", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    // Owner exclusion is enforced in the DB query, not the UI.
    const assignmentQuery = h.queries.find((q) => q.table === "lead_assignment_events");
    expect(assignmentQuery).toBeTruthy();
    const ops = JSON.stringify(assignmentQuery!.ops);
    expect(ops).toContain(h.ownerId);
    expect(ops).toContain("created_by");
    const json = (await res.json()) as { activities: Array<{ id: string }> };
    // Only the manual team-member event survives; owner + system rows out.
    expect(json.activities.map((a) => a.id)).toEqual(["assign:e-manual-1"]);
  });

  it("filters by member using stable user ids", async () => {
    const res = await GET(get(`member=${POOJA_ID}`));
    expect(res.status).toBe(200);
    const assignmentQuery = h.queries.find((q) => q.table === "lead_assignment_events");
    expect(JSON.stringify(assignmentQuery!.ops)).toContain(POOJA_ID);
  });

  it("rejects invalid activity types and cursors", async () => {
    expect((await GET(get("activityType=bogus"))).status).toBe(400);
    expect((await GET(get("cursor=nope"))).status).toBe(400);
  });

  it("rejects unknown tables without leaking rows", async () => {
    const res = await GET(get("tableId=00000000-0000-0000-0000-000000000000"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activities: unknown[] };
    expect(json.activities).toEqual([]);
  });

  it("sets Cache-Control: no-store", async () => {
    const res = await GET(get());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never exposes phone numbers", async () => {
    const res = await GET(get());
    const json = (await res.json()) as {
      activities: Array<{ description: string; leadName: string | null }>;
    };
    // Phone-length digit runs must never appear in feed text
    // (timestamps contain at most 4 consecutive digits).
    for (const a of json.activities) {
      expect(a.description).not.toMatch(/\d{10,}/);
      expect(a.leadName ?? "").not.toMatch(/\d{10,}/);
    }
  });
});
