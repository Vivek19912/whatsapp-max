// Meta Lead Ads — form question option persistence.
//
// Load My Forms must persist each question's option key/value pairs
// (verbatim, no guessing) so the table can render human-readable
// option labels later. A per-form Meta failure must not break the
// rest of the list, and previously stored questions survive it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  pages: [{ account_id: "acct-1", page_id: "1029384756" }],
  forms: [] as Row[],
  listError: null as unknown,
  detailErrorFor: new Set<string>(),
}));

function matches(rows: Row[], filters: Array<[string, unknown]>) {
  return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
}

function table(name: string): Row[] {
  if (name === "meta_lead_pages") return h.pages;
  return h.forms;
}

function builder(tableName: string) {
  const filters: Array<[string, unknown]> = [];
  const matched = () => matches(table(tableName), filters);
  let pendingPatch: Row | null = null;
  const applyPending = () => {
    if (pendingPatch) {
      for (const r of matched()) Object.assign(r, pendingPatch);
      pendingPatch = null;
    }
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return b;
    },
    order: () => b,
    maybeSingle: async () => {
      applyPending();
      return { data: matched()[0] ?? null, error: null };
    },
    single: async () => {
      applyPending();
      return { data: matched()[0] ?? null, error: null };
    },
    insert: (row: Row) => {
      h.forms.push({ id: `row-${h.forms.length + 1}`, ...row });
      return { select: () => ({ single: async () => ({ data: null, error: null }) }) };
    },
    update: (patch: Row) => {
      // Deferred like the real client: filters chain after update().
      pendingPatch = patch;
      return b;
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      applyPending();
      return Promise.resolve({ data: matched(), error: null }).then(
        res as (v: unknown) => unknown,
        rej as ((e: unknown) => unknown) | undefined,
      );
    },
  };
  return b;
}

const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({ supabase: db, accountId: h.accountId, userId: "u1" }),
  requireRole: async () => ({ supabase: db, accountId: h.accountId, userId: "u1" }),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 }),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => db,
}));

vi.mock("@/lib/meta-lead-ads/graph-client", () => ({
  listForms: async () => {
    if (h.listError) throw h.listError;
    return [
      { id: "F1", name: "Form One" },
      { id: "F2", name: "Form Two" },
    ];
  },
  getForm: async (_c: unknown, _t: string, formId: string) => {
    if (h.detailErrorFor.has(formId)) throw new Error("meta down");
    return {
      id: formId,
      name: formId === "F1" ? "Form One" : "Form Two",
      questions: [
        {
          key: "service",
          label: "Which service?",
          type: "CUSTOM",
          options: [{ key: "adobe_premiere_pro", value: "Adobe Premiere Pro" }],
        },
      ],
    };
  },
  getPage: async () => ({ id: "1029384756", name: "Page" }),
  getPageSubscriptions: async () => true,
  subscribePageToLeadgen: async () => true,
  unsubscribePageFromLeadgen: async () => true,
  probeFormLeadAccess: async () => true,
  getDataset: async () => ({ id: "D1" }),
  listFormLeads: async () => ({ leads: [], nextCursor: null }),
  getLead: async () => ({ id: "L1" }),
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getPageToken: async () => "page-token",
  getUserToken: async () => "user-token",
}));

vi.mock("@/lib/meta-lead-ads/sync", () => ({
  getFormForImport: async () => null,
  importFormLeads: async () => ({ imported: 0, processed: 0, failed: 0, hasMore: false, error: null }),
}));

vi.mock("@/lib/meta-lead-ads/virtual-flow", () => ({
  ensureVirtualFlow: async () => "flow-1",
}));

vi.mock("@/lib/api/v1/contacts", () => ({
  resolveAuditUserId: async () => "u1",
}));

vi.mock("@/lib/meta-lead-ads/config", () => ({
  metaLeadAdsConfig: () => ({
    appId: "1",
    appSecret: "s",
    webhookVerifyToken: "v",
    graphVersion: "v26.0",
  }),
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("https://app.test/api/integrations/meta-lead-ads/forms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.pages = [{ account_id: "acct-1", page_id: "1029384756" }];
  h.forms = [];
  h.listError = null;
  h.detailErrorFor = new Set<string>();
  process.env.META_LEAD_ADS_APP_ID = "1";
  process.env.META_LEAD_ADS_APP_SECRET = "s";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "v";
  process.env.META_GRAPH_VERSION = "v26.0";
});

describe("POST /forms — option metadata refresh", () => {
  it("stores option key/value pairs verbatim for new and existing forms", async () => {
    h.forms = [
      {
        id: "row-old",
        account_id: "acct-1",
        page_id: "1029384756",
        form_id: "F1",
        form_name: "Form One",
        questions: [{ key: "service", label: "Which service?", type: "CUSTOM" }],
        enabled: true,
      },
    ];

    const res = await POST(post({ page_id: "1029384756" }));
    expect(res.status).toBe(200);

    const f1 = h.forms.find((f) => f.form_id === "F1");
    const f2 = h.forms.find((f) => f.form_id === "F2");
    expect(f1?.questions).toEqual([
      {
        key: "service",
        label: "Which service?",
        type: "CUSTOM",
        options: [{ key: "adobe_premiere_pro", value: "Adobe Premiere Pro" }],
      },
    ]);
    // A newly discovered form also stores its options.
    expect((f2?.questions as Array<Record<string, unknown>>)?.[0]).toMatchObject({
      key: "service",
      options: [{ key: "adobe_premiere_pro", value: "Adobe Premiere Pro" }],
    });
  });

  it("a per-form Meta failure does not break the rest of the list", async () => {
    h.detailErrorFor.add("F1");

    const res = await POST(post({ page_id: "1029384756" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { forms: Array<{ formId: string }> };
    expect(json.forms.map((f) => f.formId).sort()).toEqual(["F1", "F2"]);
    // F2 still got its options.
    const f2 = h.forms.find((f) => f.form_id === "F2");
    expect(f2?.questions).toEqual([
      {
        key: "service",
        label: "Which service?",
        type: "CUSTOM",
        options: [{ key: "adobe_premiere_pro", value: "Adobe Premiere Pro" }],
      },
    ]);
  });

  it("never exposes tokens in the response", async () => {
    const res = await POST(post({ page_id: "1029384756" }));
    expect(JSON.stringify(await res.json())).not.toContain("page-token");
  });

  it("leaves another account's forms untouched", async () => {
    h.forms = [
      {
        id: "row-foreign",
        account_id: "acct-2",
        page_id: "1029384756",
        form_id: "F1",
        form_name: "Form One",
        questions: [],
        enabled: true,
      },
    ];

    const res = await POST(post({ page_id: "1029384756" }));
    expect(res.status).toBe(200);
    // The foreign row still has no options; only this account's rows refresh.
    expect(
      h.forms.find((f) => f.id === "row-foreign")?.questions,
    ).toEqual([]);
    expect(
      h.forms.filter((f) => f.account_id === "acct-1" && f.form_id === "F1"),
    ).toHaveLength(1);
  });
});

