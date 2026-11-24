// Meta CRM feedback — enqueue/drain/config contracts.
//
// Uses an in-memory Supabase double; Meta is mocked via fetchImpl
// or module mocks. No network, no tokens persisted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ownership: "ok" as "ok" | "not-owned" | { throw: unknown },
  token: "STORED_TOKEN",
  tokenCalls: 0,
}));

vi.mock("@/lib/meta-lead-ads/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta-lead-ads/store")>();
  return {
    ...actual,
    getUserToken: async () => {
      h.tokenCalls += 1;
      return h.token;
    },
  };
});

vi.mock("./datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./datasets")>();
  return {
    ...actual,
    verifyDatasetOwnership: async () => {
      if (h.ownership === "ok") return { verified: true };
      if (h.ownership === "not-owned") {
        return {
          verified: false,
          reason:
            'Dataset 1830596054845292 ("IM CRM") was not found under Business Portfolio BIZ1.',
        };
      }
      throw (h.ownership as { throw: unknown }).throw;
    },
  };
});

import {
  drainCrmEventsQueue,
  enqueueLeadQualityEvent,
  getCrmAccessToken,
  getCrmFeedbackConfig,
  isFlowAllowedForCrm,
  maybeEnqueueInitialLeadEvent,
  saveCrmFeedbackConfig,
  TABLE_NOT_SELECTED_MESSAGE,
} from "./feedback";
import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

// Distinct credentials prove separation: the drain must send with
// the dedicated CRM token and never touch the Lead Ads one.
const CRM_TOKEN = "CRM_TOKEN_dedicated_abc";
const LEAD_ADS_TOKEN = "LEAD_ADS_TOKEN_xyz";

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const ops: Array<{ table: string; op: string }> = [];
  let seq = 100;

  function matches(row: Row, filters: Array<[string, unknown]>): boolean {
    return filters.every(([c, v]) => {
      if (c === "__lte_next_retry") return true;
      if (typeof c === "string" && c.startsWith("__in:")) {
        return (v as unknown[]).includes(row[c.slice(5)]);
      }
      return row[c] === v;
    });
  }

  function chain(table: string, filters: Array<[string, unknown]> = [], limit: number | null = null): unknown {
    const api: Record<string, (...a: never[]) => unknown> = {
      select: () => {
        ops.push({ table, op: "select" });
        return chain(table, filters, limit);
      },
      eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]], limit),
      in: (c: string, vals: unknown) => chain(table, [...filters, [`__in:${c}`, vals]], limit),
      order: () => chain(table, filters, limit),
      lte: () => chain(table, filters, limit),
      limit: (n: number) => chain(table, filters, n),
      maybeSingle: async () => {
        const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
        if (rows.length === 0) return { data: null, error: { message: "none" } };
        return { data: rows[0], error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        let rows = (tables[table] ?? []).filter((r) => matches(r, filters));
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return api;
  }

  const db = {
    from(table: string) {
      return {
        select: (...a: unknown[]) => {
          ops.push({ table, op: "select" });
          void a;
          return chain(table);
        },
        insert: (payload: Row) => {
          ops.push({ table, op: "insert" });
          return {
            select: () => ({
              single: async () => {
                if (table === "meta_crm_events") {
                  const dup = (tables[table] ?? []).some(
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
                  id: `evt-${seq++}`,
                  status: "pending",
                  attempts: 0,
                  max_attempts: 8,
                  next_retry_at: new Date(0).toISOString(),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  event_uuid: `uuid-${seq}`,
                  ...payload,
                };
                (tables[table] ??= []).push(row);
                return { data: row, error: null };
              },
            }),
          };
        },
        upsert: (payload: Row) => {
          ops.push({ table, op: "upsert" });
          // Real Supabase upserts write immediately; select() only
          // shapes the return. Execute here so bare awaits persist.
          const rows = (tables[table] ??= []);
          const idx = rows.findIndex((r) => r.account_id === payload.account_id);
          const row: Row =
            idx >= 0
              ? { ...rows[idx], ...payload, updated_at: new Date().toISOString() }
              : {
                  id: `cfg-${seq++}`,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  ...payload,
                };
          if (idx >= 0) rows[idx] = row;
          else rows.push(row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        },
        update: (patch: Row) => {
          ops.push({ table, op: "update" });
          const c = chain(table);
          const origThen = (c as { then: unknown }).then;
          void origThen;
          return {
            eq: (col: string, val: unknown) => ({
              eq: (col2: string, val2: unknown) => ({
                then: (resolve: (v: { data: null; error: null }) => void) => {
                  for (const r of tables[table] ?? []) {
                    if (r[col] === val && r[col2] === val2) Object.assign(r, patch);
                  }
                  return Promise.resolve({ data: null, error: null }).then(resolve);
                },
              }),
              then: (resolve: (v: { data: null; error: null }) => void) => {
                for (const r of tables[table] ?? []) {
                  if (r[col] === val) Object.assign(r, patch);
                }
                return Promise.resolve({ data: null, error: null }).then(resolve);
              },
            }),
          };
        },
      };
    },
  };
  return { db: db as never, tables, ops };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  h.ownership = "ok";
  h.token = LEAD_ADS_TOKEN;
  h.tokenCalls = 0;
});

describe("enqueueLeadQualityEvent", () => {
  it("skips unchanged values without touching the database", async () => {
    const { db, ops } = makeDb();
    const out = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      fromQuality: "Qualified Lead",
      toQuality: "qualified lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: "u1",
    });
    expect(out).toEqual({ enqueued: false, reason: "unchanged" });
    expect(ops).toHaveLength(0);
  });

  it("skips unmapped legacy values without touching the database", async () => {
    const { db, ops } = makeDb();
    const out = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      fromQuality: "",
      toQuality: "Hot",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: "u1",
    });
    expect(out).toEqual({ enqueued: false, reason: "unmapped" });
    expect(ops).toHaveLength(0);
  });

  it("skips non-Meta runs with no Meta Lead ID", async () => {
    const { db, tables } = makeDb({
      meta_lead_submissions: [],
      meta_crm_config: [
        { account_id: "acct-1", enabled: true, dataset_id: "DS" },
      ],
    });
    const out = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-9",
      fromQuality: "",
      toQuality: "Qualified Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: "u1",
    });
    expect(out).toEqual({ enqueued: false, reason: "no_meta_lead" });
    expect(tables.meta_crm_events ?? []).toHaveLength(0);
  });

  it("skips when feedback is disabled or unconfigured", async () => {
    const { db, tables } = makeDb({
      meta_lead_submissions: [
        { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "LEAD1" },
      ],
      meta_crm_config: [],
    });
    const out = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      fromQuality: "",
      toQuality: "Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: null,
    });
    expect(out).toEqual({ enqueued: false, reason: "disabled" });
    expect(tables.meta_crm_events ?? []).toHaveLength(0);
  });

  it("enqueues a pending event and deduplicates races", async () => {
    const { db, tables } = makeDb({
      meta_lead_submissions: [
        { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "LEAD1" },
      ],
      meta_crm_config: [
        { account_id: "acct-1", enabled: true, dataset_id: "1830596054845292" },
      ],
    });
    const first = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      fromQuality: "",
      toQuality: "Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: null,
    });
    expect(first.enqueued).toBe(true);
    const second = await enqueueLeadQualityEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      fromQuality: "",
      toQuality: "Lead",
      eventTimeIso: "2026-11-22T10:00:01.000Z",
      actorUserId: null,
    });
    expect(second).toMatchObject({ enqueued: true, deduplicated: true });
    expect((second as { eventId: string }).eventId).toBe(
      (first as { eventId: string }).eventId,
    );
    expect(tables.meta_crm_events).toHaveLength(1);
  });
});

