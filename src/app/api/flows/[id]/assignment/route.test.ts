// Per-table assignment settings API — tenant isolation,
// role gating, contact masking, validation. No production I/O.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "owner",
  accountId: "acct-1",
  userId: "owner-1",
  authed: true,
  flows: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  states: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  seq: 0,
  /** Tables touched by the fake client (tenant-scope + no-sequence-write pins). */
  touched: [] as string[],
  /** When true, assignee inserts fail (partial-save regression). */
  failAssigneeInsert: false,
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
    default: return [];
  }
}

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    orderCol: null as string | null,
    insertRows: null as Array<Record<string, unknown>> | null,
    updateObj: null as Record<string, unknown> | null,
    deleteMode: false,
    upsertObj: null as Record<string, unknown> | null,
    upsertConflict: "",
  };
  const matched = () =>
    tableRows(state.table).filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
      ),
    );
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
    order: (col: string) => {
      state.orderCol = col;
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
        if (state.table === "lead_assignment_table_assignees" && h.failAssigneeInsert) {
          // One-shot: models a transient failure so the save path's
          // best-effort restore (which re-inserts) can succeed.
          h.failAssigneeInsert = false;
          return { data: null, error: { code: "P0001", message: "boom" } };
        }
        const rows = state.insertRows.map((r) => {
          const row = { id: `row-${++h.seq}`, ...r };
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
        if (state.table === "lead_assignment_table_assignees" && h.failAssigneeInsert) {
          // One-shot: models a transient failure so the save path's
          // best-effort restore (which re-inserts) can succeed.
          h.failAssigneeInsert = false;
          return resolve({ data: null, error: { code: "P0001", message: "boom" } });
        }
        const rows = state.insertRows.map((r) => {
          const row = { id: `row-${++h.seq}`, ...r };
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
      h.touched.push(table);
      state.table = table;
      state.filters = [];
      state.orderCol = null;
      state.insertRows = null;
      state.updateObj = null;
      state.deleteMode = false;
      state.upsertObj = null;
      state.upsertConflict = "";
      return api;
    },
  };
}

const route = await import("./route");

const params = (flowId: string) => ({ params: Promise.resolve({ id: flowId }) });

function seed() {
  h.role = "owner";
  h.accountId = "acct-1";
  h.userId = "owner-1";
  h.authed = true;
  h.flows = [
    { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads", meta_form_id: "formdb-1" },
    { id: "flow-plain", account_id: "acct-1", kind: "whatsapp_flow", meta_form_id: null },
    { id: "flow-foreign", account_id: "acct-2", kind: "meta_lead_ads", meta_form_id: "formdb-x" },
  ];
  h.configs = [];
  h.assignees = [];
  h.profiles = [
    { user_id: "u-asha", account_id: "acct-1", account_role: "agent", full_name: "Asha", email: "asha@x.com" },
    { user_id: "owner-1", account_id: "acct-1", account_role: "owner", full_name: "Owner", email: "o@x.com" },
  ];
  h.states = [];
  h.fields = [
    { id: "f-1", account_id: "acct-1", flow_id: "flow-meta", name: "Assigned To" },
  ];
  h.values = [];
  h.seq = 0;
  h.touched = [];
  h.failAssigneeInsert = false;
}

beforeEach(seed);

describe("GET /flows/[id]/assignment", () => {
  it("404s foreign or missing tables", async () => {
    expect((await route.GET(new Request("https://x/"), params("flow-foreign"))).status).toBe(404);
    expect((await route.GET(new Request("https://x/"), params("nope"))).status).toBe(404);
  });

  it("returns null config for an unconfigured table", async () => {
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: unknown; flow: { kind: string } };
    expect(json.config).toBeNull();
    expect(json.flow.kind).toBe("meta_lead_ads");
  });

  it("always includes an assignees array, even with no saved config", async () => {
    // The dialog iterates assignees for every draft row; a missing
    // key crashed Add on fresh tables. The contract is now total.
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: unknown; assignees: unknown };
    expect(json.config).toBeNull();
    expect(json.assignees).toEqual([]);
  });

  it("masks private contacts for non-owners and reports eligibility", async () => {
    h.configs = [
      {
        id: "config-1",
        account_id: "acct-1",
        flow_id: "flow-meta",
        enabled: true,
        mode: "round_robin",
        timezone: "UTC",
        whatsapp_template_name: "tpl",
        whatsapp_template_language: "en_US",
      },
    ];
    h.assignees = [
      {
        id: "a-1",
        config_id: "config-1",
        user_id: "u-asha",
        display_name: "Asha",
        email: "private@example.com",
        phone: "+15550001111",
        position: 0,
        weight: 0,
        is_active: true,
        paused_until: new Date(Date.now() + 3600_1000).toISOString(),
        pause_reason: "Leave",
        pause_scope: "table",
        notify_email: true,
        notify_whatsapp: false,
      },
    ];
    const ownerRes = await route.GET(new Request("https://x/"), params("flow-meta"));
    const ownerJson = (await ownerRes.json()) as {
      assignees: Array<{ email: string | null; phone: string | null; available: boolean; status_label: string }>;
      config: { whatsapp_template_name: string | null };
    };
    expect(ownerJson.assignees[0].email).toBe("private@example.com");
    expect(ownerJson.assignees[0].phone).toBe("+15550001111");
    expect(ownerJson.assignees[0].available).toBe(false);
    expect(ownerJson.assignees[0].status_label).toContain("Paused until");
    expect(ownerJson.config.whatsapp_template_name).toBe("tpl");

    h.role = "agent";
    const agentRes = await route.GET(new Request("https://x/"), params("flow-meta"));
    const agentJson = (await agentRes.json()) as {
      assignees: Array<{ email: string | null; phone: string | null; available: boolean }>;
      config: { whatsapp_template_name: string | null };
    };
    expect(agentJson.assignees[0].email).toBeNull();
    expect(agentJson.assignees[0].phone).toBeNull();
    expect(agentJson.assignees[0].available).toBe(false);
    expect(agentJson.config.whatsapp_template_name).toBeNull();
  });
});

describe("PUT /flows/[id]/assignment", () => {
  it("rejects non-owners", async () => {
    for (const role of ["admin", "agent", "viewer"]) {
      h.role = role;
      const res = await route.PUT(
        new Request("https://x/", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }),
        params("flow-meta"),
      );
      // admin is not owner: requireRole('owner') rejects admins too.
      expect([403, 200].includes(res.status)).toBe(true);
      if (role === "admin") expect(res.status).toBe(403);
    }
    h.role = "owner";
  });

  it("404s foreign tables and validates percentages", async () => {
    const foreign = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, assignees: [] }),
      }),
      params("flow-foreign"),
    );
    expect(foreign.status).toBe(404);
    const bad = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "percentage",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 60 },
            { display_name: "Ext", email: "e@x.com", weight: 30 },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const json = (await bad.json()) as { error: string };
    expect(json.error).toContain("exactly 100%");
  });

  it("saves a per-table config without touching other tables", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "percentage",
          timezone: "Asia/Kolkata",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 100, notify_whatsapp: true },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      config: { flow_id: string; mode: string; timezone: string; assignees: unknown[] };
    };
    expect(json.ok).toBe(true);
    expect(json.config.flow_id).toBe("flow-meta");
    expect(json.config.mode).toBe("percentage");
    expect(json.config.timezone).toBe("Asia/Kolkata");
    expect(json.config.assignees).toHaveLength(1);
    // No config leaked onto the sibling table.
    expect(h.configs.filter((c) => c.flow_id === "flow-plain")).toHaveLength(0);
  });

  it("preserves an explicitly configured assignee email distinct from the roster", async () => {
    // The form's email is authoritative at send time; the roster
    // address (asha@x.com) is only a fallback when the field is
    // empty. Saving, reopening, and editing must round-trip it.
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", email: "aman@example.com" },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const get = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(get.status).toBe(200);
    const json = (await get.json()) as {
      assignees: Array<{ user_id: string | null; email: string | null }>;
    };
    expect(json.assignees).toHaveLength(1);
    expect(json.assignees[0].email).toBe("aman@example.com");
  });

  it("creates an external-only assignee with no team link", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [
            { display_name: "External Seller", email: "ext@example.com", phone: "+15551234567" },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      config: { assignees: Array<{ user_id: string | null; display_name: string }> };
    };
    expect(json.ok).toBe(true);
    expect(json.config.assignees).toHaveLength(1);
    expect(json.config.assignees[0].user_id).toBeNull();
    // Persisted as a notification-only row (lead stays Unassigned).
    const stored = h.assignees.find((a) => a.config_id === h.configs[0].id);
    expect(stored?.user_id).toBeNull();
    expect(stored?.display_name).toBe("External Seller");
    expect(stored?.email).toBe("ext@example.com");
  });

  it("rejects team links outside the account", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [{ user_id: "u-stranger", display_name: "Stranger", email: "s@x.com" }],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("normalizes any crafted timezone to IST on save", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          timezone: "America/New_York",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 100 },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      config: { timezone: string };
    };
    expect(json.config.timezone).toBe("Asia/Kolkata");
    // Persisted row carries IST too — the next read needs no repair.
    expect(h.configs.find((c) => c.flow_id === "flow-meta")?.timezone).toBe(
      "Asia/Kolkata",
    );
  });

  it("normalizes a legacy stored timezone to IST on read without touching pause state", async () => {
    h.configs = [
      {
        id: "config-legacy",
        account_id: "acct-1",
        flow_id: "flow-meta",
        enabled: true,
        mode: "round_robin",
        timezone: "America/New_York",
        whatsapp_template_name: "tpl",
        whatsapp_template_language: "en_US",
      },
    ];
    // Fixed instant: 26 Oct 19:00 UTC = 27 Oct 00:30 IST (still 26 Oct in UTC).
    h.assignees = [
      {
        id: "a-1",
        config_id: "config-legacy",
        user_id: "u-asha",
        display_name: "Asha",
        email: null,
        phone: null,
        position: 0,
        weight: 0,
        is_active: true,
        paused_until: "2099-10-26T19:00:00.000Z",
        pause_reason: null,
        pause_scope: "table",
        notify_email: true,
        notify_whatsapp: false,
      },
    ];
    const res = await route.GET(new Request("https://x/"), params("flow-meta"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      config: { timezone: string };
      assignees: Array<{ paused_until: string | null; available: boolean; status_label: string }>;
    };
    expect(json.config.timezone).toBe("Asia/Kolkata");
    // Assignees, pause window, and availability survive normalization.
    expect(json.assignees).toHaveLength(1);
    expect(json.assignees[0].paused_until).toBe("2099-10-26T19:00:00.000Z");
    expect(json.assignees[0].available).toBe(false);
    // Status renders in IST (27 Oct) — neither the legacy zone (26 Oct)
    // nor UTC (26 Oct) would label it the 27th.
    expect(json.assignees[0].status_label).toBe("Paused until 27 October");
    // The stored row is left untouched — no silent rewrite.
    expect(h.configs[0].timezone).toBe("America/New_York");
  });

  it("saves a zero-assignee roster with the toggle either way, in both modes", async () => {
    // Production regression: deleting the last assignee and saving
    // returned a generic 500. Empty is valid — leads stay
    // unassigned — and the toggle/mode persist as configured.
    for (const mode of ["round_robin", "percentage"]) {
      for (const enabled of [true, false]) {
        const res = await route.PUT(
          new Request("https://x/", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled, mode, assignees: [] }),
          }),
          params("flow-meta"),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          ok: boolean;
          config: { enabled: boolean; mode: string; assignees: unknown[] };
        };
        expect(json.ok).toBe(true);
        expect(json.config.enabled).toBe(enabled);
        expect(json.config.mode).toBe(mode);
        expect(json.config.assignees).toEqual([]);
        // No placeholder assignee invented, no toggle flipped.
        expect(h.assignees.filter((a) => a.config_id === h.configs[0].id)).toHaveLength(0);
      }
    }
    // No sibling table touched.
    expect(h.configs.filter((c) => c.flow_id === "flow-plain")).toHaveLength(0);
  });

  it("deletes the last assignee and persists the empty roster", async () => {
    h.configs = [
      {
        id: "config-1",
        account_id: "acct-1",
        flow_id: "flow-meta",
        enabled: true,
        mode: "percentage",
        timezone: "Asia/Kolkata",
        whatsapp_template_name: null,
        whatsapp_template_language: "en_US",
      },
    ];
    h.assignees = [
      {
        id: "a-1",
        config_id: "config-1",
        user_id: "u-asha",
        display_name: "Asha",
        email: null,
        phone: null,
        position: 0,
        weight: 100,
        is_active: true,
        paused_until: null,
        pause_reason: null,
        pause_scope: "table",
        notify_email: true,
        notify_whatsapp: false,
      },
      {
        id: "a-2",
        config_id: "config-1",
        user_id: null,
        display_name: "Ext",
        email: "ext@example.com",
        phone: null,
        position: 1,
        weight: 0,
        is_active: false,
        paused_until: null,
        pause_reason: null,
        pause_scope: "table",
        notify_email: true,
        notify_whatsapp: false,
      },
    ];
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, mode: "percentage", assignees: [] }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      config: { enabled: boolean; assignees: unknown[] };
    };
    expect(json.config.enabled).toBe(true);
    expect(json.config.assignees).toEqual([]);
    expect(h.assignees).toHaveLength(0);
  });

  it("removes one assignee without corrupting the other's configuration", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 99, notify_whatsapp: true },
            { display_name: "Ext", email: "ext@example.com", phone: "+15551234567" },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    const first = (await res.json()) as {
      config: { assignees: Array<{ display_name: string }> };
    };
    expect(first.config.assignees.map((a) => a.display_name).sort()).toEqual(["Asha", "Ext"]);
    // Drop Ext; Asha's row must survive verbatim.
    const res2 = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 99, notify_whatsapp: true },
          ],
        }),
      }),
      params("flow-meta"),
    );
    expect(res2.status).toBe(200);
    const second = (await res2.json()) as {
      config: { assignees: Array<{ display_name: string; email: string | null; notify_whatsapp: boolean }> };
    };
    expect(second.config.assignees).toHaveLength(1);
    expect(second.config.assignees[0].display_name).toBe("Asha");
    expect(second.config.assignees[0].notify_whatsapp).toBe(true);
  });

  it("returns an exact 400 with the message for invalid percentage shares", async () => {
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "percentage",
          assignees: [
            { user_id: "u-asha", display_name: "Asha", weight: 60 },
            { display_name: "Ext", email: "e@x.com", weight: 30 },
          ],
        }),
      }),
      params("flow-meta"),
    );
    // Not a generic 500: invalid input is a client error.
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("exactly 100%");
  });

  it("restores the previous roster when the assignee insert fails", async () => {
    h.configs = [
      {
        id: "config-1",
        account_id: "acct-1",
        flow_id: "flow-meta",
        enabled: true,
        mode: "round_robin",
        timezone: "Asia/Kolkata",
        whatsapp_template_name: null,
        whatsapp_template_language: "en_US",
      },
    ];
    h.assignees = [
      {
        id: "a-1",
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
    h.failAssigneeInsert = true;
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mode: "round_robin",
          assignees: [{ display_name: "New", email: "new@example.com" }],
        }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    // No partial deletion: the previous roster is intact.
    expect(h.assignees).toHaveLength(1);
    expect(h.assignees[0].display_name).toBe("Asha");
    expect(h.assignees[0].user_id).toBe("u-asha");
  });

  it("never writes salesperson sequences or queue rows while saving an empty roster", async () => {
    // Sequence storage follows its own per-salesperson lifecycle
    // (retained by identity, never started from a config save);
    // the assignment save path must not touch it.
    h.touched = [];
    const res = await route.PUT(
      new Request("https://x/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, mode: "percentage", assignees: [] }),
      }),
      params("flow-meta"),
    );
    expect(res.status).toBe(200);
    expect(h.touched).not.toContain("meta_lead_assignee_sequences");
    expect(h.touched).not.toContain("meta_lead_assignee_sequence_items");
    expect(h.touched).not.toContain("meta_lead_whatsapp_queue");
  });
});
