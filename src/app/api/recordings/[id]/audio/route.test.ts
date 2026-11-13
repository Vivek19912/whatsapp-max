import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "agent-1",
  role: "owner",
  row: null as null | {
    storage_bucket: string;
    storage_path: string;
    file_name: string;
    uploaded_by: string | null;
  },
  signCalled: false,
}));

function fakeSupabase() {
  const api: Record<string, (...args: never[]) => unknown> = {};
  api.select = () => api;
  api.eq = () => api;
  api.maybeSingle = async () => ({ data: h.row, error: null });
  return {
    from: () => api,
    storage: {
      from: () => ({
        createSignedUrl: async () => {
          h.signCalled = true;
          return { data: { signedUrl: "https://cdn.test/signed" }, error: null };
        },
      }),
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
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status }
    );
  },
}));

const { GET } = await import("./route");

function ownRow() {
  return {
    storage_bucket: "call-recordings",
    storage_path: "account-acct-1/1.ogg",
    file_name: "1.ogg",
    uploaded_by: "agent-1",
  };
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "agent-1";
  h.role = "owner";
  h.row = ownRow();
  h.signCalled = false;
});

describe("GET /api/recordings/[id]/audio agent scoping", () => {
  it("owners can stream any recording in the account", async () => {
    h.role = "owner";
    h.row = { ...ownRow(), uploaded_by: "someone-else" };
    const res = await GET(
      new Request("https://app.test/api/recordings/r-1/audio"),
      { params: Promise.resolve({ id: "r-1" }) }
    );
    expect(res.status).toBe(307);
    expect(h.signCalled).toBe(true);
  });

  it("agents can stream their own recordings", async () => {
    h.role = "agent";
    const res = await GET(
      new Request("https://app.test/api/recordings/r-1/audio"),
      { params: Promise.resolve({ id: "r-1" }) }
    );
    expect(res.status).toBe(307);
    expect(h.signCalled).toBe(true);
  });

  it("agents get 404 (never a signed URL) for another agent's recording", async () => {
    h.role = "agent";
    h.row = { ...ownRow(), uploaded_by: "someone-else" };
    const res = await GET(
      new Request("https://app.test/api/recordings/r-1/audio"),
      { params: Promise.resolve({ id: "r-1" }) }
    );
    expect(res.status).toBe(404);
    expect(h.signCalled).toBe(false);
  });

  it("agents get 404 for recordings without attributable ownership", async () => {
    h.role = "agent";
    h.row = { ...ownRow(), uploaded_by: null };
    const res = await GET(
      new Request("https://app.test/api/recordings/r-1/audio"),
      { params: Promise.resolve({ id: "r-1" }) }
    );
    expect(res.status).toBe(404);
    expect(h.signCalled).toBe(false);
  });

  it("missing recordings still 404", async () => {
    h.role = "agent";
    h.row = null;
    const res = await GET(
      new Request("https://app.test/api/recordings/nope/audio"),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(res.status).toBe(404);
    expect(h.signCalled).toBe(false);
  });
});
