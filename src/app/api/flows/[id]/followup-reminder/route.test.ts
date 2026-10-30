import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  role: "agent",
  accountId: "acct-1",
  userId: "user-1",
  flow: {
    id: "flow-meta",
    account_id: "acct-1",
    kind: "meta_lead_ads",
  } as Record<string, unknown> | null,
  runs: {
    "run-1": { id: "run-1", account_id: "acct-1", flow_id: "flow-meta" },
  } as Record<string, Record<string, unknown>>,
  fields: [
    {
      id: "f-followup",
      name: "Next Follow-up Date & Time",
      field_type: "datetime",
    },
  ] as Array<Record<string, unknown>>,
  values: {
    "f-followup:run-1": "2030-05-01T10:00:00.000Z",
  } as Record<string, string>,
  reminders: [] as Array<Record<string, unknown>>,
  agentProfile: { whatsapp_number: "+91 98765 43210" } as Record<
    string,
    unknown
  > | null,
  profileError: false,
  uniqueViolationOnce: false,
  seq: 0,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.authed) throw statusError(401, "Unauthorized");
    const rank: Record<string, number> = {
      viewer: 1,
      agent: 2,
      admin: 3,
      owner: 4,
    };
    if ((rank[h.role] ?? 0) < (rank[min] ?? 99))
      throw statusError(403, "Forbidden");
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
    };
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

type Filter = { col: string; op: "eq" | "in"; val: unknown };

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Filter[],
    insertObj: null as Record<string, unknown> | null,
    updateObj: null as Record<string, unknown> | null,
  };
  function rows(): Array<Record<string, unknown>> {
    if (state.table === "flows") return h.flow ? [h.flow] : [];
    if (state.table === "flow_runs") return Object.values(h.runs);
    if (state.table === "workspace_fields") return h.fields;
    if (state.table === "workspace_values")
      return Object.entries(h.values).map(([key, value_text]) => {
        const [field_id, flow_run_id] = key.split(":");
        return { field_id, flow_run_id, account_id: h.accountId, value_text };
      });
    if (state.table === "whatsapp_followups") return h.reminders;
    if (state.table === "profiles") return h.agentProfile ? [h.agentProfile] : [];
    return [];
  }
  const matched = () =>
    rows().filter((r) =>
      state.filters.every((f) =>
        f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
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
    insert: (obj: Record<string, unknown>) => {
      state.insertObj = obj;
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "profiles") {
        // The agent-number lookup is not the subject of these
        // tests: return the configured profile row verbatim (same
        // as the /api/followups test mock).
        if (h.profileError)
          return { data: null, error: { message: "column missing" } };
        return { data: h.agentProfile, error: null };
      }
      const list = matched();
      return { data: list[0] ?? null, error: null };
    },
    single: async () => {
      if (state.insertObj) {
        if (state.table === "whatsapp_followups" && h.uniqueViolationOnce) {
          h.uniqueViolationOnce = false;
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        h.seq += 1;
        const row = {
          id: `fu-${h.seq}`,
          attempts: 0,
          created_at: "2030-01-01T00:00:00Z",
          updated_at: "2030-01-01T00:00:00Z",
          ...state.insertObj,
        };
        if (state.table === "whatsapp_followups") h.reminders.push(row);
        return { data: row, error: null };
      }
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return { data: list[0] ?? null, error: null };
      }
      const list = matched();
      return { data: list[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.updateObj) {
        const list = matched();
        for (const r of list) Object.assign(r, state.updateObj);
        return resolve({ data: list, error: null });
      }
      return resolve({ data: matched(), error: null });
    },
  };
  return {
    from: (table: string) => {
      // One query builder per from(): filters and pending writes
      // never leak across queries on the same client.
      state.table = table;
      state.filters = [];
      state.insertObj = null;
      state.updateObj = null;
      return api;
    },
  };
}

const { GET, POST, DELETE } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/flows/flow-meta/followup-reminder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(body: unknown) {
  return new Request("https://app.test/api/flows/flow-meta/followup-reminder", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: "flow-meta" }) };
const FUTURE = "2030-05-01T10:00:00.000Z";

