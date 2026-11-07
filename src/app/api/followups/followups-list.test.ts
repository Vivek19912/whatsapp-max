import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

// ---------------------------------------------------------------------------
// GET /api/followups enrichment: display-state views (delivered/read
// are receipt-derived, never DB statuses), agent scoping, counts,
// templates, batched creator profiles (email admin+ only), search,
// filters, and null-safe Workspace context. Supabase is an
// in-memory store behind a builder honoring the route's chains.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  role: "admin",
  userId: "user-admin",
  store: {} as Record<string, Array<Record<string, unknown>>>,
  idSeq: 1,
  queries: [] as Array<{ table: string; op: string; detail?: unknown }>,
}));

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...mod,
    getCurrentAccount: async () => ({
      supabase: mockClient(),
      userId: h.userId,
      accountId: "acct-1",
      role: h.role,
    }),
  };
});

type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "is"; col: string }
  | { kind: "notnull"; col: string }
  | { kind: "gte"; col: string; val: string }
  | { kind: "lte"; col: string; val: string }
  | { kind: "ilike"; col: string; val: string }
  | { kind: "in"; col: string; vals: unknown[] }
  | { kind: "or"; clauses: Array<{ col: string; op: string; val: string }> };

function parseOr(clause: string): Filter {
  // Split on top-level commas (created_by.in.(a,b) contains one).
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of clause) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return {
    kind: "or",
    clauses: parts.map((p) => {
      const m = /^(\w+)\.(ilike|in|eq)\.(.*)$/.exec(p);
      if (!m) throw new Error(`unparseable or-part: ${p}`);
      return { col: m[1], op: m[2], val: m[3] };
    }),
  };
}

function matchOr(row: Record<string, unknown>, col: string, op: string, val: string): boolean {
  const cell = row[col];
  if (op === "ilike") {
    const needle = val.replace(/^%|%$/g, "").toLowerCase();
    return typeof cell === "string" && cell.toLowerCase().includes(needle);
  }
  if (op === "in") {
    const list = val.replace(/^\(|\)$/g, "").split(",");
    return list.includes(String(cell));
  }
  return String(cell) === val;
}

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    switch (f.kind) {
      case "eq":
        return row[f.col] === f.val;
      case "is":
        return row[f.col] == null;
      case "notnull":
        return row[f.col] != null;
      case "gte":
        return String(row[f.col] ?? "") >= f.val;
      case "lte":
        return String(row[f.col] ?? "") <= f.val;
      case "ilike": {
        const needle = f.val.replace(/^%|%$/g, "").toLowerCase();
        const cell = row[f.col];
        return typeof cell === "string" && cell.toLowerCase().includes(needle);
      }
      case "in":
        return f.vals.includes(row[f.col]);
      case "or":
        return f.clauses.some((c) => matchOr(row, c.col, c.op, c.val));
    }
  });
}

function mockClient() {
  const from = (table: string) => {
    const filters: Filter[] = [];
    let orderCol = "";
    let orderAsc = true;
    let limitN = Number.POSITIVE_INFINITY;
    let headCount = false;
    const api: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) headCount = true;
        return api;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return api;
      },
      is: (col: string, val: null) => {
        filters.push({ kind: "is", col });
        return api;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op === "is" && val === null) filters.push({ kind: "notnull", col });
        return api;
      },
      gte: (col: string, val: string) => {
        filters.push({ kind: "gte", col, val });
        return api;
      },
      lte: (col: string, val: string) => {
        filters.push({ kind: "lte", col, val });
        return api;
      },
      ilike: (col: string, val: string) => {
        filters.push({ kind: "ilike", col, val });
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        h.queries.push({ table, op: "in", detail: col });
        filters.push({ kind: "in", col, vals });
        return api;
      },
      or: (clause: string) => {
        filters.push(parseOr(clause));
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      maybeSingle: async () => {
        const hit = exec().slice(0, 1);
        return { data: hit[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (headCount) {
          resolve({ data: [], error: null, count: exec().length });
          return;
        }
        resolve({ data: exec().slice(0, limitN), error: null });
      },
    };
    function exec(): Array<Record<string, unknown>> {
      const out = (h.store[table] ?? []).filter((r) => matches(r, filters));
      if (orderCol) {
        out.sort((a, b) =>
          orderAsc
            ? String(a[orderCol]) < String(b[orderCol])
              ? -1
              : 1
            : String(a[orderCol]) > String(b[orderCol])
              ? -1
              : 1,
        );
      }
      return out;
    }
    return api;
  };
  return { from };
}