describe("drainCrmEventsQueue", () => {
  function seedEvent(over: Partial<Row> = {}): Row {
    return {
      id: "evt-1",
      account_id: "acct-1",
      flow_id: "flow-1",
      flow_run_id: "run-1",
      submission_id: "sub-1",
      meta_lead_id: "1176464514919762",
      event_name: "QualifiedLead",
      from_quality: "",
      to_quality: "Qualified Lead",
      event_time: "2026-11-22T10:00:00.000Z",
      event_uuid: "uuid-evt-1",
      dataset_id: "1830596054845292",
      status: "pending",
      attempts: 0,
      max_attempts: 8,
      last_error: null,
      next_retry_at: new Date(0).toISOString(),
      created_by: "u1",
      ...over,
    };
  }

  it("sends due events with the stored token and marks them sent", async () => {
    const seen: string[] = [];
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent()],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt(CRM_TOKEN) }],
    });
    const out = await drainCrmEventsQueue(db, {
      limit: 20,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        const body = JSON.parse(String(init.body));
        expect(url).toBe("https://graph.facebook.com/v27.0/1830596054845292/events");
        expect(body.data[0]).toMatchObject({
          event_name: "QualifiedLead",
          action_source: "system_generated",
          // Documented integer form: exact digits, zero precision loss.
          user_data: { lead_id: 1176464514919762 },
        });
        // No event_id is ever sent — the ledger uuid stays internal.
        expect(body.data[0]).not.toHaveProperty("event_id");
        expect(String(init.body)).not.toContain("event_id");
        // Internal identity is preserved on the row for auditing.
        expect(tables.meta_crm_events[0].event_uuid).toBe("uuid-evt-1");
        return jsonResponse({ events_received: 1 });
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    // The dedicated CRM token — never the Lead Ads connection token.
    expect(seen).toEqual([`Bearer ${CRM_TOKEN}`]);
    expect(h.tokenCalls).toBe(0);
    expect(tables.meta_crm_events[0].status).toBe("sent");
    expect(tables.meta_crm_events[0].attempts).toBe(1);
    expect(JSON.stringify(tables).includes(LEAD_ADS_TOKEN)).toBe(false);
    expect(JSON.stringify(tables).includes(CRM_TOKEN)).toBe(false);
  });

  it("skips rows when no dedicated CRM token is configured (never sends, never retries)", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent()],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292" }],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => {
        throw new Error("must not call Meta");
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(tables.meta_crm_events[0].status).toBe("skipped");
    expect(String(tables.meta_crm_events[0].last_error)).toContain("access token");
    expect(h.tokenCalls).toBe(0);
  });

  it("getCrmAccessToken decrypts the stored token and rejects absence without leaking it", async () => {
    const { db } = makeDb({
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "DS", access_token: encrypt(CRM_TOKEN) }],
    });
    await expect(getCrmAccessToken(db, "acct-1")).resolves.toBe(CRM_TOKEN);
    const { db: empty } = makeDb({ meta_crm_config: [] });
    const err = await getCrmAccessToken(empty, "acct-1").catch((e) => e);
    expect(String(err.message)).toContain("access token");
    expect(String(err.message)).not.toContain(CRM_TOKEN);
  });

  it("marks auth failures failed with backoff and preserves identity", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent()],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt(CRM_TOKEN) }],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () =>
        jsonResponse({ error: { message: "No permission.", code: 200 } }, 400)) as unknown as typeof fetch,
    });
    expect(out.failed).toBe(1);
    const row = tables.meta_crm_events[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(typeof row.last_error).toBe("string");
    expect(Date.parse(row.next_retry_at as string)).toBeGreaterThan(Date.now());
  });

  it("skips rows when feedback is disabled without burning attempts", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent({ attempts: 3 })],
      meta_crm_config: [{ account_id: "acct-1", enabled: false, dataset_id: "1830596054845292" }],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => {
        throw new Error("must not call Meta");
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(tables.meta_crm_events[0].status).toBe("skipped");
    expect(tables.meta_crm_events[0].attempts).toBe(3);
  });

  it("delivers the stored occurrence time verbatim on retry (never the send moment)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { db } = makeDb({
      meta_crm_events: [seedEvent({ event_time: "2026-11-20T14:00:00.000Z" })],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt(CRM_TOKEN) }],
      // No contacts/submissions seeded: matching resolves to empty,
      // the historical occurrence must still be exact.
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)).data[0] as Record<string, unknown>);
        return jsonResponse({ events_received: 1 });
      }) as unknown as typeof fetch,
    });
    expect(out.sent).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].event_time).toBe(Math.floor(Date.parse("2026-11-20T14:00:00.000Z") / 1000));
  });

  it("includes hashed email/phone from the lead contact when available", async () => {
    const { sha256Hex } = await import("./matching");
    const bodies: Array<{ user_data: Record<string, unknown> }> = [];
    const { db } = makeDb({
      meta_crm_events: [seedEvent()],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt(CRM_TOKEN) }],
      flow_runs: [{ id: "run-1", account_id: "acct-1", contact_id: "c-1" }],
      contacts: [
        { id: "c-1", account_id: "acct-1", email: "John_Smith@gmail.com", phone: "(650) 555-1212" },
      ],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)).data[0]);
        return jsonResponse({ events_received: 1 });
      }) as unknown as typeof fetch,
    });
    expect(out.sent).toBe(1);
    expect(bodies).toHaveLength(1);
    const userData = bodies[0].user_data;
    // Exact lead id preserved verbatim; identifiers hashed, never raw.
    expect(userData.lead_id).toBe(1176464514919762);
    expect(userData.em).toEqual([sha256Hex("john_smith@gmail.com")]);
    expect(userData.ph).toEqual([sha256Hex("6505551212")]);
    expect(JSON.stringify(userData)).not.toContain("John_Smith");
    expect(JSON.stringify(userData)).not.toContain("650");
  });

  it("parks rows with invalid Meta Lead IDs as skipped (never retried, never sent)", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent({ meta_lead_id: "FORM-99" })],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt(CRM_TOKEN) }],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => {
        throw new Error("must not call Meta");
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(tables.meta_crm_events[0].status).toBe("skipped");
    expect(String(tables.meta_crm_events[0].last_error)).toContain("Meta Lead ID");
  });
});

