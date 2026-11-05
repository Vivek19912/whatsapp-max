import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "admin" as string | null,
  accountId: "acct-1",
  account: {
    id: "acct-1",
    reminder_template_name: null,
    reminder_template_language: null,
  } as Record<string, unknown> | null,
  template: {
    name: "reminder_fallback",
    language: "en_US",
    status: "APPROVED",
    body_text: "Reminder: {{1}}",
  } as Record<string, unknown> | null,
  writes: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: "admin-1",
    role: h.role,
  }),
  requireRole: async (min: string) => {
    if (!h.role) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: "admin-1", role: h.role };
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
  const state = { table: "" };
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    state.table = table;
    return api;
  };
  api.select = (..._args: unknown[]) => api;
  api.eq = () => api;
  api.maybeSingle = async () => {
    if (state.table === "accounts") return { data: h.account, error: null };
    if (state.table === "message_templates") {
      return { data: h.template, error: null };
    }
    return { data: null, error: null };
  };
  api.update = (patch: Record<string, unknown>) => {
    h.writes.push({ table: state.table, patch });
    if (state.table === "accounts" && h.account) {
      Object.assign(h.account, patch);
    }
    return api;
  };
  return api;
}

const { GET, PUT } = await import("./route");

function put(body: unknown) {
  return PUT(
    new Request("https://app.test/api/account/reminder-template", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get() {
  return GET();
}

beforeEach(() => {
  h.role = "admin";
  h.account = {
    id: "acct-1",
    reminder_template_name: null,
    reminder_template_language: null,
  };
  h.template = {
    name: "reminder_fallback",
    language: "en_US",
    status: "APPROVED",
    body_text: "Reminder: {{1}}",
  };
  h.writes = [];
});

describe("GET reminder-template setting", () => {
  it("returns nulls when unconfigured", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      template_name: null,
      template_language: null,
    });
  });
});

describe("PUT reminder-template setting", () => {
  it("stores a valid APPROVED single-variable template", async () => {
    const res = await put({ template_name: "reminder_fallback", template_language: "en_US" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      template_name: "reminder_fallback",
      template_language: "en_US",
    });
    expect(h.account?.reminder_template_name).toBe("reminder_fallback");
  });

  it("clears the setting on null", async () => {
    h.account = {
      id: "acct-1",
      reminder_template_name: "reminder_fallback",
      reminder_template_language: "en_US",
    };
    const res = await put({ template_name: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ template_name: null, template_language: null });
  });

  it("rejects unknown, unapproved, and multi-variable templates", async () => {
    h.template = null;
    expect(
      (await put({ template_name: "ghost", template_language: "en_US" })).status,
    ).toBe(400);

    // Unapproved template:
    h.template = {
      name: "reminder_fallback",
      language: "en_US",
      status: "PENDING",
      body_text: "Reminder: {{1}}",
    };
    expect(
      (await put({ template_name: "reminder_fallback", template_language: "en_US" })).status,
    ).toBe(400);

    h.template = {
      name: "reminder_fallback",
      language: "en_US",
      status: "APPROVED",
      body_text: "Static text, no variables",
    };
    expect(
      (await put({ template_name: "reminder_fallback", template_language: "en_US" })).status,
    ).toBe(400);

    h.template = {
      name: "reminder_fallback",
      language: "en_US",
      status: "APPROVED",
      body_text: "{{1}} and {{2}}",
    };
    expect(
      (await put({ template_name: "reminder_fallback", template_language: "en_US" })).status,
    ).toBe(400);
    expect(h.writes).toHaveLength(0);
  });

  it("rejects viewers and bad bodies", async () => {
    h.role = "viewer";
    expect(
      (await put({ template_name: "reminder_fallback" })).status,
    ).toBe(403);
    h.role = "admin";
    expect((await put("nope")).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });
});
