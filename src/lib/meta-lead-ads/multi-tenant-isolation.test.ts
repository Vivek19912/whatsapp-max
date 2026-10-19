// Meta Lead Ads — two-company webhook isolation and replay guard.
//
// A shared endpoint must route competing tenants only through Page
// ownership, and a replayed Meta delivery must not create a second lead.
//
// Uses an in-memory ledger that enforces the production unique key
// (account_id, meta_lead_id); no database or Meta network is touched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { recordLeadgenNotification } from "./process-lead";

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }

  function builder(table: string) {
    let op: "select" | "insert" = "select";
    let payload: Row = {};
    const filters: Array<{ col: string; val: unknown }> = [];
    let order: { col: string; asc: boolean } | null = null;

    const matched = () => {
      const rows = (data[table] ?? []).filter((row) =>
        filters.every((f) => row[f.col] === f.val),
      );
      if (!order) return rows;
      return [...rows].sort((a, b) => {
        const av = String(a[order!.col]);
        const bv = String(b[order!.col]);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (order!.asc ? 1 : -1);
      });
    };

    const b = {
      select: () => b,
      insert: (p: Row) => {
        op = "insert";
        payload = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        order = { col, asc: opts?.ascending !== false };
        return b;
      },
      limit: () => b,
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (op === "insert") {
          if (table === "meta_lead_submissions") {
            const duplicate = (data[table] ?? []).some(
              (row) =>
                row.account_id === payload.account_id &&
                row.meta_lead_id === payload.meta_lead_id,
            );
            if (duplicate) {
              return Promise.resolve({
                data: null,
                error: { code: "23505" },
              }).then(res, rej);
            }
          }
          const row = { id: `sub-${(data[table] ?? []).length + 1}`, ...payload };
          if (!data[table]) data[table] = [];
          data[table].push(row);
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: matched(), error: null }).then(res, rej);
      },
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    data,
  };
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("two-company webhook isolation", () => {
  it("routes Company A and Company B leads to their own workspaces", async () => {
    const { db, data } = makeDb({
      meta_lead_pages: [
        { account_id: "acct-A", page_id: "PAGE-A", created_at: "2026-01-01T00:00:00Z" },
        { account_id: "acct-B", page_id: "PAGE-B", created_at: "2026-01-01T00:00:00Z" },
      ],
      meta_lead_forms: [
        { id: "form-A", account_id: "acct-A", form_id: "FORM-A", enabled: true },
        { id: "form-B", account_id: "acct-B", form_id: "FORM-B", enabled: true },
      ],
      meta_lead_submissions: [],
    });

    const a = await recordLeadgenNotification(db, {
      pageId: "PAGE-A",
      formId: "FORM-A",
      leadgenId: "LEAD-A-1",
    });
    const b = await recordLeadgenNotification(db, {
      pageId: "PAGE-B",
      formId: "FORM-B",
      leadgenId: "LEAD-B-1",
    });

    expect(a).toMatchObject({ outcome: "received", accountId: "acct-A" });
    expect(b).toMatchObject({ outcome: "received", accountId: "acct-B" });
    expect(data.meta_lead_submissions).toHaveLength(2);
    expect(
      data.meta_lead_submissions.map((row) => `${row.account_id}:${row.meta_lead_id}`),
    ).toEqual(["acct-A:LEAD-A-1", "acct-B:LEAD-B-1"]);
  });

  it("treats a replayed delivery as a duplicate without a second lead row", async () => {
    const { db, data } = makeDb({
      meta_lead_pages: [
        { account_id: "acct-A", page_id: "PAGE-A", created_at: "2026-01-01T00:00:00Z" },
      ],
      meta_lead_forms: [
        { id: "form-A", account_id: "acct-A", form_id: "FORM-A", enabled: true },
      ],
      meta_lead_submissions: [],
    });

    const first = await recordLeadgenNotification(db, {
      pageId: "PAGE-A",
      formId: "FORM-A",
      leadgenId: "LEAD-A-1",
    });
    data.meta_lead_submissions[0].status = "processed";
    const replay = await recordLeadgenNotification(db, {
      pageId: "PAGE-A",
      formId: "FORM-A",
      leadgenId: "LEAD-A-1",
    });

    expect(first.outcome).toBe("received");
    expect(replay.outcome).toBe("duplicate");
    expect(replay.inserted).toBe(false);
    expect(data.meta_lead_submissions).toHaveLength(1);
  });

  it("does not store a lead for an unknown Page", async () => {
    const { db, data } = makeDb({
      meta_lead_pages: [],
      meta_lead_forms: [],
      meta_lead_submissions: [],
    });

    const res = await recordLeadgenNotification(db, {
      pageId: "PAGE-GHOST",
      formId: "FORM-A",
      leadgenId: "LEAD-X",
    });

    expect(res.outcome).toBe("no_page");
    expect(data.meta_lead_submissions).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
