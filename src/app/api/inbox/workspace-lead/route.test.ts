import { beforeEach, describe, expect, it, vi } from "vitest";

const C1 = "123e4567-e89b-12d3-a456-426614174001";
const FLOW = "123e4567-e89b-12d3-a456-426614174002";
const RUN = "123e4567-e89b-12d3-a456-426614174003";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  contact: null as Record<string, unknown> | null,
  submissions: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  flow: null as Record<string, unknown> | null,
  errorAt: null as string | null,
}));

function fakeSupabase() {
  const state = {
    table: "",
    eqs: [] as Array<[string, unknown]>,
    inList: [] as Array<[string, unknown[]]>,
  };
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    state.eqs.push([col, val]);
    return builder;
  };
  builder.in = (col: string, vals: unknown[]) => {
    state.inList.push([col, vals]);
    return builder;
  };
  builder.order = () => builder;
  builder.limit = () => builder;
  builder.maybeSingle = async () => {
    if (h.errorAt === state.table) throw new Error("db down");
    if (state.table === "contacts") {
      const hit =
        h.contact &&
        state.eqs.every(([c, v]) => (h.contact as Record<string, unknown>)[c] === v)
          ? h.contact
          : null;
      return { data: hit, error: null };
    }
    if (state.table === "flows") {
      const hit =
        h.flow &&
        state.eqs.every(([c, v]) => (h.flow as Record<string, unknown>)[c] === v)
          ? h.flow
          : null;
      return { data: hit, error: null };
    }
    return { data: null, error: null };
  };
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (h.errorAt === state.table) throw new Error("db down");
    if (state.table === "meta_lead_submissions")
      return resolve({ data: matched(h.submissions), error: null });
    if (state.table === "flow_runs")
      return resolve({ data: matched(h.runs), error: null });
    return resolve({ data: [], error: null });
  };
  function matched(rows: Array<Record<string, unknown>>) {
    return rows.filter(
      (r) =>
        state.eqs.every(([c, v]) => r[c] === v) &&
        state.inList.every(([c, vals]) => vals.includes(r[c] as string))
    );
  }
  return {
    from: (table: string) => {
      state.table = table;
      state.eqs = [];
      state.inList = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return builder as any;
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: "user-1",
  }),
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status }
    );
  },
}));

const { GET } = await import("./route");

const url = (qs: string) =>
  new Request(`https://app.test/api/inbox/workspace-lead?${qs}`);

beforeEach(() => {
  h.accountId = "acct-1";
  h.contact = { id: C1, account_id: "acct-1", name: "Raman Kaushal" };
  h.submissions = [
    {
      id: "s-1",
      account_id: "acct-1",
      contact_id: C1,
      status: "processed",
      flow_run_id: RUN,
      meta_created_time: "2026-11-04T15:50:00.000Z",
      created_at: "2026-11-04T15:50:01.000Z",
    },
  ];
  h.runs = [{ id: RUN, account_id: "acct-1", flow_id: FLOW, contact_id: C1 }];
  h.flow = { id: FLOW, account_id: "acct-1", name: "Singapore Lead Ad - PVT Page-2" };
  h.errorAt = null;
});

describe("GET /api/inbox/workspace-lead", () => {
  it("resolves the exact lead and table through the verified chain", async () => {
    const res = await GET(url(`contact_id=${C1}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      linked: true,
      meta: true,
      contact_id: C1,
      contact_name: "Raman Kaushal",
      flow_id: FLOW,
      flow_name: "Singapore Lead Ad - PVT Page-2",
    });
  });

  it("400s a malformed contact id", async () => {
    expect((await GET(url("contact_id=nope"))).status).toBe(400);
    expect((await GET(url(""))).status).toBe(400);
  });

  it("404s a foreign contact with no cross-tenant oracle", async () => {
    h.contact = null;
    const res = await GET(url(`contact_id=${C1}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Contact not found" });
  });

  it("reports meta:false when no processed submission exists", async () => {
    h.submissions = [
      {
        id: "s-9",
        account_id: "acct-1",
        contact_id: C1,
        status: "ignored",
        flow_run_id: null,
        meta_created_time: "2026-11-04T15:50:00.000Z",
        created_at: "2026-11-04T15:50:01.000Z",
      },
    ];
    const res = await GET(url(`contact_id=${C1}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, meta: false });
  });

  it("reports meta:true unlinked when the run is gone", async () => {
    h.runs = [];
    const res = await GET(url(`contact_id=${C1}`));
    expect(await res.json()).toEqual({ linked: false, meta: true });
  });

  it("skips a run pointing at another contact (never trusts, never guesses)", async () => {
    h.runs = [{ id: RUN, account_id: "acct-1", flow_id: FLOW, contact_id: "c-evil" }];
    const res = await GET(url(`contact_id=${C1}`));
    expect(await res.json()).toEqual({ linked: false, meta: true });
  });

  it("prefers the most recent submission's live run deterministically", async () => {
    const RUN_OLD = "123e4567-e89b-12d3-a456-426614174004";
    const FLOW_OLD = "123e4567-e89b-12d3-a456-426614174005";
    h.submissions = [
      {
        id: "s-old",
        account_id: "acct-1",
        contact_id: C1,
        status: "processed",
        flow_run_id: RUN_OLD,
        meta_created_time: "2026-10-01T00:00:00.000Z",
        created_at: "2026-10-01T00:00:01.000Z",
      },
      {
        id: "s-new",
        account_id: "acct-1",
        contact_id: C1,
        status: "processed",
        flow_run_id: RUN,
        meta_created_time: "2026-11-04T15:50:00.000Z",
        created_at: "2026-11-04T15:50:01.000Z",
      },
    ];
    h.runs = [
      { id: RUN_OLD, account_id: "acct-1", flow_id: FLOW_OLD, contact_id: C1 },
      { id: RUN, account_id: "acct-1", flow_id: FLOW, contact_id: C1 },
    ];
    // Route orders newest-first; the mock preserves insertion
    // order, so reverse to simulate the database ordering.
    h.submissions.reverse();
    const res = await GET(url(`contact_id=${C1}`));
    const json = (await res.json()) as { flow_id: string };
    expect(json.flow_id).toBe(FLOW);
  });

  it("falls back to Untitled Flow for a blank flow name (id still exact)", async () => {
    h.flow = { id: FLOW, account_id: "acct-1", name: "   " };
    const res = await GET(url(`contact_id=${C1}`));
    const json = (await res.json()) as { flow_name: string; flow_id: string };
    expect(json.flow_name).toBe("Untitled Flow");
    expect(json.flow_id).toBe(FLOW);
  });
});
