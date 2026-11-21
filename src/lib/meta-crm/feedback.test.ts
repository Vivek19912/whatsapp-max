// Meta CRM feedback — enqueue/drain/config contracts.
//
// Uses an in-memory Supabase double; Meta is mocked via fetchImpl
// or module mocks. No network, no tokens persisted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linkage: true as boolean,
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
    isDatasetUnderBusiness: async () => h.linkage,
  };
});

import {
  drainCrmEventsQueue,
  enqueueLeadQualityEvent,
  getCrmFeedbackConfig,
  saveCrmFeedbackConfig,
} from "./feedback";

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const ops: Array<{ table: string; op: string }> = [];
  let seq = 100;

  function matches(row: Row, filters: Array<[string, unknown]>): boolean {
    return filters.every(([c, v]) => {
      if (c === "__lte_next_retry") return true;
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
  h.linkage = true;
  h.token = "STORED_TOKEN";
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
      meta_lead_id: "LEAD1",
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
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292" }],
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
          user_data: { lead_id: "LEAD1" },
          event_id: "uuid-evt-1",
        });
        return jsonResponse({ events_received: 1 });
      }) as unknown as typeof fetch,
    });
    expect(out).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(seen).toEqual(["Bearer STORED_TOKEN"]);
    expect(tables.meta_crm_events[0].status).toBe("sent");
    expect(tables.meta_crm_events[0].attempts).toBe(1);
    expect(JSON.stringify(tables).includes("STORED_TOKEN")).toBe(false);
  });

  it("marks auth failures failed with backoff and preserves identity", async () => {
    const { db, tables } = makeDb({
      meta_crm_events: [seedEvent()],
      meta_crm_config: [{ account_id: "acct-1", enabled: true, dataset_id: "1830596054845292" }],
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
});

describe("saveCrmFeedbackConfig", () => {
  it("enables only after ownership verification with the stored token", async () => {
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
    });
    expect(ownershipVerified).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.dataset_id).toBe("1830596054845292");
    expect(config.verified_at).not.toBeNull();
    expect(h.tokenCalls).toBeGreaterThan(0);
    expect(tables.meta_crm_config).toHaveLength(1);
  });

  it("refuses to enable when ownership cannot be verified", async () => {
    h.linkage = false;
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
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(tables.meta_crm_config[0]?.enabled).toBe(false);
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
});
