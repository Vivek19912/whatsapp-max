import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: agents save/read ONLY their personal fallback template
// (profiles.* scoped to the authenticated user); owner/admin keep the
// account default (accounts.*) with identical validation.

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-A",
  accountRow: { reminder_template_name: "acct_default", reminder_template_language: "en_US" } as Record<string, unknown>,
  profiles: {
    "user-A": { reminder_template_name: null, reminder_template_language: null },
    "user-B": { reminder_template_name: null, reminder_template_language: null },
  } as Record<string, Record<string, unknown>>,
  templates: [
    { name: "acct_default", language: "en_US", status: "APPROVED", body_text: "Hi {{1}} bye" },
    { name: "agent_tpl", language: "en_US", status: "APPROVED", body_text: "Hey {{1}}" },
    { name: "bad_tpl", language: "en_US", status: "PENDING", body_text: "Hey {{1}}" },
  ] as Array<Record<string, unknown>>,
  writes: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status });
  },
}));

function fakeSupabase() {
  const state = { table: "", filters: [] as Array<[string, unknown]>, patch: null as Record<string, unknown> | null };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    update: (patch: Record<string, unknown>) => {
      state.patch = patch;
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "accounts") return { data: { ...h.accountRow }, error: null };
      if (state.table === "profiles") {
        const uid = state.filters.find(([c]) => c === "user_id")?.[1] as string;
        return { data: { ...(h.profiles[uid] ?? {}) }, error: null };
      }
      if (state.table === "message_templates") {
        const name = state.filters.find(([c]) => c === "name")?.[1];
        const lang = state.filters.find(([c]) => c === "language")?.[1];
        const row = h.templates.find((t) => t.name === name && t.language === lang) ?? null;
        return { data: row ? { ...row } : null, error: null };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.patch) {
        h.writes.push({ table: state.table, patch: state.patch, filters: [...state.filters] });
        if (state.table === "accounts") Object.assign(h.accountRow, state.patch);
        if (state.table === "profiles") {
          const uid = state.filters.find(([c]) => c === "user_id")?.[1] as string;
          Object.assign(h.profiles[uid], state.patch);
        }
      }
      resolve({ data: null, error: null });
    },
  };
  return { from: (table: string) => { state.table = table; return api; } };
}

const { GET, PUT } = await import("./route");

function put(body: unknown) {
  return new Request("https://app.test/api/account/reminder-template", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-A";
  h.accountRow = { reminder_template_name: "acct_default", reminder_template_language: "en_US" };
  h.profiles = {
    "user-A": { reminder_template_name: null, reminder_template_language: null },
    "user-B": { reminder_template_name: null, reminder_template_language: null },
  };
  h.writes = [];
});

describe("reminder-template agent isolation", () => {
  it("agent without a personal setting falls back to the account default", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ template_name: "acct_default", template_language: "en_US" });
  });

  it("agent saves ONLY their own personal setting (never the account row, never another agent)", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await PUT(put({ template_name: "agent_tpl", template_language: "en_US" }));
    expect(res.status).toBe(200);
    expect(h.profiles["user-A"]).toMatchObject({ reminder_template_name: "agent_tpl" });
    expect(h.profiles["user-B"]).toMatchObject({ reminder_template_name: null });
    expect(h.accountRow).toMatchObject({ reminder_template_name: "acct_default" });
    const wroteProfiles = h.writes.find((w) => w.table === "profiles");
    expect(wroteProfiles?.filters).toContainEqual(["user_id", "user-A"]);
  });

  it("Agent A's setting does not leak to Agent B (B still sees the account default)", async () => {
    h.userId = "user-A";
    h.role = "agent";
    await PUT(put({ template_name: "agent_tpl", template_language: "en_US" }));
    h.userId = "user-B";
    const res = await GET();
    expect(await res.json()).toEqual({ template_name: "acct_default", template_language: "en_US" });
  });

  it("admin writes the account default (existing behavior preserved)", async () => {
    h.userId = "admin-1";
    h.role = "admin";
    const res = await PUT(put({ template_name: "agent_tpl", template_language: "en_US" }));
    expect(res.status).toBe(200);
    expect(h.accountRow).toMatchObject({ reminder_template_name: "agent_tpl" });
    expect(h.writes.some((w) => w.table === "profiles")).toBe(false);
  });

  it("agent validation still rejects unapproved templates", async () => {
    h.userId = "user-A";
    h.role = "agent";
    const res = await PUT(put({ template_name: "bad_tpl", template_language: "en_US" }));
    expect(res.status).toBe(400);
    expect(h.profiles["user-A"]).toMatchObject({ reminder_template_name: null });
  });

  it("viewers stay read-only", async () => {
    h.userId = "viewer-1";
    h.role = "viewer";
    const res = await PUT(put({ template_name: "agent_tpl" }));
    expect(res.status).toBe(403);
  });
});