function reminder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `w-${h.idSeq++}`,
    account_id: "acct-1",
    recipient_phone: "918737064453",
    contact_id: null,
    conversation_id: null,
    scheduled_for: "2026-11-08T10:30:00.000Z",
    message_text: "Call the lead",
    template_name: null,
    template_language: null,
    status: "scheduled",
    attempts: 0,
    whatsapp_message_id: null,
    message_id: null,
    sent_at: null,
    delivered_at: null,
    read_at: null,
    cancelled_at: null,
    failed_at: null,
    failure_reason: null,
    created_by: "user-admin",
    created_at: "2026-11-07T10:00:00.000Z",
    updated_at: "2026-11-07T10:00:00.000Z",
    ...over,
  };
}

function seed() {
  h.store = {
    whatsapp_followups: [
      reminder({ id: "w-sched" }),
      reminder({
        id: "w-sent",
        status: "sent",
        sent_at: "2026-11-08T10:30:00.000Z",
        whatsapp_message_id: "wamid-1",
      }),
      reminder({
        id: "w-delivered",
        status: "sent",
        sent_at: "2026-11-08T10:30:00.000Z",
        delivered_at: "2026-11-08T10:30:18.000Z",
        whatsapp_message_id: "wamid-2",
      }),
      reminder({
        id: "w-read",
        status: "sent",
        sent_at: "2026-11-08T10:30:00.000Z",
        delivered_at: "2026-11-08T10:30:18.000Z",
        read_at: "2026-11-08T10:34:26.000Z",
        whatsapp_message_id: "wamid-3",
      }),
      reminder({ id: "w-failed", status: "failed", failure_reason: "nope", failed_at: "2026-11-08T11:00:00.000Z" }),
      reminder({ id: "w-cancelled", status: "cancelled", cancelled_at: "2026-11-08T09:00:00.000Z" }),
      reminder({ id: "w-processing", status: "processing" }),
      reminder({
        id: "w-agent",
        created_by: "user-agent",
        message_text: "Agent private note",
        template_name: "hello_world",
      }),
    ],
    profiles: [
      { user_id: "user-admin", account_id: "acct-1", full_name: "Asha Admin", email: "asha@x.com", account_role: "admin" },
      { user_id: "user-agent", account_id: "acct-1", full_name: "Saniya Agent", email: "saniya@x.com", account_role: "agent" },
    ],
    contacts: [],
    flow_runs: [],
    flows: [],
    workspace_fields: [],
    workspace_values: [],
  };
  h.role = "admin";
  h.userId = "user-admin";
  h.queries = [];
}

