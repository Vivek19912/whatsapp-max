import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  runs: {
    "run-1": { id: "run-1", account_id: "acct-1", flow_id: "flow-1" },
  } as Record<string, Record<string, unknown>>,
  fields: [
    { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To", field_type: "person" },
    { id: "f-fu", account_id: "acct-1", flow_id: "flow-1", name: "Next Follow-up Date & Time", field_type: "datetime" },
  ] as Array<Record<string, unknown>>,
  values: {
    "f-assign:run-1": "user-1",
    "f-fu:run-1": "2030-05-01T10:00:00.000Z",
  } as Record<string, string>,
  reminders: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status = err instanceof Error && "status" in err ? Number((err as { status: unknown }).status) || 500 : 500;
    return Response.json({ error: err instanceof Error ? err.message : "Internal server error" }, { status });
  },
}));

type Filter = { col: string; op: "eq" | "in" | "not-null"; val: unknown };

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    insertObj: null as Record<string, unknown> | null,
    updateObj: null as Record<string, unknown> | null,
    deleting: false,
  };
  function rows(): Array<Record<string, unknown>> {
    if (state.table === "flow_runs") return Object.values(h.runs);
    if (state.table === "workspace_fields") return h.fields;
    if (state.table === "workspace_values")
      return Object.entries(h.values).map(([key, value_text]) => {
        const [field_id, flow_run_id] = key.split(":");
        return { field_id, flow_run_id, account_id: h.accountId, value_text };
      });
    if (state.table === "whatsapp_followups") return h.reminders;
    return [];
  }
  const matched = () =>
    rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : f.op === "in" ? (f.val as unknown[]).includes(r[f.col]) : r[f.col] !== null,
      ),
    );
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push({ col, op: "in", val: vals });
      return api;
    },
    is: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    not: (col: string, _op: string, val: unknown) => {
      if (val === null) state.filters.push({ col, op: "not-null", val });
      return api;
    },
    insert: (obj: Record<string, unknown>) => {
      state.insertObj = obj;
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    delete: () => {
      state.deleting = true;
      return api;
    },
    maybeSingle: async () => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      if (state.deleting) {
        const list = matched();
        for (const r of list) {
          const key = `${r.field_id as string}:${r.flow_run_id as string}`;
          delete h.values[key];
        }
        return { data: null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      if (state.deleting) {
        const list = matched();
        for (const r of list) {
          const key = `${r.field_id as string}:${r.flow_run_id as string}`;
          delete h.values[key];
        }
        return resolve({ data: null, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.insertObj = null;
      state.updateObj = null;
      state.deleting = false;
      return api;
    },
  };
}

const { POST: complete } = await import("./route");
const { POST: reopen } = await import("../reopen/route");

function req(id: string) {
  return new Request(`https://app.test/api/followups/${id}/complete`, { method: "POST" });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seedReminder(over: Record<string, unknown> = {}) {
  const row = {
    id: "fu-1",
    account_id: h.accountId,
    recipient_phone: "919876543210",
    contact_id: null,
    scheduled_for: "2030-05-01T10:00:00.000Z",
    message_text: "Follow up",
    status: "scheduled",
    source_kind: "meta_workspace_followup",
    source_run_id: "run-1",
    created_by: "user-1",
    followup_completed_at: null,
    followup_completed_by: null,
    ...over,
  };
  h.reminders = [row];
  return row;
}

beforeEach(() => {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.values = { "f-assign:run-1": "user-1", "f-fu:run-1": "2030-05-01T10:00:00.000Z" };
  h.reminders = [];
});

describe("POST /api/followups/[id]/complete", () => {
  it("7/8. creator completes a scheduled reminder: cancels delivery + records completion + clears matching cell", async () => {
    seedReminder();
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ completed: true, status: "cancelled", cellCleared: true });
    const row = h.reminders[0];
    expect(row.status).toBe("cancelled");
    expect(row.followup_completed_at).toBeTruthy();
    expect(row.followup_completed_by).toBe("user-1");
    // Cell referred to this follow-up → deleted.
    expect(h.values["f-fu:run-1"]).toBeUndefined();
  });

  it("13/19. completion does not clear a newer follow-up cell", async () => {
    seedReminder();
    h.values["f-fu:run-1"] = "2030-06-01T10:00:00.000Z"; // re-scheduled after
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).cellCleared).toBe(false);
    expect(h.values["f-fu:run-1"]).toBe("2030-06-01T10:00:00.000Z");
  });

  it("10. completing a sent reminder preserves sent history", async () => {
    seedReminder({ status: "sent", scheduled_for: "2020-05-01T10:00:00.000Z" });
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    const row = h.reminders[0];
    expect(row.status).toBe("sent"); // never rewritten
    expect(row.followup_completed_at).toBeTruthy();
  });

  it("already-completed is idempotent, never duplicated", async () => {
    seedReminder({ status: "cancelled", followup_completed_at: "2030-01-01T00:00:00Z", followup_completed_by: "user-1" });
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).already).toBe(true);
  });

  it("15. unauthorized agent (not creator, not owner, not admin) gets 403", async () => {
    seedReminder({ created_by: "user-9" });
    h.userId = "user-2";
    h.values["f-assign:run-1"] = "user-1"; // run owned by someone else
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(403);
    expect(h.reminders[0].followup_completed_at).toBeNull();
  });

  it("lead owner (not creator) may complete the follow-up", async () => {
    seedReminder({ created_by: "user-9" });
    h.userId = "user-1"; // owns run-1 via Assigned To
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
  });

  it("admin may complete anything", async () => {
    seedReminder({ created_by: "user-9" });
    h.role = "admin";
    h.userId = "admin-1";
    const res = await complete(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/followups/[id]/reopen", () => {
  it("12. reopen clears only completion metadata, keeps delivery status", async () => {
    seedReminder({ status: "cancelled", followup_completed_at: "2030-01-01T00:00:00Z", followup_completed_by: "user-1" });
    const res = await reopen(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).reopened).toBe(true);
    expect(h.reminders[0].status).toBe("cancelled"); // untouched
    expect(h.reminders[0].followup_completed_at).toBeNull();
    expect(h.reminders).toHaveLength(1); // no duplicate reminder
  });

  it("reopen of a pending row is a no-op", async () => {
    seedReminder();
    const res = await reopen(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).already).toBe(true);
  });

  it("unauthorized reopen is forbidden", async () => {
    seedReminder({ created_by: "user-9", followup_completed_at: "2030-01-01T00:00:00Z" });
    h.userId = "user-2";
    h.values["f-assign:run-1"] = "user-1";
    const res = await reopen(req("fu-1"), params("fu-1"));
    expect(res.status).toBe(403);
  });
});
