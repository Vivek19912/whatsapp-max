// Meta Lead Ads — multi-tenant webhook routing guard.
//
// The `leadgen` webhook is a single, shared endpoint authenticated
// with ONE Meta App secret, so the tenant can only be established by
// the Page id. These tests pin that contract:
//   * a lead is stored under the account that owns the Page;
//   * an unknown Page is reported, never silently swallowed;
//   * an ambiguous Page mapping (pre-migration data / defence in
//     depth) still routes deterministically instead of dropping.
//
// A minimal fake Supabase client backs `recordLeadgenNotification`;
// no database or network is touched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordLeadgenNotification } from "./process-lead";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeDb(initial: Tables) {
  const data: Tables = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }

  function builder(table: string) {
    let op: "select" | "insert" = "select";
    let payload: unknown = null;
    const filters: Array<{ col: string; val: unknown; negate: boolean }> = [];
    let order: { col: string; asc: boolean } | null = null;

    const matches = (): Row[] => {
      const rows = (data[table] ?? []).filter((r) =>
        filters.every((f) => (f.negate ? r[f.col] !== f.val : r[f.col] === f.val)),
      );
      if (!order) return rows;
      const { col, asc } = order;
      return [...rows].sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    };

    const run = () => {
      if (op === "insert") {
        if (!data[table]) data[table] = [];
        const row: Row = { id: `row-${data[table].length + 1}`, ...(payload as Row) };
        data[table].push(row);
        return { data: null, error: null };
      }
      return { data: matches(), error: null };
    };

    const b = {
      select: () => b,
      insert: (p: unknown) => {
        op = "insert";
        payload = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val, negate: false });
        return b;
      },
      neq: (col: string, val: unknown) => {
        filters.push({ col, val, negate: true });
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        order = { col, asc: opts?.ascending !== false };
        return b;
      },
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    data,
  };
}

const PAGE = { account_id: "acct-1", page_id: "P1", created_at: "2026-01-01T00:00:00Z" };
const FORM = {
  id: "form-1",
  account_id: "acct-1",
  form_id: "F1",
  form_name: "Summer",
  enabled: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordLeadgenNotification — tenant routing", () => {
  it("stores the lead under the account that owns the Page", async () => {
    const { db, data } = makeDb({
      meta_lead_pages: [PAGE],
      meta_lead_forms: [FORM],
      meta_lead_submissions: [],
    });

    const res = await recordLeadgenNotification(db, {
      pageId: "P1",
      formId: "F1",
      leadgenId: "LEAD-1",
    });

    expect(res.outcome).toBe("received");
    expect(res.accountId).toBe("acct-1");
    expect(data.meta_lead_submissions).toHaveLength(1);
    expect(data.meta_lead_submissions[0].account_id).toBe("acct-1");
  });

  it("derives the tenant from the Page, never from the caller/payload", async () => {
    // Page is owned by acct-2; the webhook must resolve acct-2 even
    // though nothing in the notification references acct-2.
    const { db, data } = makeDb({
      meta_lead_pages: [
        { account_id: "acct-2", page_id: "P2", created_at: "2026-01-01T00:00:00Z" },
      ],
      meta_lead_forms: [
        { id: "form-2", account_id: "acct-2", form_id: "F2", form_name: "B", enabled: true },
      ],
      meta_lead_submissions: [],
    });

    const res = await recordLeadgenNotification(db, {
      pageId: "P2",
      formId: "F2",
      leadgenId: "LEAD-2",
    });

    expect(res.accountId).toBe("acct-2");
    expect(data.meta_lead_submissions[0].account_id).toBe("acct-2");
    // No row was written for the "default" tenant.
    expect(data.meta_lead_submissions.some((r) => r.account_id === "acct-1")).toBe(false);
  });

  it("reports (does not silently drop) an unknown Page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, data } = makeDb({
      meta_lead_pages: [],
      meta_lead_forms: [],
      meta_lead_submissions: [],
    });

    const res = await recordLeadgenNotification(db, {
      pageId: "GHOST",
      formId: "F1",
      leadgenId: "LEAD-3",
    });

    expect(res.outcome).toBe("no_page");
    expect(data.meta_lead_submissions).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("routes deterministically to the earliest connection on ambiguity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, data } = makeDb({
      meta_lead_pages: [
        { account_id: "acct-new", page_id: "P1", created_at: "2026-02-01T00:00:00Z" },
        { account_id: "acct-old", page_id: "P1", created_at: "2026-01-01T00:00:00Z" },
      ],
      meta_lead_forms: [
        { id: "form-old", account_id: "acct-old", form_id: "F1", form_name: "P", enabled: true },
      ],
      meta_lead_submissions: [],
    });

    const res = await recordLeadgenNotification(db, {
      pageId: "P1",
      formId: "F1",
      leadgenId: "LEAD-4",
    });

    // Never dropped — the old `.maybeSingle()` returned null here.
    expect(res.outcome).toBe("received");
    expect(res.accountId).toBe("acct-old");
    expect(data.meta_lead_submissions).toHaveLength(1);
    expect(data.meta_lead_submissions[0].account_id).toBe("acct-old");
    expect(warn).toHaveBeenCalled();
  });
});
