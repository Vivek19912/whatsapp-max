import { beforeEach, describe, expect, it, vi } from "vitest";

// The team-performance route resolves the caller via
// getCurrentAccount and runs get_meta_leads_team_performance.
// We stub the account context and the RPC, then assert validation
// and the exact argument mapping (no account id ever sent).

const h = vi.hoisted(() => ({
  rpcArgs: null as Record<string, unknown> | null,
  rpcData: {} as Record<string, unknown>,
  rpcError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: {
      rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
        h.rpcArgs = args;
        return { data: h.rpcData, error: h.rpcError };
      }),
    },
    userId: "user-1",
    accountId: "acct-1",
    role: "owner",
    account: { id: "acct-1", name: "Acme" },
  }),
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

const { GET } = await import("./route");

const URL =
  "https://app.test/api/meta-lead-ads/team-performance?tz=UTC&formId=form-1&from=2026-11-01&to=2026-11-04&member=u1&stage=Qualified&type=Hot&search=ravi&page=2&pageSize=10";

beforeEach(() => {
  h.rpcArgs = null;
  h.rpcData = { members: [], summary: { total: 0, assigned: 0, unassigned: 0 } };
  h.rpcError = null;
});

describe("GET /api/meta-lead-ads/team-performance", () => {
  it("passes filters through to the RPC with no account id", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_form_id: "form-1",
      p_from: "2026-11-01",
      p_to: "2026-11-04",
      p_tz: "UTC",
      p_member: "u1",
      p_stage: "Qualified",
      p_type: "Hot",
      p_search: "ravi",
      p_page: 2,
      p_page_size: 10,
    });
    expect(h.rpcArgs).not.toHaveProperty("account_id");
    expect(h.rpcArgs).not.toHaveProperty("p_account_id");
  });

  it("treats absent filters as no-ops (aggregates-only call)", async () => {
    const res = await GET(new Request("https://app.test/api/meta-lead-ads/team-performance?tz=UTC"));
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({
      p_form_id: null,
      p_from: null,
      p_to: null,
      p_member: null,
      p_stage: null,
      p_type: null,
      p_search: null,
      p_page: 1,
      p_page_size: 25,
    });
  });

  it("rejects half date ranges, inverted ranges, and bad pagination", async () => {
    const base = "https://app.test/api/meta-lead-ads/team-performance?tz=UTC";
    expect((await GET(new Request(`${base}&from=2026-11-01`))).status).toBe(400);
    expect((await GET(new Request(`${base}&from=2026-11-04&to=2026-11-01`))).status).toBe(400);
    expect((await GET(new Request(`${base}&page=0`))).status).toBe(400);
    expect((await GET(new Request(`${base}&pageSize=101`))).status).toBe(400);
    expect((await GET(new Request(`${base}&from=not-a-date&to=2026-11-04`))).status).toBe(400);
  });

  it("caps page size at 100", async () => {
    const res = await GET(
      new Request(`https://app.test/api/meta-lead-ads/team-performance?tz=UTC&pageSize=100`)
    );
    expect(res.status).toBe(200);
    expect(h.rpcArgs).toMatchObject({ p_page_size: 100 });
  });

  it("surfaces RPC failures as 500 without leaking internals", async () => {
    h.rpcError = { message: "db down" };
    const res = await GET(new Request(URL));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load team lead performance" });
  });
});