describe("maybeEnqueueInitialLeadEvent", () => {
  function seedAuto(on: boolean, configOver: Row = {}) {
    return makeDb({
      meta_lead_submissions: [
        { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "1176464514919762" },
      ],
      meta_crm_config: [
        {
          account_id: "acct-1",
          enabled: true,
          dataset_id: "1830596054845292",
          access_token: encrypt(CRM_TOKEN),
          auto_send_lead: on,
          ...configOver,
        },
      ],
      meta_crm_events: [],
    });
  }

  it("enqueues exactly one initial Lead event when opted in", async () => {
    const { db, tables } = seedAuto(true);
    const out = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      eventTimeIso: "2026-11-22T09:50:00.000Z",
    });
    expect(out).toMatchObject({ enqueued: true, deduplicated: false });
    expect(tables.meta_crm_events).toHaveLength(1);
    expect(tables.meta_crm_events[0]).toMatchObject({
      event_name: "Lead",
      from_quality: "",
      to_quality: "Lead",
      event_time: "2026-11-22T09:50:00.000Z",
      dataset_id: "1830596054845292",
      meta_lead_id: "1176464514919762",
    });
    expect(h.tokenCalls).toBe(0);
  });

  it("a webhook retry collapses to the existing row (no duplicate)", async () => {
    const { db, tables } = seedAuto(true);
    const first = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      eventTimeIso: "2026-11-22T09:50:00.000Z",
    });
    const second = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
      eventTimeIso: "2026-11-22T09:50:00.000Z",
    });
    expect(first).toMatchObject({ enqueued: true, deduplicated: false });
    expect(second).toMatchObject({ enqueued: true, deduplicated: true });
    if (!first.enqueued || !second.enqueued) throw new Error("expected both sends to enqueue");
    expect(second.eventId).toBe(first.eventId);
    expect(tables.meta_crm_events).toHaveLength(1);
  });

  it("stays silent when opted out, disabled, unconfigured, or tokenless", async () => {
    const off = seedAuto(false);
    expect(
      await maybeEnqueueInitialLeadEvent(off.db, { accountId: "acct-1", flowId: "flow-1", runId: "run-1", eventTimeIso: "2026-11-22T09:50:00.000Z" }),
    ).toEqual({ enqueued: false, reason: "auto_send_off" });
    expect(off.tables.meta_crm_events).toHaveLength(0);

    const disabled = seedAuto(true, { enabled: false });
    expect(
      await maybeEnqueueInitialLeadEvent(disabled.db, { accountId: "acct-1", flowId: "flow-1", runId: "run-1", eventTimeIso: "2026-11-22T09:50:00.000Z" }),
    ).toEqual({ enqueued: false, reason: "disabled" });

    const noDataset = seedAuto(true, { dataset_id: null });
    expect(
      await maybeEnqueueInitialLeadEvent(noDataset.db, { accountId: "acct-1", flowId: "flow-1", runId: "run-1", eventTimeIso: "2026-11-22T09:50:00.000Z" }),
    ).toEqual({ enqueued: false, reason: "disabled" });

    const noToken = makeDb({
      meta_lead_submissions: [
        { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "1176464514919762" },
      ],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "DS", auto_send_lead: true, access_token: null }],
      meta_crm_events: [],
    });
    expect(
      await maybeEnqueueInitialLeadEvent(noToken.db, { accountId: "acct-1", flowId: "flow-1", runId: "run-1", eventTimeIso: "2026-11-22T09:50:00.000Z" }),
    ).toEqual({ enqueued: false, reason: "no_token" });
    expect(noToken.tables.meta_crm_events).toHaveLength(0);
    expect(h.tokenCalls).toBe(0);
  });

  it("isolates workspaces (foreign runs never enqueue)", async () => {
    const { db, tables } = makeDb({
      meta_lead_submissions: [],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "DS", access_token: encrypt(CRM_TOKEN), auto_send_lead: true }],
      meta_crm_events: [],
    });
    const out = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-2",
      flowId: "flow-1",
      runId: "run-1",
      eventTimeIso: "2026-11-22T09:50:00.000Z",
    });
    expect(out.enqueued).toBe(false);
    expect(tables.meta_crm_events).toHaveLength(0);
  });
});

