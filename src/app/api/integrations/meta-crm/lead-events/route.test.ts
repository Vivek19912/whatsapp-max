// GET /api/integrations/meta-crm/lead-events — per-lead delivery states.
//
// Read-only: latest ledger row per event name for one run. Powers
// the Lead Quality dropdown badges (Sent / Queued / Failed). Never
// sends, never writes, never touches Meta.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  role: "agent" as string,
  run: null as null | Record<string, unknown>,
  events: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
  config: null as null | Record<string, unknown>
}));

type Filter = [string, unknown];

type Row = Record<string, unknown>;

function storeFor(table: string): Row[] {
  if (table === "flow_runs") return h.run ? [h.run] : [];
  if (table === "meta_crm_config") return h.config ? [h.config] : [];
  if (table === "meta_lead_submissions") return h.submissions;
  return h.events;
}
function matches(rows: Row[], filters: Filter[]) {
  return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
}

function chain(table: string, filters: Filter[] = [], sort: { col: string; asc: boolean } | null = null) {
  const api: Record<string, (...a: never[]) => unknown> = {
    select: () => chain(table, filters, sort),
    eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]], sort),
    order: (c: string, opts?: { ascending?: boolean }) => chain(table, filters, { col: c, asc: opts?.ascending ?? true }),
    maybeSingle: async () => ({ data: matches(storeFor(table), filters)[0] ?? null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
      let rows = matches(storeFor(table), filters);
      if (sort) {
        rows = [...rows].sort((a, b) =>
          sort.asc
            ? String(a[sort.col] ?? "") < String(b[sort.col] ?? "") ? -1 : 1
            : String(a[sort.col] ?? "") > String(b[sort.col] ?? "") ? -1 : 1,
        );
      }
      return resolve({ data: rows, error: null });
    },
  };
  return api;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => {
    if (h.role !== "agent" && h.role !== "owner" && h.role !== "admin") {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    return {
      supabase: { from: (t: string) => ({ select: () => chain(t) }) },
      accountId: h.accountId,
      userId: "u1",
      role: h.role,
    };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

const { GET } = await import("./route");

const url = (q: string) => new Request(`https://app.test/api/integrations/meta-crm/lead-events?${q}`);

beforeEach(() => {
  h.accountId = "acct-1";
  h.role = "agent";
  h.run = { id: "run-1", account_id: "acct-1", flow_id: "flow-1" };
  h.submissions = [
    { id: "sub-1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "M1" },
    { id: "sub-2", account_id: "acct-1", flow_run_id: "run-2", meta_lead_id: "M1" },
  ];
  h.config = { account_id: "acct-1", enabled: true, dataset_id: "DS1" };
  h.events = [
    { id: "e1", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "M1", dataset_id: "DS1", event_name: "Lead", status: "sent", sent_at: "2026-11-22T10:00:00.000Z", created_at: "2026-11-22T10:00:00.000Z" },
    { id: "e2", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "M1", dataset_id: "DS1", event_name: "InterestedLead", status: "pending", sent_at: null, created_at: "2026-11-22T11:00:00.000Z" },
    { id: "e3-old", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "M1", dataset_id: "DS1", event_name: "InterestedLead", status: "failed", sent_at: null, created_at: "2026-11-21T10:00:00.000Z" },
    { id: "e4-foreign", account_id: "acct-2", flow_run_id: "run-1", meta_lead_id: "M1", dataset_id: "DS1", event_name: "QualifiedLead", status: "sent", sent_at: "2026-11-22T10:00:00.000Z", created_at: "2026-11-22T10:00:00.000Z" },
    { id: "e5-table-b", account_id: "acct-1", flow_run_id: "run-2", meta_lead_id: "M1", dataset_id: "DS1", event_name: "InterestedLead", status: "sent", sent_at: "2026-11-22T12:00:00.000Z", created_at: "2026-11-22T12:00:00.000Z" },
    { id: "e6-other-dataset", account_id: "acct-1", flow_run_id: "run-1", meta_lead_id: "M1", dataset_id: "DS2", event_name: "QualifiedLead", status: "sent", sent_at: "2026-11-22T10:00:00.000Z", created_at: "2026-11-22T10:00:00.000Z" },
    { id: "e7-other-lead", account_id: "acct-1", flow_run_id: "run-9", meta_lead_id: "M9", dataset_id: "DS1", event_name: "Junk", status: "sent", sent_at: "2026-11-22T10:00:00.000Z", created_at: "2026-11-22T10:00:00.000Z" },
  ];
});

describe("GET /api/integrations/meta-crm/lead-events", () => {
  it("returns the latest row per event name for the lead — across tables", async () => {
    // e5 was sent from Table B (run-2) for the same Meta lead: run-1
    // badges must show it as sent instead of the older pending row.
    const res = await GET(url("flow_id=flow-1&run_id=run-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; events: Array<{ eventName: string; status: string }> };
    expect(json.ok).toBe(true);
    expect(json.events).toEqual([
      { eventName: "InterestedLead", status: "sent", sentAt: "2026-11-22T12:00:00.000Z", updatedAt: expect.any(String) },
      { eventName: "Lead", status: "sent", sentAt: "2026-11-22T10:00:00.000Z", updatedAt: expect.any(String) },
    ]);
  });

  it("requires flow and run ids and isolates tenants", async () => {
    expect((await GET(url("flow_id=flow-1"))).status).toBe(400);
    // Foreign run (or missing run) reads as not found, never leaks.
    h.run = { id: "run-9", account_id: "acct-OTHER", flow_id: "flow-1" };
    expect((await GET(url("flow_id=flow-1&run_id=run-9"))).status).toBe(404);
    h.run = null;
    expect((await GET(url("flow_id=flow-1&run_id=run-1"))).status).toBe(404);
  });

  it("rejects unauthenticated callers", async () => {
    h.role = "";
    expect((await GET(url("flow_id=flow-1&run_id=run-1"))).status).toBe(403);
  });

  it("scopes badges to the configured dataset", async () => {
    h.config = { account_id: "acct-1", enabled: true, dataset_id: "DS2" };
    const res = await GET(url("flow_id=flow-1&run_id=run-1"));
    const json = (await res.json()) as { events: Array<{ eventName: string }> };
    expect(json.events.map((e) => e.eventName)).toEqual(["QualifiedLead"]);
  });

  it("falls back to run rows when no submission or config exists", async () => {
    h.submissions = [];
    h.config = null;
    const res = await GET(url("flow_id=flow-1&run_id=run-1"));
    const json = (await res.json()) as { events: Array<{ eventName: string; status: string }> };
    expect(json.events.map((e) => e.eventName).sort()).toEqual(["InterestedLead", "Lead", "QualifiedLead"]);
  });
});
