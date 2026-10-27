// Pause + retry + notification-history routes for per-table
// assignment. Tenant isolation, role gating, and pause semantics.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  seq: 0,
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
    userId: h.userId,
    role: h.role,
  }),
  requireRole: async (min: string) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99)) throw statusError(403, "Forbidden");
    return { supabase: fakeSupabase(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeSupabase(),
}));

vi.mock("@/lib/meta-lead-ads/notify", () => ({
  maybeEnqueueLeadNotification: async () => ({ enqueued: true, reason: "enqueued" }),
}));

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function tableRows(table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "flows": return h.flows;
    case "lead_assignment_table_configs": return h.configs;
    case "lead_assignment_table_assignees": return h.assignees;
    case "profiles": return h.profiles;
    case "lead_assignment_table_config_state": return h.states;
    case "workspace_fields": return h.fields;
    case "workspace_values": return h.values;
    case "flow_runs": return h.runs;
    case "lead_assignment_events": return h.events;
    case "lead_assignment_notifications": return h.notifications;
    case "meta_lead_submissions": return [];
    default: return [];
  }
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    limitN: null as number | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
    deleteMode: false,
    upsertObj: null as Record<string, unknown> | null,
    upsertConflict: "",
  };
  const matched = () => {
    let rows = tableRows(state.table).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
    if (state.limitN !== null) rows = rows.slice(0, state.limitN);
    return rows;
  };
  const applyUpsert = (obj: Record<string, unknown>, conflict: string) => {
    const keys = conflict.split(",").map((k) => k.trim()).filter(Boolean);
    const existing =
      keys.length > 0
        ? tableRows(state.table).find((r) => keys.every((k) => r[k] === obj[k]))
        : undefined;
    if (existing) {
      Object.assign(existing, obj);
      return existing;
    }
    const defaults =
      state.table === "lead_assignment_table_config_state"
        ? { rr_cursor: 0, current_weights: {}, version: 0 }
        : {};
    const row = { id: `row-${++h.seq}`, ...defaults, ...obj };
    tableRows(state.table).push(row);
    return row;
  };
  const withDefaults = (r: Record<string, unknown>) =>
    state.table === "lead_assignment_table_config_state"
      ? { rr_cursor: 0, current_weights: {}, version: 0, ...r }
      : r;
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
    order: () => api,
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
    insert: (obj: Record<string, unknown> | Record<string, unknown>[]) => {
      state.insertRows = (Array.isArray(obj) ? obj : [obj]) as Array<Record<string, unknown>>;
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    delete: () => {
      state.deleteMode = true;
      return api;
    },
    upsert: (obj: Record<string, unknown>, opts?: { onConflict?: string }) => {
      state.upsertObj = obj;
      state.upsertConflict = opts?.onConflict ?? "";
      return api;
    },
    maybeSingle: async () => {
      if (state.upsertObj) {
        return { data: applyUpsert(state.upsertObj, state.upsertConflict), error: null };
      }
      if (state.insertRows) {
        const rows = state.insertRows.map((r) => {
          const row = withDefaults({ id: `row-${++h.seq}`, ...r });
          tableRows(state.table).push(row);
          return row;
        });
        return { data: rows[0] ?? null, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      if (state.deleteMode) {
        const list = matched();
        for (const r of list) {
          const arr = tableRows(state.table);
          arr.splice(arr.indexOf(r), 1);
        }
        return { data: list[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => {
      if (state.upsertObj) {
        return { data: applyUpsert(state.upsertObj, state.upsertConflict), error: null };
      }
      if (state.insertRows) {
        const rows = state.insertRows.map((r) => {
          const row = withDefaults({ id: `row-${++h.seq}`, ...r });
          tableRows(state.table).push(row);
          return row;
        });
        return { data: rows[0] ?? null, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.upsertObj) {
        return resolve({ data: [applyUpsert(state.upsertObj, state.upsertConflict)], error: null });
      }
      if (state.insertRows) {
        const rows = state.insertRows.map((r) => {
          const row = withDefaults({ id: `row-${++h.seq}`, ...r });
          tableRows(state.table).push(row);
          return row;
        });
        return resolve({ data: rows, error: null });
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      if (state.deleteMode) {
        const list = matched();
        for (const r of list) {
          const arr = tableRows(state.table);
          arr.splice(arr.indexOf(r), 1);
        }
        return resolve({ data: list, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.orderCol = null;
      state.limitN = null;
      state.insertRows = null;
      state.updateObj = null;
      state.deleteMode = false;
      state.upsertObj = null;
      state.upsertConflict = "";
      return api;
    },
  };
}

const pauseRoute = await import("./pause/route");
const retryRoute = await import("./retry/route");
const notificationsRoute = await import("./notifications/route");

const params = (flowId: string) => ({ params: Promise.resolve({ id: flowId }) });

function seed() {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.flows = [
    { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-1" },
  ];
  h.configs = [
    {
      id: "config-1",
      account_id: "acct-1",
      flow_id: "flow-meta",
      enabled: true,
      mode: "round_robin",
      timezone: "UTC",
      whatsapp_template_name: null,
      whatsapp_template_language: "en_US",
    },
  ];
  h.assignees = [
    {
      id: "a-asha",
      config_id: "config-1",
      user_id: "u-asha",
      display_name: "Asha",
      email: null,
      phone: null,
      position: 0,
      weight: 0,
      is_active: true,
      paused_until: null,
      pause_reason: null,
      pause_scope: "table",
      notify_email: true,
      notify_whatsapp: false,
    },
  ];
  h.profiles = [
    { user_id: "u-asha", account_id: "acct-1", account_role: "agent", full_name: "Asha", email: "asha@x.com" },
    { user_id: "owner-1", account_id: "acct-1", account_role: "owner", full_name: "Owner", email: "o@x.com" },
  ];
  h.states = [];
  h.fields = [
    { id: "f-1", account_id: "acct-1", flow_id: "flow-meta", name: "Assigned To" },
  ];
  h.values = [];
  h.runs = [{ id: "run-1", account_id: "acct-1", flow_id: "flow-meta" }];
  h.events = [];
  h.notifications = [
    {
      id: "n-1",
      account_id: "acct-1",
      config_id: "config-1",
      channel: "email",
      to_email: "asha@x.com",
      status: "failed",
      attempt: 3,
      last_error: "smtp down",
      created_at: new Date().toISOString(),
      flow_run_id: "run-1",
      assignee_id: "a-asha",
    },
  ];
  h.seq = 100;
}

function post(body: unknown) {
  return new Request("https://x/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(seed);

describe("POST pause — guards and semantics", () => {
  it("rejects non-owners and foreign tables", async () => {
    h.role = "agent";
    expect(
      (await pauseRoute.POST(post({ assignee_id: "a-asha", mode: "resume" }), params("flow-meta"))).status,
    ).toBe(403);
    h.role = "owner";
    expect(
      (await pauseRoute.POST(post({ assignee_id: "nope", mode: "resume" }), params("flow-meta"))).status,
    ).toBe(404);
  });

  it("pauses for N days and resumes, scoped to this assignee", async () => {
    const paused = await pauseRoute.POST(
      post({ assignee_id: "a-asha", mode: "days", days: 2, reason: "Leave" }),
      params("flow-meta"),
    );
    expect(paused.status).toBe(200);
    const row = h.assignees.find((a) => a.id === "a-asha")!;
    expect(row.paused_until).not.toBeNull();
    expect(Date.parse(row.paused_until as string)).toBeGreaterThan(Date.now());
    expect(row.pause_reason).toBe("Leave");

    const resumed = await pauseRoute.POST(
      post({ assignee_id: "a-asha", mode: "resume" }),
      params("flow-meta"),
    );
    expect(resumed.status).toBe(200);
    expect(h.assignees.find((a) => a.id === "a-asha")!.paused_until).toBeNull();
  });

  it("rejects invalid pause windows", async () => {
    for (const body of [
      { assignee_id: "a-asha", mode: "days", days: 0 },
      { assignee_id: "a-asha", mode: "until", until: "2000-01-01T00:00:00Z" },
      { assignee_id: "a-asha", mode: "someday" },
    ]) {
      expect((await pauseRoute.POST(post(body), params("flow-meta"))).status).toBeGreaterThanOrEqual(
        400,
      );
    }
  });

  it("ends 'today' at IST midnight even with a legacy stored zone", async () => {
    // Stored zone predates India-only assignment; the pause must
    // still expire at IST midnight, and the stored row keeps its
    // legacy value (normalization happens on read, not by rewrite).
    h.configs[0].timezone = "America/New_York";
    const res = await pauseRoute.POST(
      post({ assignee_id: "a-asha", mode: "today" }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const row = h.assignees.find((a) => a.id === "a-asha")!;
    // IST midnight is 18:29:59.999Z — the same suffix on every date.
    expect(row.paused_until).toMatch(/T18:29:59\.999Z$/);
    expect(Date.parse(row.paused_until as string)).toBeGreaterThan(Date.now());
    expect(h.configs[0].timezone).toBe("America/New_York");
  });

  it("interprets a zone-less 'until' wall reading as IST", async () => {
    // IST wall of a minute-aligned instant ~30 days out: feeding it
    // back must return the same instant (10:00 IST wall = 04:30Z).
    const target = Math.floor((Date.now() + 30 * 86400000) / 60000) * 60000;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(target));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const wall = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
    const res = await pauseRoute.POST(
      post({ assignee_id: "a-asha", mode: "until", until: wall }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    expect(h.assignees.find((a) => a.id === "a-asha")!.paused_until).toBe(
      new Date(target).toISOString(),
    );
  });
});

describe("POST retry — table-scoped reassignment guard", () => {
  it("requires agent+ and an enabled config on this table", async () => {
    h.role = "viewer";
    expect(
      (await retryRoute.POST(post({ run_id: "run-1" }), params("flow-meta"))).status,
    ).toBe(403);
    h.role = "agent";
    expect(
      (await retryRoute.POST(post({ run_id: "missing" }), params("flow-meta"))).status,
    ).toBe(404);
    h.configs[0].enabled = false;
    expect(
      (await retryRoute.POST(post({ run_id: "run-1" }), params("flow-meta"))).status,
    ).toBe(409);
    h.configs[0].enabled = true;
  });

  it("assigns the lead and never touches Sheets", async () => {
    h.role = "agent";
    const res = await retryRoute.POST(post({ run_id: "run-1" }), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      assignment: { outcome: string; userId: string | null };
    };
    expect(json.assignment.outcome).toBe("assigned");
    expect(json.assignment.userId).toBe("u-asha");
    expect(h.values.find((v) => v.flow_run_id === "run-1")?.value_text).toBe("u-asha");
    expect(
      h.events.find((e) => e.flow_run_id === "run-1" && e.kind === "auto"),
    ).toBeDefined();
  });
});

describe("GET notifications — owner-only delivery history", () => {
  it("rejects agents and lists failures for owners", async () => {
    h.role = "agent";
    expect(
      (await notificationsRoute.GET(new Request("https://x/"), params("flow-meta"))).status,
    ).toBe(403);
    h.role = "owner";
    const res = await notificationsRoute.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      notifications: Array<{ status: string; last_error: string | null }>;
    };
    expect(json.notifications).toHaveLength(1);
    expect(json.notifications[0].status).toBe("failed");
    expect(json.notifications[0].last_error).toBe("smtp down");
  });
});
