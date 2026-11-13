import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "agent-1",
  role: "owner",
  recordings: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  eqFilters: [] as Array<[string, unknown]>,
}));

function rec(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    account_id: "acct-1",
    contact_id: null as string | null,
    conversation_id: null,
    uploaded_by: "u-9",
    storage_bucket: "call-recordings",
    storage_path: "account-acct-1/1-x.ogg",
    file_name: "x.ogg",
    mime_type: "audio/ogg",
    file_size: 1000,
    duration_seconds: 35,
    recorded_at: "2026-10-04T12:00:00.000Z",
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}

function chainable() {
  const api: Record<string, (...args: never[]) => unknown> = {};
  api.select = () => api;
  api.eq = (col: string, val: unknown) => {
    h.eqFilters.push([col, val]);
    return api;
  };
  api.is = () => api;
  api.order = () => api;
  api.range = async () => {
    // The mock only holds this account's rows; the route must still
    // filter contact_id IS NULL itself — emulate by returning what
    // the query would return: unlinked rows only, honoring the
    // ownership filter when the route applies one.
    const data = h.recordings.filter(
      (r) =>
        r.contact_id === null &&
        h.eqFilters.every(([c, v]) =>
          c === "uploaded_by" ? r.uploaded_by === v : true
        )
    );
    return {
      data,
      error: null,
      count: data.length,
    };
  };
  return api;
}

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            in: async () => ({ data: h.profiles, error: null }),
          }),
        };
      }
      return chainable();
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: h.userId,
    role: h.role,
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

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "agent-1";
  h.role = "owner";
  h.recordings = [];
  h.profiles = [{ user_id: "u-9", full_name: "Akash", email: "a@x.com" }];
  h.eqFilters = [];
});

describe("GET /api/calls/unlinked", () => {
  it("returns only contact_id IS NULL rows, newest first", async () => {
    h.recordings = [
      rec({ id: "r-old", recorded_at: "2026-10-03T00:00:00.000Z", created_at: "2026-10-03T00:00:00.000Z" }),
      rec({ id: "r-new", recorded_at: "2026-10-04T00:00:00.000Z", created_at: "2026-10-04T00:00:00.000Z" }),
      rec({ id: "r-linked", contact_id: "c-1" }),
    ];
    const res = await GET(new Request("https://app.test/api/calls/unlinked"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string; uploader_name: string | null }>;
      total: number;
    };
    expect(json.total).toBe(2);
    expect(json.recordings.map((r) => r.id)).toEqual(["r-new", "r-old"]);
    expect(json.recordings[0].uploader_name).toBe("Akash");
  });

  it("exposes no storage paths", async () => {
    h.recordings = [rec()];
    const res = await GET(new Request("https://app.test/api/calls/unlinked"));
    const json = (await res.json()) as { recordings: Array<Record<string, unknown>> };
    expect(json.recordings[0]).not.toHaveProperty("storage_path");
    expect(json.recordings[0]).not.toHaveProperty("storage_bucket");
  });

  it("agents see only their own unlinked queue", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    h.recordings = [
      rec({ id: "r-mine", uploaded_by: "agent-1" }),
      rec({ id: "r-theirs", uploaded_by: "u-9" }),
    ];
    const res = await GET(new Request("https://app.test/api/calls/unlinked"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recordings: Array<{ id: string }>; total: number };
    expect(json.recordings.map((r) => r.id)).toEqual(["r-mine"]);
    expect(json.total).toBe(1);
    expect(h.eqFilters).toContainEqual(["uploaded_by", "agent-1"]);
  });

  it("owners keep the full unlinked queue", async () => {
    h.role = "owner";
    h.recordings = [
      rec({ id: "r-1", uploaded_by: "agent-1" }),
      rec({ id: "r-2", uploaded_by: "u-9" }),
    ];
    const res = await GET(new Request("https://app.test/api/calls/unlinked"));
    const json = (await res.json()) as { recordings: Array<{ id: string }>; total: number };
    expect(json.total).toBe(2);
    expect(h.eqFilters.some(([c]) => c === "uploaded_by")).toBe(false);
  });
});
