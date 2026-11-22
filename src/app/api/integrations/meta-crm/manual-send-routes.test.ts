// Manual Meta CRM send — preview + send route contracts.
//
// Guarantees: selecting/clearing never auto-sends (save path has no
// hook — pinned by the file-content contract); the preview comes
// from the SHARED builder (preview payload == send payload modulo
// event_time/event_id); stale previews are rejected (409);
// double taps collapse to one ledger row; missing IDs / disabled
// config gate with reasons; tenant + ownership isolation; no
// tokens in responses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "agent-1",
  role: "owner" as string,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  caps: { canManageAssignments: false },
  owned: true,
  seq: 100,
}));

function statusError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function rank(role: string): number {
  return { viewer: 1, agent: 2, admin: 3, owner: 4 }[role] ?? 0;
}

type Row = Record<string, unknown>;

function applyFilters(rows: Row[], filters: Array<[string, unknown]>): Row[] {
  return rows.filter((r) =>
    filters.every(([c, v]) => {
      if (c === "__limit") return true;
      if (c === "__ilike") {
        const [col, val] = v as [string, string];
        return String(r[col] ?? "").toLowerCase() === String(val).toLowerCase();
      }
      return r[c] === v;
    }),
  );
}

function chain(table: string, filters: Array<[string, unknown]> = [], sort: { col: string; asc: boolean } | null = null) {
  const api: Record<string, (...a: never[]) => unknown> = {
    select: () => chain(table, filters, sort),
    eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]], sort),
    ilike: (c: string, v: unknown) => chain(table, [...filters, ["__ilike", [c, v]]], sort),
    order: (c: string, opts?: { ascending?: boolean }) =>
      chain(table, filters, { col: c, asc: opts?.ascending ?? true }),
    limit: (n: number) => chain(table, [...filters, ["__limit", n]], sort),
    maybeSingle: async () => {
      let rows = applyFilters(h.tables[table] ?? [], filters);
      if (sort) {
        rows = [...rows].sort((a, b) =>
          sort.asc
            ? String(a[sort.col]) < String(b[sort.col]) ? -1 : 1
            : String(a[sort.col]) > String(b[sort.col]) ? -1 : 1,
        );
      }
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      let rows = applyFilters(h.tables[table] ?? [], filters);
      if (sort) {
        rows = [...rows].sort((a, b) =>
          sort.asc
            ? String(a[sort.col]) < String(b[sort.col]) ? -1 : 1
            : String(a[sort.col]) > String(b[sort.col]) ? -1 : 1,
        );
      }
      if (rows.length === 0) return { data: null, error: { message: "none" } };
      return { data: rows[0], error: null };
    },
  };
  return api;
}