function reset() {
  h.authed = true;
  h.role = "agent";
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.flow = { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads" };
  h.runs = {
    "run-1": { id: "run-1", account_id: "acct-1", flow_id: "flow-meta" },
  };
  h.fields = [
    {
      id: "f-followup",
      account_id: "acct-1",
      flow_id: "flow-meta",
      name: "Next Follow-up Date & Time",
      field_type: "datetime",
    },
    {
      id: "f-assign",
      account_id: "acct-1",
      flow_id: "flow-meta",
      name: "Assigned To",
      field_type: "single_select",
    },
  ];
  h.values = {
    "f-followup:run-1": FUTURE,
    // run-1 belongs to the calling agent by default; individual
    // tests re-point or drop this to prove the ownership gate.
    "f-assign:run-1": "user-1",
  };
  h.reminders = [];
  h.agentProfile = { whatsapp_number: "+91 98765 43210" };
  h.profileError = false;
  h.uniqueViolationOnce = false;
  h.seq = 0;
}

beforeEach(reset);

describe("POST followup-reminder", () => {
  it("creates one linked reminder with the default message when blank", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "   ",
        lead_name: "Rahul Sharma",
        lead_phone: "+919999999999",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      reminder: Record<string, unknown>;
    };
    expect(json.reminder).toMatchObject({
      scheduled_for: FUTURE,
      status: "scheduled",
      created: true,
    });
    expect(json.reminder.message_text).toBe("Rahul Sharma, +919999999999");
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      account_id: "acct-1",
      recipient_phone: "919876543210",
      contact_id: null,
      conversation_id: null,
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
    });
  });

  it("saves a custom message unchanged", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call about the Dubai package — urgent!",
        lead_name: "Rahul",
        lead_phone: "+91111",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      reminder: Record<string, unknown>;
    };
    expect(json.reminder.message_text).toBe(
      "Call about the Dubai package — urgent!",
    );
  });

  it("re-saving the same follow-up updates in place (no duplicates)", async () => {
    const first = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "One" }),
      PARAMS,
    );
    expect(first.status).toBe(201);
    const second = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "One" }),
      PARAMS,
    );
    expect(second.status).toBe(200);
    const json = (await second.json()) as {
      reminder: Record<string, unknown>;
    };
    expect(json.reminder.created).toBe(false);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0].message_text).toBe("One");
  });

  it("editing the date or message updates the existing scheduled reminder", async () => {
    await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "One" }),
      PARAMS,
    );
    const id = h.reminders[0].id;
    const next = "2030-05-02T11:30:00.000Z";
    h.values["f-followup:run-1"] = next;
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: next, message: "Two" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      id,
      scheduled_for: next,
      message_text: "Two",
      status: "scheduled",
    });
  });

  it("re-arms a failed linked reminder instead of duplicating", async () => {
    h.reminders.push({
      id: "fu-old",
      account_id: "acct-1",
      status: "failed",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: "2030-01-01T00:00:00Z",
      message_text: "Old",
      failure_reason: "boom",
      failed_at: "2030-01-02T00:00:00Z",
    });
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "New" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      id: "fu-old",
      scheduled_for: FUTURE,
      message_text: "New",
      status: "scheduled",
      failure_reason: null,
      failed_at: null,
    });
  });

  it("creates a fresh reminder when the previous one was already sent", async () => {
    h.reminders.push({
      id: "fu-sent",
      account_id: "acct-1",
      status: "sent",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: "2030-01-01T00:00:00Z",
      message_text: "Old",
      sent_at: "2030-01-01T00:00:00Z",
    });
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "New" }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    expect(h.reminders).toHaveLength(2);
    expect(h.reminders[0]).toMatchObject({ id: "fu-sent", status: "sent" });
    expect(h.reminders[1]).toMatchObject({ status: "scheduled" });
  });

  it("recovers from a concurrent-insert race without duplicating", async () => {
    h.uniqueViolationOnce = true;
    h.reminders.push({
      id: "fu-winner",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Winner",
    });
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "Late" }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      id: "fu-winner",
      message_text: "Late",
    });
  });

  it("rejects past and invalid times without writing", async () => {
    // Stored cell values must match the payload (as a real save
    // would produce) so the request reaches time validation.
    h.values["f-followup:run-1"] = "2020-01-01T00:00:00.000Z";
    const past = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: "2020-01-01T00:00:00.000Z",
        message: "Past",
      }),
      PARAMS,
    );
    expect(past.status).toBe(400);
    expect(((await past.json()) as { error: string }).error).toMatch(/future/);
    h.values["f-followup:run-1"] = "not-a-date";
    const invalid = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: "not-a-date",
        message: "Bad",
      }),
      PARAMS,
    );
    expect(invalid.status).toBe(400);
    expect(h.reminders).toHaveLength(0);
  });

  it("rejects a stale dialog payload that no longer matches the cell", async () => {
    h.values["f-followup:run-1"] = "2030-06-01T09:00:00.000Z";
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "Stale" }),
      PARAMS,
    );
    expect(res.status).toBe(409);
    expect(h.reminders).toHaveLength(0);
  });

  it("404s Flow Tables and foreign flows", async () => {
    h.flow = { id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow" };
    const flowRes = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(flowRes.status).toBe(404);
    h.flow = { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads" };
    h.runs["run-x"] = {
      id: "run-x",
      account_id: "other-acct",
      flow_id: "flow-meta",
    };
    const runRes = await POST(
      post({ flow_run_id: "run-x", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(runRes.status).toBe(404);
    expect(h.reminders).toHaveLength(0);
  });

  it("400s when the follow-up column is missing", async () => {
    h.fields = [];
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(h.reminders).toHaveLength(0);
  });

  it("enforces auth, roles, and the agent-number requirement", async () => {
    h.authed = false;
    expect(
      (await POST(post({ flow_run_id: "run-1", scheduled_for: FUTURE }), PARAMS))
        .status,
    ).toBe(401);
    h.authed = true;
    h.role = "viewer";
    expect(
      (await POST(post({ flow_run_id: "run-1", scheduled_for: FUTURE }), PARAMS))
        .status,
    ).toBe(403);
    h.role = "agent";
    h.agentProfile = null;
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Reminder WhatsApp Number/,
    );
    expect(h.reminders).toHaveLength(0);
  });

  it("blocks teammates from a linked reminder but allows admins", async () => {
    h.reminders.push({
      id: "fu-mate",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "teammate-9",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Mate",
    });
    // The teammate owns the lead (passes the lead-ownership gate)
    // but not the reminder, so the creator-ownership 403 stands.
    h.values["f-assign:run-1"] = "user-2";
    h.userId = "user-2";
    const blocked = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(blocked.status).toBe(403);
    expect(h.reminders[0].message_text).toBe("Mate");
    h.role = "admin";
    const allowed = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "Admin" }),
      PARAMS,
    );
    expect(allowed.status).toBe(200);
    expect(h.reminders[0].message_text).toBe("Admin");
  });
});

