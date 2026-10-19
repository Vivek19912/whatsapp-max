// Meta Lead Ads — historical import + polling.
//
// These tests exercise the sync loop against an in-memory Supabase
// stub and mocked Graph/processing functions:
//   * every page of an import is ingested and the cursor is persisted;
//   * re-seeing an existing lead never increments `imported_count`;
//   * a Graph failure leaves the form in a resumable `error` state;
//   * polling records new leads and advances `last_lead_at`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaLeadAdsConfig } from "./config";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  seen: new Set<string>(),
  pages: [] as Array<{
    leads: Array<{ id: string; created_time?: string }>;
    nextCursor: string | null;
  }>,
  listError: null as Error | null,
  listCalls: [] as Array<{ formId: string; after: string | null }>,
}));

vi.mock("./graph-client", () => ({
  listFormLeads: async (
    _config: unknown,
    _token: string,
    formId: string,
    opts: { after?: string | null } = {},
  ) => {
    h.listCalls.push({ formId, after: opts.after ?? null });
    if (h.listError) throw h.listError;
    return h.pages.shift() ?? { leads: [], nextCursor: null };
  },
}));

vi.mock("./store", () => ({
  getPageToken: async () => "page-token",
}));

vi.mock("./process-lead", () => ({
  recordLeadgenNotification: async (
    _db: unknown,
    input: { leadgenId: string },
  ) => {
    const inserted = !h.seen.has(input.leadgenId);
    if (inserted) h.seen.add(input.leadgenId);
    return {
      outcome: inserted ? "received" : "duplicate",
      submissionId: inserted ? `sub-${input.leadgenId}` : null,
      accountId: "acct-1",
      inserted,
    };
  },
  processSubmissionById: async () => ({ outcome: "processed" }),
}));

import { importFormLeads, pollFormLeads, type SyncFormRow } from "./sync";

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }

  function builder(table: string) {
    let op: "select" | "update" = "select";
    let patch: Row = {};
    const filters: Array<{ col: string; val: unknown }> = [];

    const matched = () =>
      (data[table] ?? []).filter((r) => filters.every((f) => r[f.col] === f.val));

    const b = {
      select: () => b,
      update: (p: Row) => {
        op = "update";
        patch = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return b;
      },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === "update") {
          for (const row of matched()) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: matched(), error: null }).then(res, rej);
      },
    };
    return b;
  }

  return { db: { from: (t: string) => builder(t) } as unknown as SupabaseClient, data };
}

const CONFIG: MetaLeadAdsConfig = {
  appId: "1",
  appSecret: "secret",
  webhookVerifyToken: "verify",
  graphVersion: "v21.0",
};

const FORM: SyncFormRow = {
  id: "row-1",
  account_id: "acct-1",
  page_id: "P1",
  form_id: "F1",
  form_name: "Summer",
  enabled: true,
  import_status: "importing",
  import_cursor: null,
  imported_count: 0,
  last_lead_at: null,
  last_polled_at: null,
};

beforeEach(() => {
  h.seen = new Set();
  h.pages = [];
  h.listError = null;
  h.listCalls = [];
});

describe("importFormLeads", () => {
  it("walks every page and persists the cursor + counts", async () => {
    h.pages = [
      {
        leads: [{ id: "L1", created_time: "2026-01-01T00:00:00Z" }, { id: "L2" }],
        nextCursor: "c1",
      },
      { leads: [{ id: "L3" }], nextCursor: null },
    ];
    const { db, data } = makeDb({
      meta_lead_forms: [{ ...FORM }],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await importFormLeads(db, CONFIG, {
      accountId: "acct-1",
      form: { ...FORM },
      maxPages: 2,
    });

    expect(result).toMatchObject({
      imported: 3,
      processed: 3,
      failed: 0,
      hasMore: false,
      error: null,
    });
    expect(h.listCalls).toEqual([
      { formId: "F1", after: null },
      { formId: "F1", after: "c1" },
    ]);
    expect(data.meta_lead_forms[0]).toMatchObject({
      import_status: "done",
      import_cursor: null,
      imported_count: 3,
      last_error: null,
    });
  });

  it("does not count leads that already exist", async () => {
    h.seen.add("L1");
    h.pages = [{ leads: [{ id: "L1" }, { id: "L2" }], nextCursor: null }];
    const { db, data } = makeDb({
      meta_lead_forms: [{ ...FORM }],
      meta_lead_pages: [],
    });

    const result = await importFormLeads(db, CONFIG, {
      accountId: "acct-1",
      form: { ...FORM },
    });

    expect(result.imported).toBe(1);
    expect(data.meta_lead_forms[0].imported_count).toBe(1);
  });

  it("leaves a resumable error state when Meta fails", async () => {
    h.listError = new Error("graph down");
    const { db, data } = makeDb({
      meta_lead_forms: [{ ...FORM }],
      meta_lead_pages: [],
    });

    const result = await importFormLeads(db, CONFIG, {
      accountId: "acct-1",
      form: { ...FORM },
    });

    expect(result.error).toContain("graph down");
    expect(data.meta_lead_forms[0]).toMatchObject({
      import_status: "error",
      last_error: "graph down",
    });
  });
});

describe("pollFormLeads", () => {
  it("records new leads and advances last_lead_at", async () => {
    h.pages = [
      {
        leads: [{ id: "N1", created_time: "2026-02-02T10:00:00Z" }],
        nextCursor: null,
      },
    ];
    const { db, data } = makeDb({
      meta_lead_forms: [{ ...FORM, import_status: "done" }],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1", last_polled_at: null }],
    });

    const result = await pollFormLeads(db, CONFIG, {
      ...FORM,
      import_status: "done",
    });

    expect(result).toMatchObject({ received: 1, processed: 1, error: null });
    expect(data.meta_lead_forms[0].last_lead_at).toBe(
      "2026-02-02T10:00:00.000Z",
    );
    expect(data.meta_lead_forms[0].last_polled_at).toBeTruthy();
    expect(data.meta_lead_pages[0].last_polled_at).toBeTruthy();
  });
});
