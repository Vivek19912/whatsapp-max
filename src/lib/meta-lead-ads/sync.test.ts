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
  failTokenFor: new Set<string>(),
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
  getPageToken: async (_db: unknown, accountId: string) => {
    if (h.failTokenFor.has(accountId)) throw new Error("page token missing");
    return "page-token";
  },
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

import {
  importFormLeads,
  pollFormLeads,
  runLeadPolls,
  selectPollForms,
  type SyncFormRow,
} from "./sync";

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
  h.failTokenFor = new Set();
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
      last_lead_at: "2026-01-01T00:00:00.000Z",
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

  it("does not advance the watermark when Meta fails", async () => {
    h.listError = new Error("temporary graph outage");
    const { db, data } = makeDb({
      meta_lead_forms: [
        {
          ...FORM,
          import_status: "done",
          last_lead_at: "2026-02-02T10:00:00Z",
        },
      ],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await pollFormLeads(db, CONFIG, {
      ...FORM,
      import_status: "done",
      last_lead_at: "2026-02-02T10:00:00Z",
    });

    expect(result.error).toContain("temporary graph outage");
    expect(data.meta_lead_forms[0].last_lead_at).toBe("2026-02-02T10:00:00Z");
    expect(data.meta_lead_forms[0].last_error).toContain(
      "temporary graph outage",
    );
  });

  it("walks every page of a burst larger than one page", async () => {
    h.pages = [
      {
        leads: [{ id: "B1", created_time: "2026-02-02T10:00:00Z" }],
        nextCursor: "c1",
      },
      {
        leads: [{ id: "B2", created_time: "2026-02-02T10:00:01Z" }],
        nextCursor: null,
      },
    ];
    const { db } = makeDb({
      meta_lead_forms: [{ ...FORM, import_status: "done" }],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await pollFormLeads(db, CONFIG, {
      ...FORM,
      import_status: "done",
    });

    expect(result.received).toBe(2);
    expect(h.listCalls.map((call) => call.after)).toEqual([null, "c1"]);
  });

  it("does not duplicate a lead already stored by the webhook", async () => {
    h.seen.add("W1");
    h.pages = [
      {
        leads: [{ id: "W1", created_time: "2026-02-02T10:00:00Z" }],
        nextCursor: null,
      },
    ];
    const { db } = makeDb({
      meta_lead_forms: [{ ...FORM, import_status: "done" }],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await pollFormLeads(db, CONFIG, {
      ...FORM,
      import_status: "done",
    });

    expect(result).toMatchObject({ received: 0, processed: 0, error: null });
    expect(h.seen.size).toBe(1);
  });
});

describe("runLeadPolls", () => {
  it("picks up a new lead automatically, without a manual Import", async () => {
    h.pages = [
      {
        leads: [{ id: "AUTO-1", created_time: "2026-02-03T10:00:00Z" }],
        nextCursor: null,
      },
    ];
    const { db, data } = makeDb({
      meta_lead_forms: [
        {
          ...FORM,
          import_status: "done",
          last_lead_at: "2026-02-02T10:00:00Z",
        },
      ],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await runLeadPolls(db, CONFIG);

    expect(result).toMatchObject({
      forms: 1,
      received: 1,
      processed: 1,
      errors: 0,
    });
    expect(h.seen.has("AUTO-1")).toBe(true);
    expect(data.meta_lead_forms[0].last_lead_at).toBe(
      "2026-02-03T10:00:00.000Z",
    );
  });

  it("does not poll a disabled form", async () => {
    const { db } = makeDb({
      meta_lead_forms: [
        { ...FORM, import_status: "done", enabled: false },
      ],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const result = await runLeadPolls(db, CONFIG);

    expect(result.forms).toBe(0);
    expect(h.listCalls).toEqual([]);
  });

  it("keeps polling other tenants when one form cannot get a token", async () => {
    h.failTokenFor.add("acct-1");
    h.pages = [
      {
        leads: [{ id: "TENANT-2", created_time: "2026-02-03T10:00:00Z" }],
        nextCursor: null,
      },
    ];
    const { db, data } = makeDb({
      meta_lead_forms: [
        { ...FORM, id: "row-1", import_status: "done" },
        {
          ...FORM,
          id: "row-2",
          account_id: "acct-2",
          page_id: "P2",
          form_id: "F2",
          import_status: "done",
        },
      ],
      meta_lead_pages: [
        { account_id: "acct-1", page_id: "P1" },
        { account_id: "acct-2", page_id: "P2" },
      ],
    });

    const result = await runLeadPolls(db, CONFIG);

    expect(result.forms).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.received).toBe(1);
    expect(h.seen.has("TENANT-2")).toBe(true);
    expect(
      data.meta_lead_forms.find((form) => form.id === "row-1")?.last_error,
    ).toContain("page token missing");
  });

  it("is idempotent across repeated sweeps", async () => {
    h.pages = [
      {
        leads: [{ id: "ONCE-1", created_time: "2026-02-03T10:00:00Z" }],
        nextCursor: null,
      },
      {
        leads: [{ id: "ONCE-1", created_time: "2026-02-03T10:00:00Z" }],
        nextCursor: null,
      },
    ];
    const { db } = makeDb({
      meta_lead_forms: [{ ...FORM, import_status: "done" }],
      meta_lead_pages: [{ account_id: "acct-1", page_id: "P1" }],
    });

    const first = await runLeadPolls(db, CONFIG);
    const second = await runLeadPolls(db, CONFIG);

    expect(first.received).toBe(1);
    expect(second.received).toBe(0);
    expect(h.seen.size).toBe(1);
  });

  it("rotates fairly across accounts instead of taking one tenant's oldest forms", async () => {
    const { db } = makeDb({
      meta_lead_forms: [
        { ...FORM, id: "a-oldest", account_id: "acct-a", form_id: "FA1", last_polled_at: null },
        { ...FORM, id: "a-newer", account_id: "acct-a", form_id: "FA2", last_polled_at: "2026-02-01T00:00:00Z" },
        { ...FORM, id: "b-oldest", account_id: "acct-b", form_id: "FB1", last_polled_at: null },
        { ...FORM, id: "c-oldest", account_id: "acct-c", form_id: "FC1", last_polled_at: "2026-02-02T00:00:00Z" },
        { ...FORM, id: "d-newest", account_id: "acct-d", form_id: "FD1", last_polled_at: "2026-02-03T00:00:00Z" },
      ],
      meta_lead_pages: [],
    });

    const selected = await selectPollForms(db, 4);

    expect(selected.map((form) => form.account_id).sort()).toEqual([
      "acct-a",
      "acct-b",
      "acct-c",
      "acct-d",
    ]);
    expect(selected.map((form) => form.id)).toContain("a-oldest");
    expect(selected.map((form) => form.id)).not.toContain("a-newer");
  });

  it("uses the SQL round-robin selector when available", async () => {
    const rpcArgs: Array<{ fn: string; limit: number }> = [];
    const rpcForms = [
      { ...FORM, id: "rpc-1", account_id: "acct-1", form_id: "F1" },
      { ...FORM, id: "rpc-2", account_id: "acct-2", form_id: "F2" },
    ];
    const rpcDb = {
      rpc: async (fn: string, args: { p_limit: number }) => {
        rpcArgs.push({ fn, limit: args.p_limit });
        return { data: rpcForms, error: null };
      },
    } as unknown as SupabaseClient;

    const selected = await selectPollForms(rpcDb, 5);

    expect(rpcArgs).toEqual([{ fn: "meta_lead_forms_for_poll", limit: 5 }]);
    expect(selected.map((form) => form.id)).toEqual(["rpc-1", "rpc-2"]);
  });

  it("processes one oldest form per tenant in a multi-tenant sweep", async () => {
    h.pages = Array.from({ length: 6 }, (_, index) => ({
      leads: [
        {
          id: `FAIR-${index + 1}`,
          created_time: "2026-02-03T10:00:00Z",
        },
      ],
      nextCursor: null,
    }));
    const forms = Array.from({ length: 6 }, (_, index) => ({
      ...FORM,
      id: `fair-${index + 1}`,
      account_id: `acct-${index + 1}`,
      page_id: `P${index + 1}`,
      form_id: `F${index + 1}`,
      import_status: "done",
      last_polled_at: null,
    }));
    const { db } = makeDb({
      meta_lead_forms: forms,
      meta_lead_pages: forms.map((form) => ({
        account_id: form.account_id,
        page_id: form.page_id,
      })),
    });

    const result = await runLeadPolls(db, CONFIG, 6);

    expect(result).toMatchObject({ forms: 6, received: 6, errors: 0 });
    const accounts = new Set(h.listCalls.map((call) => call.formId));
    expect(accounts.size).toBe(6);
  });
});
