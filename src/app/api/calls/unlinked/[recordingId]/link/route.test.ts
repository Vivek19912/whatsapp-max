import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "user-1",
  role: "owner",
  // The recording row as the "database" sees it.
  recording: null as {
    id: string;
    account_id: string;
    contact_id: string | null;
    uploaded_by: string | null;
  } | null,
  // Contacts in THIS account.
  contacts: [] as Array<{ id: string }>,
  claimed: null as Record<string, unknown> | null,
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: h.contacts[0] ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      // call_recordings: update-claim and re-read.
      return {
        update: (obj: Record<string, unknown>) => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                select: async () => {
                  // Atomic claim: only an unlinked row of this account moves.
                  if (
                    h.recording &&
                    h.recording.account_id === h.accountId &&
                    h.recording.contact_id === null
                  ) {
                    h.recording = { ...h.recording, contact_id: obj.contact_id as string };
                    h.claimed = { ...h.recording };
                    return { data: [h.claimed], error: null };
                  }
                  return { data: [], error: null };
                },
              }),
            }),
          }),
        }),
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (h.recording && h.recording.account_id === h.accountId) {
                  return { data: h.recording, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
      };
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

const { POST } = await import("./route");

function linkReq(recordingId: string, body: unknown) {
  return [
    new Request(`https://app.test/api/calls/unlinked/${recordingId}/link`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ recordingId }) },
  ] as const;
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.role = "owner";
  h.recording = { id: "r-1", account_id: "acct-1", contact_id: null, uploaded_by: "user-1" };
  h.contacts = [{ id: "11111111-1111-1111-1111-111111111111" }];
  h.claimed = null;
});

const C1 = "11111111-1111-1111-1111-111111111111";
const C9 = "99999999-9999-9999-9999-999999999999";
const C_FOREIGN = "00000000-0000-0000-0000-000000000099";

describe("POST /api/calls/unlinked/[id]/link", () => {
  it("links an unlinked recording to an in-account contact", async () => {
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string; contact_id: string } };
    expect(json.data.contact_id).toBe(C1);
    expect(h.recording?.contact_id).toBe(C1);
  });

  it("rejects a non-UUID contact_id with 400", async () => {
    const [req, ctx] = linkReq("r-1", { contact_id: "not-a-uuid" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(h.recording?.contact_id).toBeNull();
  });

  it("404s a foreign contact (no cross-tenant link)", async () => {
    h.contacts = [];
    const [req, ctx] = linkReq("r-1", { contact_id: C_FOREIGN });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect(h.recording?.contact_id).toBeNull();
  });

  it("404s a foreign recording (no cross-tenant oracle)", async () => {
    h.recording = { id: "r-1", account_id: "acct-OTHER", contact_id: null, uploaded_by: "user-1" };
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it("409s an already-linked recording (lost race)", async () => {
    h.recording = { id: "r-1", account_id: "acct-1", contact_id: C9, uploaded_by: "user-1" };
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("This call has already been linked to a lead.");
    // The earlier link wins — never overwritten.
    expect(h.recording?.contact_id).toBe(C9);
  });

  it("agents can link their own unlinked recording", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    h.recording = { id: "r-1", account_id: "acct-1", contact_id: null, uploaded_by: "agent-1" };
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(h.recording?.contact_id).toBe(C1);
  });

  it("agents get 404 linking another agent's recording", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    h.recording = { id: "r-1", account_id: "acct-1", contact_id: null, uploaded_by: "agent-2" };
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect(h.recording?.contact_id).toBeNull();
  });

  it("agents get 404 linking recordings without attributable ownership", async () => {
    h.role = "agent";
    h.userId = "agent-1";
    h.recording = { id: "r-1", account_id: "acct-1", contact_id: null, uploaded_by: null };
    const [req, ctx] = linkReq("r-1", { contact_id: C1 });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect(h.recording?.contact_id).toBeNull();
  });
});