describe("DELETE followup-reminder", () => {
  it("cancels the linked scheduled reminder on clear", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "x",
    });
    const res = await DELETE(del({ flow_run_id: "run-1" }), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled: true, id: "fu-1" });
    expect(h.reminders[0].status).toBe("cancelled");
  });

  it("leaves sent, failed, and manual reminders untouched", async () => {
    h.reminders.push(
      {
        id: "fu-sent",
        account_id: "acct-1",
        status: "sent",
        created_by: "user-1",
        source_kind: "meta_workspace_followup",
        source_run_id: "run-1",
        scheduled_for: FUTURE,
        message_text: "sent",
      },
      {
        id: "fu-manual",
        account_id: "acct-1",
        status: "scheduled",
        created_by: "user-1",
        scheduled_for: FUTURE,
        message_text: "manual",
      },
    );
    const res = await DELETE(del({ flow_run_id: "run-1" }), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled: false });
    expect(h.reminders.map((r) => r.status)).toEqual(["sent", "scheduled"]);
  });

  it("404s Flow Tables and 403s viewers and strangers", async () => {
    h.flow = { id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow" };
    expect(
      (await DELETE(del({ flow_run_id: "run-1" }), {
        params: Promise.resolve({ id: "flow-1" }),
      })).status,
    ).toBe(404);
    h.flow = { id: "flow-meta", account_id: "acct-1", kind: "meta_lead_ads" };
    h.role = "viewer";
    expect((await DELETE(del({ flow_run_id: "run-1" }), PARAMS)).status).toBe(
      403,
    );
  });
});

describe("agent ownership on Meta Lead Ads Tables", () => {
  it("404s creating a reminder for another agent's lead", async () => {
    h.values["f-assign:run-1"] = "u-teammate";
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(res.status).toBe(404);
    expect(h.reminders).toHaveLength(0);
  });

  it("404s creating a reminder for an unassigned lead", async () => {
    delete h.values["f-assign:run-1"];
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(res.status).toBe(404);
    expect(h.reminders).toHaveLength(0);
  });

  it("404s cancelling a reminder for another agent's lead", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "x",
    });
    h.values["f-assign:run-1"] = "u-teammate";
    const res = await DELETE(del({ flow_run_id: "run-1" }), PARAMS);
    expect(res.status).toBe(404);
    expect(h.reminders[0].status).toBe("scheduled");
  });

  it("lets admins act on any assigned Meta lead", async () => {
    h.role = "admin";
    h.userId = "admin-1";
    h.values["f-assign:run-1"] = "u-teammate";
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "x" }),
      PARAMS,
    );
    expect(res.status).toBe(201);
  });
});