function fakeDb() {
  return {
    from(table: string) {
      return {
        select: () => chain(table),
        insert: (payload: Row) => ({
          select: () => ({
            single: async () => {
              if (table === "meta_crm_events") {
                const dup = (h.tables[table] ?? []).some(
                  (r) =>
                    r.account_id === payload.account_id &&
                    r.flow_run_id === payload.flow_run_id &&
                    r.event_name === payload.event_name &&
                    (r.from_quality ?? "") === (payload.from_quality ?? "") &&
                    (r.to_quality ?? "") === (payload.to_quality ?? ""),
                );
                if (dup) return { data: null, error: { code: "23505" } };
              }
              const row: Row = {
                id: `evt-${h.seq}`,
                event_uuid: `uuid-${h.seq}`,
                status: "pending",
                attempts: 0,
                max_attempts: 8,
                last_error: null,
                sent_at: null,
                created_at: new Date().toISOString(),
                next_retry_at: new Date(0).toISOString(),
                ...payload,
              };
              h.seq += 1;
              (h.tables[table] ??= []).push(row);
              return { data: row, error: null };
            },
          }),
        }),
      };
    },
  };
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: async (min: string) => {
    if (!h.role || rank(h.role) < rank(min)) throw statusError(h.role ? 403 : 401, "Forbidden");
    return { supabase: fakeDb(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  getCurrentAccount: async () => {
    if (h.role === "viewer") throw statusError(403, "Forbidden");
    return { supabase: fakeDb(), accountId: h.accountId, userId: h.userId, role: h.role };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error", reason: (err as { reason?: string })?.reason },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => fakeDb(),
}));

vi.mock("@/lib/flows/workspace-ownership", () => ({
  isRunOwnedByUser: async () => h.owned,
}));

vi.mock("@/lib/inbox/assignment-access", () => ({
  resolveViewerCaps: async () => h.caps,
}));

const { GET: previewGet } = await import("./preview/route");
const { POST: sendPost } = await import("./manual-send/route");

const FLOW = "flow-1";
const RUN = "run-1";

function seed(o: {
  stored?: string | null;
  submission?: boolean;
  enabled?: boolean;
  datasetId?: string | null;
  legacy?: boolean;
} = {}) {
  const { stored = "Qualified Lead", submission = true, enabled = true, datasetId = "DS1", legacy = false } = o;
  h.tables = {
    flow_runs: [{ id: RUN, account_id: "acct-1", flow_id: FLOW }],
    workspace_fields: [
      {
        id: "f-q",
        account_id: "acct-1",
        flow_id: FLOW,
        name: "Lead Quality",
        options: legacy
          ? ["Interested Lead", "Qualified Lead", "Booking Confirmed", "Disqualified Lead"]
          : ["Lead", "Interested Lead", "Qualified Lead", "Booking Confirmed", "Disqualified Lead"],
      },
    ],
    workspace_values:
      stored === null ? [] : [{ account_id: "acct-1", field_id: "f-q", flow_run_id: RUN, value_text: stored }],
    meta_lead_submissions: submission
      ? [{ id: "sub-1", account_id: "acct-1", flow_run_id: RUN, meta_lead_id: "LEAD123" }]
      : [],
    meta_crm_config: [
      {
        account_id: "acct-1",
        enabled,
        dataset_id: datasetId,
        dataset_ref: "row-ds",
        business_portfolio_id: "BIZ",
        dataset_name: "IM CRM",
      },
    ],
    flows: [{ id: FLOW, account_id: "acct-1", kind: "meta_lead_ads" }],
    meta_crm_events: [],
  };
}

const previewUrl = `https://app.test/api/integrations/meta-crm/preview?flow_id=${FLOW}&run_id=${RUN}`;
const post = (body: unknown) =>
  new Request("https://app.test/api/integrations/meta-crm/manual-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "agent-1";
  h.role = "owner";
  h.caps = { canManageAssignments: false };
  h.owned = true;
  h.seq = 100;
});

describe("GET preview", () => {
  it("builds a sendable preview from the shared builder", async () => {
    seed();
    const res = await previewGet(new Request(previewUrl));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; preview: Record<string, unknown> };
    expect(json.ok).toBe(true);
    const p = json.preview as {
      sendable: boolean;
      status: string;
      stored: string;
      eventName: string;
      datasetId: string;
      metaLeadId: string;
      previewId: string;
      payload: Record<string, unknown>;
      lastEvent: null;
    };
    expect(p.sendable).toBe(true);
    expect(p.status).toBe("Qualified Lead");
    expect(p.stored).toBe("Qualified Lead");
    expect(p.eventName).toBe("QualifiedLead");
    expect(p.datasetId).toBe("DS1");
    expect(p.metaLeadId).toBe("LEAD123");
    expect(typeof p.previewId).toBe("string");
    // Same builder fields as the send path: official shape, real ids.
    expect(p.payload).toMatchObject({
      event_name: "QualifiedLead",
      action_source: "system_generated",
      user_data: { lead_id: "LEAD123" },
      custom_data: { lead_event_source: "WhatsApp Max", event_source: "crm" },
    });
    expect(p.payload.event_id).toBe(p.previewId);
    expect(JSON.stringify(json)).not.toContain("STORED");
  });

  it("falls back to the Lead display default when nothing is stored", async () => {
    seed({ stored: null });
    const res = await previewGet(new Request(previewUrl));
    const json = (await res.json()) as { preview: { sendable: boolean; status: string; stored: null; eventName: string } };
    expect(json.preview.sendable).toBe(true);
    expect(json.preview.status).toBe("Lead");
    expect(json.preview.stored).toBeNull();
    expect(json.preview.eventName).toBe("Lead");
  });

  it("gates unmapped legacy values without a payload", async () => {
    seed({ stored: "Hot" });
    const res = await previewGet(new Request(previewUrl));
    const json = (await res.json()) as { preview: { sendable: boolean; reason: string; payload: null; eventName: null } };
    expect(json.preview.sendable).toBe(false);
    expect(json.preview.reason).toBe("unmapped");
    expect(json.preview.payload).toBeNull();
  });

  it("gates leads without a Meta Lead ID and disabled workspaces", async () => {
    seed({ submission: false });
    const noLead = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string };
    };
    expect(noLead.preview.sendable).toBe(false);
    expect(noLead.preview.reason).toBe("no_meta_lead");

    seed({ enabled: false });
    const disabled = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string };
    };
    expect(disabled.preview.sendable).toBe(false);
    expect(disabled.preview.reason).toBe("disabled");
  });

  it("isolates tenants and surfaces ledger errors honestly", async () => {
    seed();
    h.tables.flow_runs = [{ id: RUN, account_id: "acct-2", flow_id: FLOW }];
    const foreign = await previewGet(new Request(previewUrl));
    expect(foreign.status).toBe(404);

    seed();
    h.tables.meta_crm_events = [
      {
        id: "evt-9",
        account_id: "acct-1",
        flow_run_id: RUN,
        event_name: "QualifiedLead",
        status: "failed",
        last_error: "Meta rejected the CRM event (400).",
        sent_at: null,
        created_at: "2026-11-22T10:00:00.000Z",
      },
    ];
    const json = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { lastEvent: { status: string; lastError: string } };
    };
    expect(json.preview.lastEvent.status).toBe("failed");
    expect(json.preview.lastEvent.lastError).toContain("Meta rejected");
  });
});