describe("saveCrmFeedbackConfig", () => {
  it("enables only after verifying the dedicated CRM token (never the Lead Ads token)", async () => {
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    const { config, ownershipVerified } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
    });
    expect(ownershipVerified).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.dataset_id).toBe("1830596054845292");
    expect(config.verified_at).not.toBeNull();
    // The Lead Ads connection token is never consulted.
    expect(h.tokenCalls).toBe(0);
    expect(tables.meta_crm_config).toHaveLength(1);
    expect(decrypt(tables.meta_crm_config[0]?.access_token as string)).toBe(CRM_TOKEN);
  });

  it("refuses to enable without a CRM token (no silent fallback)", async () => {
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    await expect(
      saveCrmFeedbackConfig(db, {
        accountId: "acct-1",
        enabled: true,
        datasetRowId: "row-ds",
        actorUserId: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(tables.meta_crm_config).toHaveLength(0);
    expect(h.tokenCalls).toBe(0);
  });

  it("refuses to enable when the dataset is absent from the business listing", async () => {
    h.ownership = "not-owned";
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    await expect(
      saveCrmFeedbackConfig(db, {
        accountId: "acct-1",
        enabled: true,
        datasetRowId: "row-ds",
        actorUserId: "admin-1",
        accessToken: CRM_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(tables.meta_crm_config[0]?.enabled).toBe(false);
    expect(String(tables.meta_crm_config[0]?.last_error)).toContain("1830596054845292");
    expect(String(tables.meta_crm_config[0]?.last_error)).toContain("BIZ1");
    expect(h.tokenCalls).toBe(0);
  });

  it("surfaces an expired token precisely instead of blaming ownership", async () => {
    const { MetaCrmError } = await import("./datasets");
    h.ownership = {
      throw: new MetaCrmError({
        code: "auth_failed",
        message: "Meta rejected the access token. It may be expired or invalid.",
        status: 401,
        metaCode: 190,
        metaSubcode: null,
      }),
    };
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    const err = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("auth_failed");
    expect(err.status).toBe(401);
    expect(err.metaCode).toBe(190);
    // Fail closed, but the stored diagnostic names the real cause.
    expect(tables.meta_crm_config[0]?.enabled).toBe(false);
    expect(String(tables.meta_crm_config[0]?.last_error)).toContain("expired or invalid");
    expect(h.tokenCalls).toBe(0);
  });

  it("surfaces missing dataset permissions precisely, with Meta codes", async () => {
    const { MetaCrmError } = await import("./datasets");
    h.ownership = {
      throw: new MetaCrmError({
        code: "forbidden",
        message: "Meta refused: this token cannot access that dataset (code 200).",
        status: 403,
        metaCode: 200,
        metaSubcode: 7,
      }),
    };
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    const err = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("forbidden");
    expect(err.metaCode).toBe(200);
    expect(err.metaSubcode).toBe(7);
    expect(String(err.message)).toContain("code 200");
    expect(tables.meta_crm_config[0]?.enabled).toBe(false);
    expect(h.tokenCalls).toBe(0);
  });

  it("surfaces listing outages as backend failures, not ownership verdicts", async () => {
    const { MetaCrmError } = await import("./datasets");
    h.ownership = {
      throw: new MetaCrmError({
        code: "meta_error",
        message: "Meta rejected the dataset listing (503).",
        status: 502,
        metaCode: null,
        metaSubcode: null,
      }),
    };
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
    });
    const err = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaCrmError);
    expect(err.code).toBe("meta_error");
    expect(err.status).toBe(502);
    expect(String(err.message)).not.toMatch(/ownership could not be verified/i);
    expect(tables.meta_crm_config[0]?.enabled).toBe(false);
    expect(h.tokenCalls).toBe(0);
  });

  it("disables without verification and never touches Meta", async () => {
    const callsBefore = h.tokenCalls;
    const { db, tables } = makeDb({ meta_crm_datasets: [], meta_crm_config: [] });
    const { config } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: false,
      datasetRowId: null,
      actorUserId: "admin-1",
    });
    expect(config.enabled).toBe(false);
    expect(h.tokenCalls).toBe(callsBefore);
    expect(tables.meta_crm_config).toHaveLength(1);
    // Untouched preference defaults to off.
    expect(tables.meta_crm_config[0]?.auto_send_lead ?? false).toBe(false);
  });

  it("persists the auto-send preference on both paths without touching events", async () => {
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        { id: "row-ds", account_id: "acct-1", dataset_id: "DS", business_portfolio_id: "BIZ", dataset_name: "IM CRM" },
      ],
      meta_crm_config: [],
    });
    const { config } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
      autoSendLead: true,
    });
    expect(config.enabled).toBe(true);
    expect(config.auto_send_lead).toBe(true);
    // Saving the preference never enqueues an event by itself.
    expect(tables.meta_crm_events ?? []).toHaveLength(0);

    const off = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: false,
      datasetRowId: null,
      actorUserId: "admin-1",
    });
    expect(off.config.enabled).toBe(false);
    // Disabling preserves the stored preference (no silent reset).
    expect(tables.meta_crm_config[0]?.auto_send_lead).toBe(true);

    const { config: backOn } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      autoSendLead: false,
    });
    expect(backOn.auto_send_lead).toBe(false);
    expect(h.tokenCalls).toBe(0);
  });

  it("rejects foreign-account datasets", async () => {
    const { db } = makeDb({ meta_crm_datasets: [], meta_crm_config: [] });
    await expect(
      saveCrmFeedbackConfig(db, {
        accountId: "acct-1",
        enabled: true,
        datasetRowId: "row-other-acct",
        actorUserId: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("getCrmFeedbackConfig returns null when unconfigured", async () => {
    const { db } = makeDb({ meta_crm_config: [] });
    expect(await getCrmFeedbackConfig(db, "acct-1")).toBeNull();
  });

  it("column visibility defaults to visible on pre-migration rows", async () => {
    const { toPublicCrmFeedbackConfig } = await import("./feedback");
    expect(toPublicCrmFeedbackConfig(null).showLeadQuality).toBe(true);
    expect(
      toPublicCrmFeedbackConfig({ enabled: false } as never).showLeadQuality,
    ).toBe(true);
  });

  it("column visibility defaults to visible on pre-migration rows", async () => {
    const { toPublicCrmFeedbackConfig } = await import("./feedback");
    expect(toPublicCrmFeedbackConfig(null).showLeadQuality).toBe(true);
    expect(
      toPublicCrmFeedbackConfig({ enabled: false } as never).showLeadQuality,
    ).toBe(true);
  });

  it("stores, preserves, and validates the table allowlist", async () => {
    const { db, tables } = makeDb({
      meta_crm_datasets: [
        {
          id: "row-ds",
          account_id: "acct-1",
          dataset_id: "1830596054845292",
          business_portfolio_id: "BIZ1",
          dataset_name: "IM CRM",
        },
      ],
      meta_crm_config: [],
      flows: [
        { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads" },
        { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads" },
        { id: "flow-chat", account_id: "acct-1", kind: "whatsapp_flow" },
        { id: "flow-x", account_id: "acct-OTHER", kind: "meta_lead_ads" },
      ],
    });
    // Explicit list is stored.
    const { config } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
      allowedFlowIds: ["flow-a"],
    });
    expect(config.allowed_flow_ids).toEqual(["flow-a"]);
    // Omitted = preserved, not cleared.
    const { config: kept } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
    });
    expect(kept.allowed_flow_ids).toEqual(["flow-a"]);
    // Foreign, non-Meta, and deleted (unknown) ids are rejected.
    for (const bad of [["flow-x"], ["flow-chat"], ["flow-gone"], ["flow-a", "flow-x"]]) {
      await expect(
        saveCrmFeedbackConfig(db, {
          accountId: "acct-1",
          enabled: true,
          datasetRowId: "row-ds",
          actorUserId: "admin-1",
          accessToken: CRM_TOKEN,
          allowedFlowIds: bad,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(tables.meta_crm_config).toHaveLength(1);
    // Empty array is a valid explicit block-all.
    const { config: empty } = await saveCrmFeedbackConfig(db, {
      accountId: "acct-1",
      enabled: true,
      datasetRowId: "row-ds",
      actorUserId: "admin-1",
      accessToken: CRM_TOKEN,
      allowedFlowIds: [],
    });
    expect(empty.allowed_flow_ids).toEqual([]);
  });
});

describe("table allowlist enforcement", () => {
  const submission = {
    id: "sub-1",
    account_id: "acct-1",
    flow_run_id: "run-1",
    meta_lead_id: "1176464514919762",
  };
  const flows = [
    { id: "flow-allowed", account_id: "acct-1", kind: "meta_lead_ads" },
    { id: "flow-other", account_id: "acct-1", kind: "meta_lead_ads" },
  ];

  function seedDb(configExtra: Record<string, unknown> = {}) {
    return makeDb({
      meta_lead_submissions: [{ ...submission }],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "DS1", ...configExtra }],
      flows: [...flows],
      flow_runs: [{ id: "run-1", account_id: "acct-1", flow_id: "flow-other" }],
    });
  }

  function enqueueArgs(flowId: string) {
    return {
      accountId: "acct-1",
      flowId,
      runId: "run-1",
      fromQuality: "",
      toQuality: "Qualified Lead",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: "u1",
    };
  }

  it("isFlowAllowedForCrm: legacy NULL and missing-column reads stay unrestricted", async () => {
    const { db } = seedDb();
    expect(await isFlowAllowedForCrm(db, "acct-1", "flow-other")).toBe(true);
    expect(await isFlowAllowedForCrm(db, "acct-1", null)).toBe(true);
    // Pre-migration database (no allowed_flow_ids column) fails open.
    const throwing = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              throw { code: "42703", message: 'column "allowed_flow_ids" does not exist' };
            },
          }),
        }),
      }),
    } as never;
    expect(await isFlowAllowedForCrm(throwing, "acct-1", "flow-other")).toBe(true);
  });

  it("enqueue: allows selected tables, blocks the rest without writing", async () => {
    const { db, tables } = seedDb({ allowed_flow_ids: ["flow-allowed"] });
    const ok = await enqueueLeadQualityEvent(db, enqueueArgs("flow-allowed"));
    expect(ok.enqueued).toBe(true);
    const blocked = await enqueueLeadQualityEvent(db, enqueueArgs("flow-other"));
    expect(blocked).toEqual({ enqueued: false, reason: "table_not_selected" });
    expect(tables.meta_crm_events ?? []).toHaveLength(1);
    expect(tables.meta_crm_events[0].flow_id).toBe("flow-allowed");
  });

  it("enqueue: an explicit empty list blocks every table", async () => {
    const { db, tables } = seedDb({ allowed_flow_ids: [] });
    const out = await enqueueLeadQualityEvent(db, enqueueArgs("flow-allowed"));
    expect(out).toEqual({ enqueued: false, reason: "table_not_selected" });
    expect(tables.meta_crm_events ?? []).toHaveLength(0);
  });

  it("auto-send maps the table gate through (no silent disabled)", async () => {
    const { db } = seedDb({
      auto_send_lead: true,
      access_token: encrypt(CRM_TOKEN),
      allowed_flow_ids: ["flow-allowed"],
    });
    const blocked = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-other",
      runId: "run-1",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
    });
    expect(blocked).toEqual({ enqueued: false, reason: "table_not_selected" });
    const allowed = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-allowed",
      runId: "run-1",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
    });
    expect(allowed.enqueued).toBe(true);
  });

  it("drain: skips queued rows from deselected tables, delivers selected ones", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [
        {
          id: "evt-blocked",
          account_id: "acct-1",
          flow_id: "flow-other",
          flow_run_id: "run-9",
          submission_id: "sub-1",
          meta_lead_id: "1176464514919762",
          event_name: "Lead",
          from_quality: "",
          to_quality: "Lead",
          event_time: "2026-11-22T10:00:00.000Z",
          event_uuid: "uuid-blocked",
          dataset_id: "DS1",
          status: "pending",
          attempts: 0,
          max_attempts: 8,
          last_error: null,
          next_retry_at: new Date(0).toISOString(),
          sent_at: null,
        },
      ],
      meta_crm_config: [
        {
          account_id: "acct-1",
          enabled: true,
          dataset_id: "DS1",
          access_token: encrypt(CRM_TOKEN),
          allowed_flow_ids: ["flow-allowed"],
        },
      ],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => {
        throw new Error("must not call Meta for a deselected table");
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(tables.meta_crm_events[0].status).toBe("skipped");
    expect(String(tables.meta_crm_events[0].last_error)).toBe(TABLE_NOT_SELECTED_MESSAGE);
  });

  it("drain: resolves the flow via flow_runs when the row flow is null", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [
        {
          id: "evt-norun-flow",
          account_id: "acct-1",
          flow_id: null,
          flow_run_id: "run-1",
          submission_id: "sub-1",
          meta_lead_id: "1176464514919762",
          event_name: "Lead",
          from_quality: "",
          to_quality: "Lead",
          event_time: "2026-11-22T10:00:00.000Z",
          event_uuid: "uuid-norun",
          dataset_id: "DS1",
          status: "pending",
          attempts: 0,
          max_attempts: 8,
          last_error: null,
          next_retry_at: new Date(0).toISOString(),
          sent_at: null,
        },
      ],
      flow_runs: [{ id: "run-1", account_id: "acct-1", flow_id: "flow-other" }],
      meta_crm_config: [
        {
          account_id: "acct-1",
          enabled: true,
          dataset_id: "DS1",
          access_token: encrypt(CRM_TOKEN),
          allowed_flow_ids: ["flow-allowed"],
        },
      ],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => {
        throw new Error("must not call Meta for a deselected table");
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 0, failed: 0, skipped: 1 });
    expect(tables.meta_crm_events[0].status).toBe("skipped");
  });

  it("drain: delivers rows from selected tables (history rows keep working)", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [
        {
          id: "evt-ok",
          account_id: "acct-1",
          flow_id: "flow-allowed",
          flow_run_id: "run-1",
          submission_id: "sub-1",
          meta_lead_id: "1176464514919762",
          event_name: "Lead",
          from_quality: "",
          to_quality: "Lead",
          event_time: "2026-11-22T10:00:00.000Z",
          event_uuid: "uuid-ok",
          dataset_id: "1830596054845292",
          status: "pending",
          attempts: 0,
          max_attempts: 8,
          last_error: null,
          next_retry_at: new Date(0).toISOString(),
          sent_at: null,
        },
      ],
      meta_crm_config: [
        {
          account_id: "acct-1",
          enabled: true,
          dataset_id: "1830596054845292",
          access_token: encrypt(CRM_TOKEN),
          allowed_flow_ids: ["flow-allowed"],
        },
      ],
    });
    const out = await drainCrmEventsQueue(db, {
      fetchImpl: (async () => jsonResponse({ events_received: 1 })) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(tables.meta_crm_events[0].status).toBe("sent");
  });

  it("toPublicCrmFeedbackConfig exposes the allowlist (null when never configured)", async () => {
    const { toPublicCrmFeedbackConfig } = await import("./feedback");
    expect(toPublicCrmFeedbackConfig(null).allowedFlowIds).toBeNull();
    expect(
      toPublicCrmFeedbackConfig({ allowed_flow_ids: ["flow-a"] } as never).allowedFlowIds,
    ).toEqual(["flow-a"]);
    expect(
      toPublicCrmFeedbackConfig({ allowed_flow_ids: "nope" } as never).allowedFlowIds,
    ).toBeNull();
  });
});