describe("GET followup-reminder (prefill for the single modal)", () => {
  function get(runId: string | null) {
    const url =
      runId === null
        ? "https://app.test/api/flows/flow-meta/followup-reminder"
        : `https://app.test/api/flows/flow-meta/followup-reminder?flow_run_id=${runId}`;
    return GET(new Request(url), PARAMS);
  }

  it("returns the open linked reminder for prefill", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Custom note",
    });
    const res = await get("run-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reminder: {
        id: "fu-1",
        scheduled_for: FUTURE,
        message_text: "Custom note",
        status: "scheduled",
        recipient_phone: null,
      },
    });
  });

  it("returns null when no linked reminder exists", async () => {
    const res = await get("run-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reminder: null });
  });

  it("404s another agent's lead and requires a run id", async () => {
    h.values["f-assign:run-1"] = "u-teammate";
    expect((await get("run-1")).status).toBe(404);
    expect((await get(null)).status).toBe(400);
  });

  it("404s non-Meta tables", async () => {
    h.flow = { id: "flow-1", account_id: "acct-1", kind: "whatsapp_flow" };
    const res = await GET(
      new Request("https://app.test/api/flows/flow-1/followup-reminder?flow_run_id=run-1"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("per-reminder recipient override", () => {
  it("saves an explicit recipient different from Settings and marks it custom", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call",
        recipient_phone: "+91 91234 56789",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { reminder: Record<string, unknown> };
    expect(json.reminder.recipient_phone).toBe("919123456789");
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
    // The shared Settings value is untouched.
    expect(h.agentProfile).toEqual({ whatsapp_number: "+91 98765 43210" });
  });

  it("leaves non-custom snapshots when the number matches Settings", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call",
        recipient_phone: "919876543210",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    expect(h.reminders[0]).toMatchObject({
      recipient_phone: "919876543210",
      recipient_custom: false,
    });
  });

  it("rejects an invalid recipient without writing anything", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call",
        recipient_phone: "not-a-number",
      }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(h.reminders).toHaveLength(0);
  });

  it("accepts an explicit recipient when no Settings number exists", async () => {
    h.agentProfile = null;
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call",
        recipient_phone: "+919123456789",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    expect(h.reminders[0]).toMatchObject({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
  });

  it("still requires a Settings number when no override is given", async () => {
    h.agentProfile = null;
    const res = await POST(
      post({ flow_run_id: "run-1", scheduled_for: FUTURE, message: "Call" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(h.reminders).toHaveLength(0);
  });

  it("never substitutes the lead phone as the recipient", async () => {
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Call",
        lead_name: "Rahul",
        lead_phone: "+911234567890",
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    expect(h.reminders[0]).toMatchObject({ recipient_phone: "919876543210" });
  });

  it("exposes the saved recipient on GET for dialog prefill", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Saved",
      recipient_phone: "919111111111",
      recipient_custom: true,
    });
    const res = await GET(
      new Request("https://app.test/api/flows/flow-meta/followup-reminder?flow_run_id=run-1"),
      { params: Promise.resolve({ id: "flow-meta" }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reminder: Record<string, unknown> };
    expect(json.reminder).toMatchObject({ recipient_phone: "919111111111" });
  });

  it("rescheduling updates the recipient while preserving message history", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Original",
      recipient_phone: "919876543210",
      recipient_custom: false,
    });
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Original",
        recipient_phone: "+919123456789",
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({
      id: "fu-1",
      message_text: "Original",
      recipient_phone: "919123456789",
      recipient_custom: true,
      status: "scheduled",
    });
  });

  it("resaving with the same number keeps auto-follow instead of forcing custom", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Ping",
      recipient_phone: "919876543210",
      recipient_custom: false,
    });
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Ping",
        recipient_phone: "+91 98765 43210",
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders[0]).toMatchObject({
      recipient_phone: "919876543210",
      recipient_custom: false,
    });
  });

  it("reverting to the Settings number clears the custom flag", async () => {
    h.reminders.push({
      id: "fu-1",
      account_id: "acct-1",
      status: "scheduled",
      created_by: "user-1",
      source_kind: "meta_workspace_followup",
      source_run_id: "run-1",
      scheduled_for: FUTURE,
      message_text: "Ping",
      recipient_phone: "919111111111",
      recipient_custom: true,
    });
    const res = await POST(
      post({
        flow_run_id: "run-1",
        scheduled_for: FUTURE,
        message: "Ping",
        recipient_phone: "919876543210",
      }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(h.reminders[0]).toMatchObject({
      recipient_phone: "919876543210",
      recipient_custom: false,
    });
  });
});