async function get(query: string) {
  const res = await GET(new Request(`http://x/api/followups?${query}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function ids(json: Record<string, unknown>): string[] {
  return ((json.followups ?? []) as Array<{ id: string }>).map((r) => r.id);
}

beforeEach(seed);

describe("display-state views", () => {
  it("splits sent/delivered/read by receipts only", async () => {
    expect(ids((await get("view=sent")).json)).toEqual(["w-sent"]);
    expect(ids((await get("view=delivered")).json)).toEqual(["w-delivered"]);
    expect(ids((await get("view=read")).json)).toEqual(["w-read"]);
  });

  it("keeps legacy ?status=sent semantics (every accepted row)", async () => {
    const order = ids((await get("status=sent")).json).sort();
    expect(order).toEqual(["w-delivered", "w-read", "w-sent"]);
  });

  it("maps the remaining views 1:1 and rejects junk", async () => {
    expect(ids((await get("view=processing")).json)).toEqual(["w-processing"]);
    expect(ids((await get("view=failed")).json)).toEqual(["w-failed"]);
    expect(ids((await get("view=cancelled")).json)).toEqual(["w-cancelled"]);
    expect((await get("view=bogus")).status).toBe(400);
    expect((await get("status=bogus")).status).toBe(400);
  });
});

describe("agent isolation", () => {
  it("scopes every mode to the agent's own rows", async () => {
    h.role = "agent";
    h.userId = "user-agent";
    expect(ids((await get("view=all")).json)).toEqual(["w-agent"]);
    const counts = (await get("counts=1")).json.counts as Record<string, number>;
    expect(counts.all).toBe(1);
    expect(counts.scheduled).toBe(1);
  });
});

describe("counts + templates", () => {
  it("counts each bucket server-side", async () => {
    const counts = (await get("counts=1")).json.counts as Record<string, number>;
    expect(counts).toMatchObject({
      all: 8,
      scheduled: 2,
      processing: 1,
      sent: 1,
      delivered: 1,
      read: 1,
      failed: 1,
      cancelled: 1,
    });
  });

  it("lists distinct non-empty templates", async () => {
    const json = (await get("templates=1")).json;
    expect(json.templates).toEqual(["hello_world"]);
  });
});

describe("creator enrichment", () => {
  it("batches profiles and masks email for non-admins", async () => {
    const rows = ((await get("view=all")).json.followups ?? []) as Array<{
      id: string;
      creator: { full_name: string; email: string | null } | null;
    }>;
    const admin = rows.find((r) => r.id === "w-sched")!;
    expect(admin.creator?.full_name).toBe("Asha Admin");
    expect(admin.creator?.email).toBe("asha@x.com");
    const profileQueries = h.queries.filter(
      (q) => q.table === "profiles" && q.op === "in",
    );
    expect(profileQueries.length).toBeLessThanOrEqual(2);

    h.role = "agent";
    h.userId = "user-agent";
    const agentRows = ((await get("view=all")).json.followups ?? []) as Array<{
      creator: { email: string | null } | null;
    }>;
    expect(agentRows[0].creator?.email).toBeNull();
  });

  it("degrades missing profiles to null creator", async () => {
    h.store.profiles = [];
    const rows = ((await get("view=all")).json.followups ?? []) as Array<{
      creator: unknown;
    }>;
    expect(rows.every((r) => r.creator === null)).toBe(true);
  });
});

describe("search + filters", () => {
  it("searches message, recipient, and template server-side", async () => {
    expect(ids((await get("q=private+note")).json)).toEqual(["w-agent"]);
    expect(ids((await get("q=918737064453")).json)).toEqual(
      expect.arrayContaining(["w-sched"]),
    );
    expect(ids((await get("q=hello_world")).json)).toEqual(["w-agent"]);
  });

  it("searches creator names via server-resolved ids", async () => {
    expect(ids((await get("q=Saniya")).json)).toEqual(["w-agent"]);
  });

  it("filters by scheduled range, template, and creator", async () => {
    expect(
      ids((await get("from=2026-11-08T10:30:00.000Z&to=2026-11-08T10:30:00.000Z")).json).length,
    ).toBeGreaterThan(0);
    expect(ids((await get("template=hello_world")).json)).toEqual(["w-agent"]);
    expect(ids((await get("creator=user-agent")).json)).toEqual(["w-agent"]);
  });
});

describe("workspace context", () => {
  it("resolves flow, lead, and assignee only from exact relationships", async () => {
    h.store.flows = [{ id: "flow-1", account_id: "acct-1", name: "Kashmir Form", kind: "meta_lead_ads" }];
    h.store.flow_runs = [{ id: "run-1", account_id: "acct-1", flow_id: "flow-1", contact_id: "c-1" }];
    h.store.contacts = [{ id: "c-1", account_id: "acct-1", name: "Kumar Abhishek", phone: "919999999999" }];
    h.store.workspace_fields = [{ id: "f-as", account_id: "acct-1", flow_id: "flow-1", name: "Assigned To" }];
    h.store.workspace_values = [{ account_id: "acct-1", field_id: "f-as", flow_run_id: "run-1", value_text: "user-agent" }];
    h.store.whatsapp_followups.push(
      reminder({ id: "w-ws", source_kind: "meta_workspace_followup", source_run_id: "run-1" }),
    );
    const rows = ((await get("view=all")).json.followups ?? []) as Array<{
      id: string;
      workspace: {
        flow_name: string | null;
        lead_name: string | null;
        lead_phone: string | null;
        assignee_name: string | null;
      } | null;
    }>;
    expect(rows.find((r) => r.id === "w-ws")?.workspace).toEqual({
      flow_name: "Kashmir Form",
      lead_name: "Kumar Abhishek",
      lead_phone: "919999999999",
      assignee_name: "Saniya Agent",
    });
    // No source → null context, never a guess.
    expect(rows.find((r) => r.id === "w-sched")?.workspace).toBeNull();
  });

  it("degrades dangling source_run_id to null", async () => {
    h.store.whatsapp_followups.push(
      reminder({ id: "w-dangle", source_kind: "meta_workspace_followup", source_run_id: "run-404" }),
    );
    const rows = ((await get("view=all")).json.followups ?? []) as Array<{
      id: string;
      workspace: unknown;
    }>;
    expect(rows.find((r) => r.id === "w-dangle")?.workspace).toBeNull();
  });
});