describe("cross-table duplicate prevention (dataset + lead + event)", () => {
  const SUB_A = { id: "sub-a", account_id: "acct-1", flow_run_id: "run-a", meta_lead_id: "LEADX" };
  const SUB_B = { id: "sub-b", account_id: "acct-1", flow_run_id: "run-b", meta_lead_id: "LEADX" };
  const SUB_C = { id: "sub-c", account_id: "acct-1", flow_run_id: "run-c", meta_lead_id: "LEADY" };

  function seedCross(extraEvents: Array<Record<string, unknown>> = []) {
    return makeDb({
      meta_lead_submissions: [SUB_A, SUB_B, SUB_C],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "DS1", access_token: encrypt(CRM_TOKEN) }],
      flows: [
        { id: "flow-a", account_id: "acct-1", kind: "meta_lead_ads" },
        { id: "flow-b", account_id: "acct-1", kind: "meta_lead_ads" },
      ],
      flow_runs: [
        { id: "run-a", account_id: "acct-1", flow_id: "flow-a" },
        { id: "run-b", account_id: "acct-1", flow_id: "flow-b" },
        { id: "run-c", account_id: "acct-1", flow_id: "flow-b" },
      ],
      meta_crm_events: extraEvents,
    });
  }

  function attempt(db: unknown, flowId: string, runId: string, toQuality = "Interested Lead", fromQuality = "") {
    return enqueueLeadQualityEvent(db as never, {
      accountId: "acct-1",
      flowId,
      runId,
      fromQuality,
      toQuality,
      eventTimeIso: "2026-11-22T10:00:00.000Z",
      actorUserId: "u1",
    });
  }

  it("blocks the same event from a second table after it was sent", async () => {
    const sent = {
      id: "evt-sent",
      account_id: "acct-1",
      flow_id: "flow-a",
      flow_run_id: "run-a",
      submission_id: "sub-a",
      meta_lead_id: "LEADX",
      event_name: "InterestedLead",
      from_quality: "",
      to_quality: "InterestedLead",
      event_time: "2026-11-22T10:00:00.000Z",
      event_uuid: "uuid-sent",
      dataset_id: "DS1",
      status: "sent",
      attempts: 1,
      max_attempts: 8,
      last_error: null,
      next_retry_at: new Date(0).toISOString(),
      sent_at: "2026-11-22T10:01:00.000Z",
      created_at: "2026-11-22T10:00:00.000Z",
    };
    const { db, tables } = seedCross([sent]);
    const out = await attempt(db, "flow-b", "run-b");
    expect(out).toMatchObject({ enqueued: true, deduplicated: true, eventId: "evt-sent" });
    expect(tables.meta_crm_events).toHaveLength(1);
  });

  it("blocks queued and failed cross-table duplicates without new writes", async () => {
    for (const status of ["pending", "failed"]) {
      const { db, tables } = seedCross([
        {
          id: `evt-${status}`,
          account_id: "acct-1",
          flow_id: "flow-a",
          flow_run_id: "run-a",
          submission_id: "sub-a",
          meta_lead_id: "LEADX",
          event_name: "InterestedLead",
          from_quality: "",
          to_quality: "InterestedLead",
          event_time: "2026-11-22T10:00:00.000Z",
          event_uuid: `uuid-${status}`,
          dataset_id: "DS1",
          status,
          attempts: status === "failed" ? 8 : 0,
          max_attempts: 8,
          last_error: null,
          next_retry_at: new Date(0).toISOString(),
          sent_at: null,
          created_at: "2026-11-22T10:00:00.000Z",
        },
      ]);
      const out = await attempt(db, "flow-b", "run-b");
      expect(out).toMatchObject({ enqueued: true, deduplicated: true });
      expect(tables.meta_crm_events).toHaveLength(1);
    }
  });

  it("does not treat a different event, lead, or dataset as a duplicate", async () => {
    const sent = {
      id: "evt-sent",
      account_id: "acct-1",
      flow_id: "flow-a",
      flow_run_id: "run-a",
      submission_id: "sub-a",
      meta_lead_id: "LEADX",
      event_name: "InterestedLead",
      from_quality: "",
      to_quality: "InterestedLead",
      event_time: "2026-11-22T10:00:00.000Z",
      event_uuid: "uuid-sent",
      dataset_id: "DS1",
      status: "sent",
      attempts: 1,
      max_attempts: 8,
      last_error: null,
      next_retry_at: new Date(0).toISOString(),
      sent_at: "2026-11-22T10:01:00.000Z",
      created_at: "2026-11-22T10:00:00.000Z",
    };
    // Different event name on the same lead → allowed.
    {
      const { db, tables } = seedCross([sent]);
      const out = await enqueueLeadQualityEvent(db as never, {
        accountId: "acct-1",
        flowId: "flow-b",
        runId: "run-b",
        fromQuality: "Interested Lead",
        toQuality: "Qualified Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        actorUserId: "u1",
      });
      expect(out.enqueued).toBe(true);
      expect((out as { deduplicated?: boolean }).deduplicated).toBe(false);
      expect(tables.meta_crm_events).toHaveLength(2);
    }
    // Same event, different lead → allowed.
    {
      const { db, tables } = seedCross([sent]);
      const out = await enqueueLeadQualityEvent(db as never, {
        accountId: "acct-1",
        flowId: "flow-b",
        runId: "run-c",
        fromQuality: "",
        toQuality: "Interested Lead",
        eventTimeIso: "2026-11-22T10:00:00.000Z",
        actorUserId: "u1",
      });
      expect(out.enqueued).toBe(true);
      expect((out as { deduplicated?: boolean }).deduplicated).toBe(false);
      expect(tables.meta_crm_events).toHaveLength(2);
    }
    // Same lead + event but a different dataset → independent.
    {
      const { db, tables } = seedCross([sent]);
      (tables.meta_crm_config[0] as Record<string, unknown>).dataset_id = "DS2";
      const out = await attempt(db, "flow-b", "run-b");
      expect(out.enqueued).toBe(true);
      expect((out as { deduplicated?: boolean }).deduplicated).toBe(false);
      expect(tables.meta_crm_events).toHaveLength(2);
    }
  });

  it("blocks a repeated event even across a different status transition", async () => {
    const sent = {
      id: "evt-sent",
      account_id: "acct-1",
      flow_id: "flow-a",
      flow_run_id: "run-a",
      submission_id: "sub-a",
      meta_lead_id: "LEADX",
      event_name: "InterestedLead",
      from_quality: "Qualified Lead",
      to_quality: "InterestedLead",
      event_time: "2026-11-22T10:00:00.000Z",
      event_uuid: "uuid-sent",
      dataset_id: "DS1",
      status: "sent",
      attempts: 1,
      max_attempts: 8,
      last_error: null,
      next_retry_at: new Date(0).toISOString(),
      sent_at: "2026-11-22T10:01:00.000Z",
      created_at: "2026-11-22T10:00:00.000Z",
    };
    const { db, tables } = seedCross([sent]);
    // Different run, different from_quality — same dataset+lead+event.
    const out = await enqueueLeadQualityEvent(db as never, {
      accountId: "acct-1",
      flowId: "flow-b",
      runId: "run-b",
      fromQuality: "Lead",
      toQuality: "Interested Lead",
      eventTimeIso: "2026-11-22T11:00:00.000Z",
      actorUserId: "u1",
    });
    expect(out).toMatchObject({ enqueued: true, deduplicated: true, eventId: "evt-sent" });
    expect(tables.meta_crm_events).toHaveLength(1);
  });

  it("respects the table allowlist before the cross-table check", async () => {
    const { db, tables } = seedCross([]);
    (tables.meta_crm_config[0] as Record<string, unknown>).allowed_flow_ids = ["flow-a"];
    const out = await attempt(db, "flow-b", "run-b");
    expect(out).toEqual({ enqueued: false, reason: "table_not_selected" });
    expect(tables.meta_crm_events).toHaveLength(0);
  });

  it("auto-send is blocked cross-table with the recorded reason", async () => {
    const { db, tables } = seedCross([
      {
        id: "evt-sent",
        account_id: "acct-1",
        flow_id: "flow-a",
        flow_run_id: "run-a",
        submission_id: "sub-a",
        meta_lead_id: "LEADX",
        event_name: "Lead",
        from_quality: "",
        to_quality: "Lead",
        event_time: "2026-11-22T10:00:00.000Z",
        event_uuid: "uuid-sent",
        dataset_id: "DS1",
        status: "sent",
        attempts: 1,
        max_attempts: 8,
        last_error: null,
        next_retry_at: new Date(0).toISOString(),
        sent_at: "2026-11-22T10:01:00.000Z",
        created_at: "2026-11-22T10:00:00.000Z",
      },
    ]);
    (tables.meta_crm_config[0] as Record<string, unknown>).auto_send_lead = true;
    (tables.meta_crm_config[0] as Record<string, unknown>).access_token = encrypt(CRM_TOKEN);
    const out = await maybeEnqueueInitialLeadEvent(db, {
      accountId: "acct-1",
      flowId: "flow-b",
      runId: "run-b",
      eventTimeIso: "2026-11-22T10:00:00.000Z",
    });
    expect(out).toMatchObject({ enqueued: true, deduplicated: true, eventId: "evt-sent" });
    expect(tables.meta_crm_events).toHaveLength(1);
  });
});
