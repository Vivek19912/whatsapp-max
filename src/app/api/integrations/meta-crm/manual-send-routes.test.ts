// Manual Meta CRM send — preview + send route contracts.
//
// Guarantees: selecting/clearing never auto-sends (save path has no
// hook — pinned by the file-content contract); the preview comes
// from the SHARED builder (preview payload == send payload; no
// event_id is ever emitted); stale previews are rejected (409);
// double taps collapse to one ledger row; missing IDs / disabled
// config gate with reasons; tenant + ownership isolation; no
// tokens in responses.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

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
  function claimWinner(events: Row[]): Row | null {
    const rank = (s: unknown): number =>
      s === "sent" ? 0 : s === "pending" ? 1 : s === "failed" ? 2 : 3;
    return (
      [...events].sort((a, b) => {
        const byStatus = rank(a.status) - rank(b.status);
        if (byStatus !== 0) return byStatus;
        return String(b.created_at ?? "") < String(a.created_at ?? "") ? -1 : 1;
      })[0] ?? null
    );
  }
  return {
    rpc: async (fn: string, params: Row) => {
      if (fn !== "enqueue_meta_crm_event") {
        return { data: null, error: { code: "42883", message: `function ${fn} does not exist` } };
      }
      const accountId = params.p_account_id as string;
      const datasetId = String(params.p_dataset_id ?? "").trim();
      const metaLeadId = String(params.p_meta_lead_id ?? "").trim();
      const eventName = params.p_event_name as string;
      const identity = (r: Row): boolean =>
        r.account_id === accountId &&
        r.dataset_id === datasetId &&
        String(r.meta_lead_id ?? "").trim() === metaLeadId &&
        r.event_name === eventName;
      const key = [accountId, datasetId, metaLeadId, eventName].join("|");
      const winner = claimWinner((h.tables.meta_crm_events ?? []).filter(identity));
      const claims = (h.tables.meta_crm_event_claims ??= []);
      const sameKey = (c: Row): boolean =>
        [c.account_id, c.dataset_id, c.meta_lead_id, c.event_name].join("|") === key;
      if (winner) {
        if (!claims.some(sameKey)) {
          claims.push({
            account_id: accountId,
            dataset_id: datasetId,
            meta_lead_id: metaLeadId,
            event_name: eventName,
            canonical_event_id: winner.id,
            claimed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
        }
        return { data: [{ event_id: winner.id, deduplicated: true }], error: null };
      }
      const racedClaim = claims.find(sameKey);
      if (racedClaim?.canonical_event_id) {
        return { data: [{ event_id: racedClaim.canonical_event_id, deduplicated: true }], error: null };
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
        account_id: accountId,
        flow_id: (params.p_flow_id as string | null) ?? null,
        flow_run_id: params.p_flow_run_id as string,
        submission_id: params.p_submission_id as string,
        meta_lead_id: metaLeadId,
        event_name: eventName,
        from_quality: (params.p_from_quality as string) ?? "",
        to_quality: (params.p_to_quality as string) ?? "",
        event_time: params.p_event_time as string,
        dataset_id: datasetId,
      };
      h.seq += 1;
      (h.tables.meta_crm_events ??= []).push(row);
      if (racedClaim) racedClaim.canonical_event_id = row.id;
      else {
        claims.push({
          account_id: accountId,
          dataset_id: datasetId,
          meta_lead_id: metaLeadId,
          event_name: eventName,
          canonical_event_id: row.id,
          claimed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
      }
      return { data: [{ event_id: row.id, deduplicated: false }], error: null };
    },
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
  /** Status-change instant for the stored value (occurrence). */
  storedAt?: string;
  /** Meta lead creation instant (initial-stage occurrence). */
  leadCreatedAt?: string;
  submission?: boolean;
  metaLeadId?: string;
  contact?: { email?: string | null; phone?: string | null } | null;
  submissionAnswers?: Record<string, string> | null;
  enabled?: boolean;
  datasetId?: string | null;
  /** Dedicated CRM token: encrypted string stored, null = none configured. */
  crmToken?: string | null;
  legacy?: boolean;
  /** Stored table allowlist (undefined = never configured = unrestricted). */
  allowedFlowIds?: string[] | null;
} = {}) {
  const {
    stored = "Qualified Lead",
    // Relative instants: the stored status changed 2h ago; the Meta
    // lead was created 4h ago. Fixed dates would rot into the
    // future-gate as wall-clock time moves on.
    storedAt = new Date(Date.now() - 2 * 3600_000).toISOString(),
    leadCreatedAt = new Date(Date.now() - 4 * 3600_000).toISOString(),
    submission = true,
    metaLeadId = "1176464514919762",
    contact = null,
    submissionAnswers = null,
    enabled = true,
    datasetId = "DS1",
    crmToken = "CRM_TOKEN_dedicated",
    legacy = false,
    allowedFlowIds,
  } = o;
  h.tables = {
    flow_runs: [
      { id: RUN, account_id: "acct-1", flow_id: FLOW, contact_id: contact ? "c-1" : null, created_at: "2026-11-22T10:05:00.000Z" },
    ],
    contacts: contact
      ? [{ id: "c-1", account_id: "acct-1", email: contact.email ?? null, phone: contact.phone ?? null }]
      : [],
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
      stored === null
        ? []
        : [{ account_id: "acct-1", field_id: "f-q", flow_run_id: RUN, value_text: stored, updated_at: storedAt }],
    meta_lead_submissions: submission
      ? [
          {
            id: "sub-1",
            account_id: "acct-1",
            flow_run_id: RUN,
            meta_lead_id: metaLeadId,
            meta_created_time: leadCreatedAt,
            created_at: "2026-11-22T10:05:00.000Z",
            answers: submissionAnswers ?? {},
            field_data: [],
          },
        ]
      : [],
    meta_crm_config: [
      {
        account_id: "acct-1",
        enabled,
        dataset_id: datasetId,
        dataset_ref: "row-ds",
        business_portfolio_id: "BIZ",
        dataset_name: "IM CRM",
        // Dedicated token at rest (encrypted) — never the Lead Ads one.
        access_token: crmToken === null ? null : encrypt(crmToken),
        ...(allowedFlowIds === undefined ? {} : { allowed_flow_ids: allowedFlowIds }),
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
      occurrenceTimeIso: string;
      previewId: string;
      payload: Record<string, unknown>;
      requestBody: { data: Array<Record<string, unknown>> };
      warnings: string[];
      lastEvent: null;
    };
    expect(p.sendable).toBe(true);
    expect(p.status).toBe("Qualified Lead");
    expect(p.stored).toBe("Qualified Lead");
    expect(p.eventName).toBe("QualifiedLead");
    expect(p.datasetId).toBe("DS1");
    expect(p.metaLeadId).toBe("1176464514919762");
    // Occurrence = the stored status-change moment, not the send moment.
    expect(Date.parse(p.occurrenceTimeIso)).toBeLessThanOrEqual(Date.now());
    expect(p.payload.event_time).toBe(Math.floor(Date.parse(p.occurrenceTimeIso) / 1000));
    expect(typeof p.previewId).toBe("string");
    // Same builder fields as the send path: official shape, real ids.
    expect(p.payload).toMatchObject({
      event_name: "QualifiedLead",
      action_source: "system_generated",
      user_data: { lead_id: "1176464514919762" },
      custom_data: { lead_event_source: "WhatsApp Max", event_source: "crm" },
    });
    // No event_id in the preview — the staleness fingerprint stays server-side.
    expect(p.payload).not.toHaveProperty("event_id");
    // The complete outgoing body wraps the event in `data`.
    expect(p.requestBody.data).toHaveLength(1);
    expect(p.requestBody.data[0]).toEqual(p.payload);
    expect(JSON.stringify(json)).not.toContain("STORED");
  });

  it("falls back to the Lead display default when nothing is stored", async () => {
    seed({ stored: null, leadCreatedAt: "2026-11-20T09:00:00.000Z" });
    const res = await previewGet(new Request(previewUrl));
    const json = (await res.json()) as {
      preview: { sendable: boolean; status: string; stored: null; eventName: string; occurrenceTimeIso: string };
    };
    expect(json.preview.sendable).toBe(true);
    expect(json.preview.status).toBe("Lead");
    expect(json.preview.stored).toBeNull();
    expect(json.preview.eventName).toBe("Lead");
    // Initial stage occurrence = the Meta lead creation instant.
    expect(json.preview.occurrenceTimeIso).toBe("2026-11-20T09:00:00.000Z");
  });

  it("gates unmapped legacy values without a payload", async () => {
    seed({ stored: "Hot" });
    const res = await previewGet(new Request(previewUrl));
    const json = (await res.json()) as { preview: { sendable: boolean; reason: string; payload: null; eventName: null } };
    expect(json.preview.sendable).toBe(false);
    expect(json.preview.reason).toBe("unmapped");
    expect(json.preview.payload).toBeNull();
  });

  it("blocks invalid Meta Lead IDs and future timestamps", async () => {
    seed({ metaLeadId: "FORM-99" });
    const badId = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string; payload: null };
    };
    expect(badId.preview.sendable).toBe(false);
    expect(badId.preview.reason).toBe("invalid_lead_id");
    expect(badId.preview.payload).toBeNull();

    seed({ storedAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const future = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string };
    };
    expect(future.preview.sendable).toBe(false);
    expect(future.preview.reason).toBe("invalid_timestamp");
  });

  it("includes hashed match data and warnings without raw contact values", async () => {
    seed({ contact: { email: "Buyer@Example.com", phone: "9876543210" } });
    const json = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; matchInfo: { hasEmail: boolean; hasPhone: boolean }; payload: { user_data: Record<string, unknown> }; warnings: string[] };
    };
    expect(json.preview.sendable).toBe(true);
    expect(json.preview.matchInfo).toEqual({ hasEmail: true, hasPhone: true });
    const userData = json.preview.payload.user_data;
    expect(userData.lead_id).toBe("1176464514919762");
    expect(userData.em).toHaveLength(1);
    expect(userData.ph).toHaveLength(1);
    expect(JSON.stringify(userData)).not.toContain("Buyer");
    expect(JSON.stringify(userData)).not.toContain("9876543210");
  });

  it("warns on stale occurrences but stays sendable", async () => {
    seed({ storedAt: "2026-11-10T10:00:00.000Z" });
    const json = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; warnings: string[] };
    };
    expect(json.preview.sendable).toBe(true);
    expect(json.preview.warnings.some((w) => w.includes("7 days"))).toBe(true);
  });

  it("gates a missing dedicated token without sending anything", async () => {
    seed({ crmToken: null });
    const json = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string; payload: null };
    };
    expect(json.preview.sendable).toBe(false);
    expect(json.preview.reason).toBe("no_token");
    expect(json.preview.payload).toBeNull();

    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string | null };
    };
    expect(preview.preview.previewId).toBeNull();
    expect(h.tables.meta_crm_events).toHaveLength(0);
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
      meta_lead_id: "1176464514919762",
    });
    // The stored occurrence (stage-change time) is delivered — never the click time.
    expect(Date.parse(h.tables.meta_crm_events[0].event_time as string)).toBeLessThanOrEqual(Date.now());
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

  it("invalidates previews when the same status is re-saved (new occurrence)", async () => {
    seed();
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    // Same status, new save moment → new occurrence → old preview stale.
    h.tables.workspace_values = [
      {
        account_id: "acct-1",
        field_id: "f-q",
        flow_run_id: RUN,
        value_text: "Qualified Lead",
        updated_at: new Date().toISOString(),
      },
    ];
    const res = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("stale_preview");
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

describe("table allowlist enforcement (preview + manual send)", () => {
  const TABLE_MESSAGE =
    "Meta CRM sending is disabled for this Workspace table. Enable this table in CRM Integration settings to send events.";

  it("preview gates unselected tables with the exact message, allows selected ones", async () => {
    seed({ allowedFlowIds: ["flow-other"] });
    const blocked = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string; message: string; payload: null };
    };
    expect(blocked.preview.sendable).toBe(false);
    expect(blocked.preview.reason).toBe("table_not_selected");
    expect(blocked.preview.message).toBe(TABLE_MESSAGE);
    expect(blocked.preview.payload).toBeNull();

    seed({ allowedFlowIds: [FLOW] });
    const allowed = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: null };
    };
    expect(allowed.preview.sendable).toBe(true);
    expect(allowed.preview.reason).toBeNull();
  });

  it("preview treats an explicit empty list as block-all", async () => {
    seed({ allowedFlowIds: [] });
    const json = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { sendable: boolean; reason: string };
    };
    expect(json.preview.sendable).toBe(false);
    expect(json.preview.reason).toBe("table_not_selected");
  });

  it("manual send is blocked server-side for unselected tables (exact message, no ledger row)", async () => {
    seed({ allowedFlowIds: ["flow-other"] });
    // No sendable preview exists, so any send attempt fails closed.
    const res = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: "stale-or-missing" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; reason: string };
    expect(json.reason).toBe("table_not_selected");
    expect(json.error).toBe(TABLE_MESSAGE);
    expect(h.tables.meta_crm_events).toHaveLength(0);
  });

  it("manual send works for selected tables (agent included)", async () => {
    seed({ allowedFlowIds: [FLOW] });
    h.role = "agent";
    h.owned = true;
    const preview = (await (await previewGet(new Request(previewUrl))).json()) as {
      preview: { previewId: string };
    };
    const res = await sendPost(post({ flow_id: FLOW, run_id: RUN, preview_id: preview.preview.previewId }));
    expect(res.status).toBe(200);
    expect(h.tables.meta_crm_events).toHaveLength(1);
    expect(h.tables.meta_crm_events[0].event_name).toBe("QualifiedLead");
  });
});