describe("POST manual-send", () => {
  it("requires a preview id and refuses gated states", async () => {
    seed();
    const missing = await sendPost(post({ flow_id: FLOW, run_id: RUN }));
    expect(missing.status).toBe(400);

    seed({ submission: false });
    const gated = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: "x" }));
    expect(gated.status).toBe(400);
    const gatedJson = (await gated.json()) as { reason: string };
    expect(gatedJson.reason).toBe("no_meta_lead");
    expect(h.tables.meta_crm_events).toHaveLength(0);
  });

  it("sends the previewed event once and records the ledger row", async () => {
    seed();
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    const res = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; queued: boolean; eventId: string; deduplicated: boolean };
    expect(json.ok).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.deduplicated).toBe(false);
    expect(h.tables.meta_crm_events).toHaveLength(1);
    expect(h.tables.meta_crm_events[0]).toMatchObject({
      account_id: "acct-1",
      flow_run_id: RUN,
      event_name: "QualifiedLead",
      from_quality: "",
      to_quality: "Qualified Lead",
      dataset_id: "DS1",
      meta_lead_id: "LEAD123",
    });
  });

  it("rejects stale previews with a fresh one (409)", async () => {
    seed();
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    // The status changed after the preview was taken.
    h.tables.workspace_values = [
      { account_id: "acct-1", field_id: "f-q", flow_run_id: RUN, value_text: "Booking Confirmed" },
    ];
    const res = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { reason: string; preview: { eventName: string; previewId: string } };
    expect(json.reason).toBe("stale_preview");
    expect(json.preview.eventName).toBe("BookingConfirmed");
    expect(h.tables.meta_crm_events).toHaveLength(0);
  });

  it("collapses double taps into one ledger row (no duplicate send)", async () => {
    seed();
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    const id = preview.preview.previewId;
    const first = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: id }));
    expect(first.status).toBe(200);
    // Second tap with the same preview: the chained from_quality now
    // equals the current status → "unchanged", never a second row.
    const second = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: id }));
    expect(second.status).toBe(200);
    const json = (await second.json()) as { ok: boolean; queued: boolean; deduplicated: boolean };
    expect(json.ok).toBe(true);
    expect(json.deduplicated).toBe(true);
    expect(h.tables.meta_crm_events).toHaveLength(1);
  });

  it("refresh persistence: the sent status survives in later previews", async () => {
    seed();
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    const again = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { lastEvent: { eventName: string; status: string } | null };
    };
    expect(again.preview.lastEvent?.eventName).toBe("QualifiedLead");
    expect(again.preview.lastEvent?.status).toBe("pending");
  });

  it("enforces tenant + ownership isolation", async () => {
    seed();
    h.role = "agent";
    h.owned = false;
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    const denied = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    expect(denied.status).toBe(404);
    expect(h.tables.meta_crm_events).toHaveLength(0);

    h.role = "viewer";
    const roleDenied = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: "x" }));
    expect(roleDenied.status).toBe(403);
  });
});
