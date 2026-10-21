// Meta Lead Ads ingestion → automatic Lead Assignment (end to end).
//
// Pins the integration contract: a newly processed lead is assigned
// through the account's active rule for its table (owner lands in
// the Assigned To cell + audit event), duplicates/updates never
// reassign, and assignment can never fail lead processing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processSubmissionById } from "./process-lead";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
}));

vi.mock("./graph-client", () => ({
  getLead: async () => ({
    id: "L1",
    platform: "facebook",
    field_data: [],
    created_time: "2026-10-20T10:00:00+00:00",
  }),
}));

vi.mock("@/lib/meta-capi/triggers", () => ({
  onMetaLeadReceived: async () => {},
}));

vi.mock("@/lib/api/v1/contacts", () => ({
  resolveAuditUserId: async () => "owner-1",
}));

vi.mock("./store", () => ({
  getPageToken: async () => "page-token",
  markNeedsReauth: async () => {},
}));

vi.mock("./virtual-flow", () => ({
  ensureVirtualFlow: async () => "flow-1",
  META_SOURCE_COLUMN_KEY: "meta_lead_source",
  parseFormQuestions: (raw: unknown) => (Array.isArray(raw) ? raw : []),
}));

function makeDb() {
  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown, boolean]> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;

    const matched = () =>
      (h.tables[table] ?? []).filter(
        (r) =>
          filters.every(([c, v, negate]) =>
            negate ? r[c as string] !== v : r[c as string] === v,
          ) &&
          (!inFilter || (inFilter.vals as unknown[]).includes(r[inFilter.col])),
      );

    const apply = () => {
      if (op === "insert") {
        h.seq += 1;
        const defaults =
          table === "lead_assignment_table_state"
            ? { rr_cursor: 0, current_weights: {}, version: 0 }
            : {};
        const row: Row = { id: `row-${h.seq}`, ...defaults, ...payload };
        (h.tables[table] ??= []).push(row);
        // single()/maybeSingle() resolve to the inserted row itself.
        return { data: row, error: null };
      }
      if (op === "update") {
        const rows = matched();
        for (const row of rows) Object.assign(row, payload);
        return { data: rows, error: null };
      }
      return { data: matched(), error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => {
        op = "update";
        payload = p;
        return b;
      },
      insert: (p: Row) => {
        op = "insert";
        payload = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v, false] as never);
        return b;
      },
      neq: (c: string, v: unknown) => {
        filters.push([c, v, true] as never);
        return b;
      },
      in: (c: string, vals: unknown[]) => {
        inFilter = { col: c, vals };
        return b;
      },
      or: () => b,
      is: () => b,
      not: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const r = apply();
        const data = r.data as Row | Row[] | null;
        return { data: (Array.isArray(data) ? data[0] : data) ?? null, error: null };
      },
      single: async () => {
        const r = apply();
        const data = r.data as Row | Row[] | null;
        return { data: (Array.isArray(data) ? data[0] : data) ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(apply()).then(res, rej),
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const CONFIG = {
  appId: "1",
  appSecret: "s",
  webhookVerifyToken: "v",
  graphVersion: "v26.0",
  apiVersion: "v26.0",
} as never;

function seed() {
  h.tables = {
    meta_lead_submissions: [
      {
        id: "sub-1",
        account_id: "acct-1",
        meta_lead_id: "L1",
        page_id: "P1",
        form_id: "F1",
        form_name: "Hiring",
        status: "received",
        attempts: 0,
        claimed_at: null,
      },
    ],
    meta_lead_connections: [],
    meta_lead_forms: [
      {
        id: "form-1",
        account_id: "acct-1",
        form_id: "F1",
        form_name: "Hiring",
        enabled: true,
        questions: [],
      },
    ],
    meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    flow_runs: [],
    workspace_fields: [
      { id: "f-assign", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" },
    ],
    workspace_values: [],
    profiles: [
      { user_id: "u-mohan", account_id: "acct-1", account_role: "agent" },
      { user_id: "u-sohan", account_id: "acct-1", account_role: "agent" },
    ],
    lead_assignment_rules: [
      {
        id: "rule-1",
        account_id: "acct-1",
        name: "Video",
        scope: "specific",
        mode: "round_robin",
        status: "active",
        created_by: "admin-1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    lead_assignment_rule_tables: [{ rule_id: "rule-1", form_id: "form-1" }],
    lead_assignment_rule_members: [
      { rule_id: "rule-1", user_id: "u-mohan", position: 0, weight: 0 },
      { rule_id: "rule-1", user_id: "u-sohan", position: 1, weight: 0 },
    ],
    lead_assignment_table_state: [],
    lead_assignment_events: [],
    whatsapp_config: [],
  };
  h.seq = 0;
}

beforeEach(seed);

describe("processSubmissionById → automatic assignment", () => {
  it("assigns the new lead via the table rule and audits it", async () => {
    const db = makeDb();
    const res = await processSubmissionById(db, CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");

    const runId = (h.tables.flow_runs[0] as Row).id as string;
    expect(h.tables.workspace_values).toHaveLength(1);
    expect(h.tables.workspace_values[0]).toMatchObject({
      account_id: "acct-1",
      field_id: "f-assign",
      flow_run_id: runId,
      value_text: "u-mohan",
    });
    expect(h.tables.lead_assignment_events).toHaveLength(1);
    expect(h.tables.lead_assignment_events[0]).toMatchObject({
      kind: "auto",
      rule_id: "rule-1",
      flow_run_id: runId,
      form_id: "form-1",
      assigned_user_id: "u-mohan",
    });
    // Per-table cursor advanced exactly once.
    expect(h.tables.lead_assignment_table_state).toHaveLength(1);
    expect(h.tables.lead_assignment_table_state[0]).toMatchObject({
      rule_id: "rule-1",
      form_id: "form-1",
      rr_cursor: 1,
    });
  });

  it("reprocessing the same submission never reassigns", async () => {
    const db = makeDb();
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("processed");
    expect((await processSubmissionById(db, CONFIG, "sub-1")).outcome).toBe("skipped");
    expect(h.tables.workspace_values).toHaveLength(1);
    expect(h.tables.lead_assignment_events).toHaveLength(1);
  });

  it("leaves the lead unassigned (but processed) when no rule applies", async () => {
    h.tables.lead_assignment_rules = [];
    const db = makeDb();
    const res = await processSubmissionById(db, CONFIG, "sub-1");
    expect(res.outcome).toBe("processed");
    expect(h.tables.flow_runs).toHaveLength(1);
    expect(h.tables.workspace_values).toHaveLength(0);
  });
});
