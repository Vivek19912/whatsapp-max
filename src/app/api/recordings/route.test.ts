import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "user-1",
  role: "owner",
  contact: { id: "c-1", account_id: "acct-1" } as Record<string, unknown> | null,
  recordings: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  flowRuns: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: null as unknown,
}));

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Array<[string, unknown]>,
    orGroups: [] as string[],
    orderCol: "" as string,
    orderAsc: true as boolean,
  };
  // Minimal postgrest evaluator for the filter shapes the route
  // builds: eq/in/is/not plus top-level or() groups of atoms like
  // col.in.(a,b), col.ilike.%p%, col.eq.v, col.gte.X, col.lt.X,
  // col.is.null, and(...) conjunctions.
  const evalAtom = (r: Record<string, unknown>, atom: string): boolean => {
    let m = /^and\((.*)\)$/.exec(atom);
    if (m) return splitTop(m[1]).every((a) => evalAtom(r, a));
    m = /^([a-z_]+)\.in\.\((.*)\)$/.exec(atom);
    if (m) return m[2].split(",").includes(String(r[m[1]] ?? ""));
    m = /^([a-z_]+)\.ilike\.%(.*)%$/.exec(atom);
    if (m)
      return String(r[m[1]] ?? "")
        .toLowerCase()
        .includes(m[2].toLowerCase());
    m = /^([a-z_]+)\.eq\.(.*)$/.exec(atom);
    if (m) return String(r[m[1]] ?? "") === m[2];
    m = /^([a-z_]+)\.gte\.(.*)$/.exec(atom);
    if (m) return String(r[m[1]] ?? "") >= m[2];
    m = /^([a-z_]+)\.lt\.(.*)$/.exec(atom);
    if (m) return String(r[m[1]] ?? "") < m[2];
    m = /^([a-z_]+)\.is\.null$/.exec(atom);
    if (m) return r[m[1]] == null;
    return true;
  };
  const matched = () => {
    const source =
      state.table === "contacts"
        ? h.contacts
        : state.table === "flow_runs"
          ? h.flowRuns
          : state.table === "flows"
            ? h.flows
            : state.table === "call_events"
              ? h.events
              : h.recordings;
    return source
      .filter(
        (r) =>
          state.filters.every(([c, v]) => {
            if (v && typeof v === "object" && "__isNull" in (v as object)) {
              return r[c] == null;
            }
            if (v && typeof v === "object" && "__notNull" in (v as object)) {
              return r[c] != null;
            }
            return Array.isArray(v) ? v.includes(r[c] as string) : r[c] === v;
          }) &&
          state.orGroups.every((g) => splitTop(g).some((a) => evalAtom(r, a)))
      )
      .sort((a, b) => {
        // Honors .order() so recency-dependent joins (workspace
        // table via newest flow run) resolve exactly like Postgres.
        if (!state.orderCol) return 0;
        const av = String(a[state.orderCol] ?? "");
        const bv = String(b[state.orderCol] ?? "");
        return state.orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
      });
  };
  const api: Record<string, unknown> = {
    select: () => api,
    order: (col: string, opts?: { ascending?: boolean }) => {
      state.orderCol = col;
      state.orderAsc = opts?.ascending ?? true;
      return api;
    },
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      state.filters.push([col, vals]);
      return api;
    },
    is: (col: string, val: unknown) => {
      state.filters.push([col, val === null ? { __isNull: true } : val]);
      return api;
    },
    not: (col: string, op: string, val: unknown) => {
      state.filters.push([col, op === "is" && val === null ? { __notNull: true } : val]);
      return api;
    },
    or: (group: string) => {
      state.orGroups.push(group);
      return api;
    },
    gte: (col: string, val: unknown) => {
      state.orGroups.push(`${col}.gte.${val}`);
      return api;
    },
    lt: (col: string, val: unknown) => {
      state.orGroups.push(`${col}.lt.${val}`);
      return api;
    },
    limit: () => api,
    range: async () => ({ data: matched(), error: null, count: matched().length }),
    // Builders are thenable (supabase-js): queries awaited without
    // .range() (contact prefetch, batched lookups) resolve the same.
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ data: matched(), error: null }),
    maybeSingle: async () => {
      if (state.table === "contacts") return { data: h.contact, error: null };
      return { data: null, error: null };
    },
  };
  return {
    from: (table: string) => {
      state.table = table;
      state.filters = [];
      state.orGroups = [];
      state.orderCol = "";
      state.orderAsc = true;
      if (table === "profiles") {
        return {
          select: () => ({
            in: async () => ({ data: h.profiles, error: null }),
          }),
        };
      }
      return api;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      return { data: h.rpcResult, error: null };
    },
  };
}

/** Split a postgrest or-group on top-level commas (respect parens). */
function splitTop(group: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of group) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: h.userId,
    role: h.role,
  }),
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status },
    );
  },
}));

const { GET } = await import("./route");

function recording(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    account_id: "acct-1",
    contact_id: "c-1",
    conversation_id: null,
    uploaded_by: "u-9",
    storage_bucket: "call-recordings",
    storage_path: "account-acct-1/1-x.ogg",
    file_name: "x.ogg",
    mime_type: "audio/ogg",
    file_size: 1000,
    duration_seconds: 35,
    recorded_at: "2026-10-04T12:00:00.000Z",
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.role = "owner";
  h.contact = { id: "c-1", account_id: "acct-1" };
  h.recordings = [];
  h.events = [];
  h.profiles = [{ user_id: "u-9", full_name: "Akash", email: "a@x.com" }];
  h.contacts = [{ id: "c-1", account_id: "acct-1", name: "Akash" }];
  h.flowRuns = [];
  h.flows = [];
  h.rpcCalls = [];
  h.rpcResult = null;
});

describe("GET /api/recordings?contact_id=", () => {
  it("scopes to one contact and joins the uploader name", async () => {
    h.recordings = [recording(), recording({ id: "r-2", contact_id: "c-9" })];
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string; uploader_name: string | null }>;
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.recordings.map((r) => r.id)).toEqual(["r-1"]);
    expect(json.recordings[0].uploader_name).toBe("Akash");
  });

  it("404s a contact from another account (no cross-tenant oracle)", async () => {
    h.contact = null;
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-evil"),
    );
    expect(res.status).toBe(404);
  });

  it("falls back to Unknown when the uploader profile is gone", async () => {
    h.recordings = [recording()];
    h.profiles = [];
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ uploader_name: string | null }>;
    };
    expect(json.recordings[0].uploader_name).toBe("Unknown");
  });

  it("keeps unlinked recordings in the unfiltered global list", async () => {
    h.recordings = [recording({ id: "r-u", contact_id: null })];
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string }>;
      total: number;
    };
    expect(json.total).toBe(1);
    expect(json.recordings[0].id).toBe("r-u");
  });

  it("returns the verified contact header for the lead page", async () => {
    h.contact = {
      id: "c-1",
      account_id: "acct-1",
      name: "Sagar",
      phone: "+916394642516",
    };
    h.recordings = [recording()];
    const res = await GET(
      new Request("https://app.test/api/recordings?contact_id=c-1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      contact: { id: string; name: string | null; phone: string | null } | null;
    };
    expect(json.contact).toEqual({
      id: "c-1",
      name: "Sagar",
      phone: "+916394642516",
    });
  });

  it("omits the contact header on the unfiltered global list", async () => {
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { contact: unknown };
    expect(json.contact).toBeNull();
  });

  it("joins the linked lead name per recording", async () => {
    h.recordings = [
      recording(),
      recording({ id: "r-u", contact_id: null }),
    ];
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string; contact_name: string | null }>;
    };
    expect(
      json.recordings.find((r) => r.id === "r-1")?.contact_name
    ).toBe("Akash");
    expect(
      json.recordings.find((r) => r.id === "r-u")?.contact_name
    ).toBeNull();
  });

  it("nulls the lead name when the contact is gone, keeping the recording", async () => {
    h.contacts = [];
    h.recordings = [recording()];
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ id: string; contact_name: string | null }>;
    };
    expect(json.recordings).toHaveLength(1);
    expect(json.recordings[0].contact_name).toBeNull();
  });

  it("never joins a contact from another account", async () => {
    h.contacts = [{ id: "c-1", account_id: "acct-evil", name: "Evil" }];
    h.recordings = [recording()];
    const res = await GET(new Request("https://app.test/api/recordings"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recordings: Array<{ contact_name: string | null }>;
    };
    expect(json.recordings[0].contact_name).toBeNull();
  });

  it("returns the linked contact phone for the drawer", async () => {
    h.contacts = [{ id: "c-1", account_id: "acct-1", name: "Akash", phone: "+919876543210" }];
    h.recordings = [recording()];
    const res = await GET(new Request("https://app.test/api/recordings"));
    const json = (await res.json()) as {
      recordings: Array<{ contact_phone: string | null }>;
    };
    expect(json.recordings[0].contact_phone).toBe("+919876543210");
  });

  it("400s a malformed workspace_table value", async () => {
    const res = await GET(
      new Request("https://app.test/api/recordings?workspace_table=nope")
    );
    expect(res.status).toBe(400);
  });

  it("joins the workspace table name via the lead's most recent flow run", async () => {
    h.contacts = [{ id: "c-1", account_id: "acct-1", name: "Akash" }];
    h.flowRuns = [
      { contact_id: "c-1", account_id: "acct-1", flow_id: "f-old", started_at: "2026-09-01T00:00:00.000Z" },
      { contact_id: "c-1", account_id: "acct-1", flow_id: "f-new", started_at: "2026-10-01T00:00:00.000Z" },
    ];
    h.flows = [
      { id: "f-old", account_id: "acct-1", name: "Meta Lead Ads" },
      { id: "f-new", account_id: "acct-1", name: "Instant Form for Couple Kashmir" },
    ];
    h.recordings = [recording()];
    const res = await GET(new Request("https://app.test/api/recordings"));
    const json = (await res.json()) as {
      recordings: Array<{ workspace_table_name: string | null }>;
    };
    // Newest run first in the query; either way the helper resolves
    // the most recent run's flow — here f-new.
    expect(json.recordings[0].workspace_table_name).toBe(
      "Instant Form for Couple Kashmir"
    );
  });

  it("nulls the workspace table for unlinked recordings", async () => {
    h.recordings = [recording({ id: "r-u", contact_id: null })];
    const res = await GET(new Request("https://app.test/api/recordings"));
    const json = (await res.json()) as {
      recordings: Array<{ workspace_table_name: string | null }>;
    };
    expect(json.recordings[0].workspace_table_name).toBeNull();
  });

  it("nulls the workspace table when the lead has no runs or the flow is gone", async () => {
    h.flowRuns = [];
    h.flows = [];
    h.recordings = [
      recording({ id: "r-norun" }),
      recording({
        id: "r-goneflow",
        contact_id: "c-2",
      }),
    ];
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash" },
      { id: "c-2", account_id: "acct-1", name: "Sagar" },
    ];
    h.flowRuns = [
      { contact_id: "c-2", account_id: "acct-1", flow_id: "f-gone", started_at: "2026-10-01T00:00:00.000Z" },
    ];
    h.flows = [];
    const res = await GET(new Request("https://app.test/api/recordings"));
    const json = (await res.json()) as {
      recordings: Array<{ id: string; workspace_table_name: string | null }>;
    };
    expect(
      json.recordings.find((r) => r.id === "r-norun")?.workspace_table_name
    ).toBeNull();
    expect(
      json.recordings.find((r) => r.id === "r-goneflow")?.workspace_table_name
    ).toBeNull();
  });

  it("never joins a workspace table from another account", async () => {
    h.contacts = [{ id: "c-1", account_id: "acct-1", name: "Akash" }];
    h.flowRuns = [
      { contact_id: "c-1", account_id: "acct-evil", flow_id: "f-evil", started_at: "2026-10-01T00:00:00.000Z" },
    ];
    h.flows = [{ id: "f-evil", account_id: "acct-evil", name: "Evil Table" }];
    h.recordings = [recording()];
    const res = await GET(new Request("https://app.test/api/recordings"));
    const json = (await res.json()) as {
      recordings: Array<{ workspace_table_name: string | null }>;
    };
    expect(json.recordings[0].workspace_table_name).toBeNull();
  });
});

describe("GET /api/recordings?workspace_table=", () => {
  const FLOW = "123e4567-e89b-12d3-a456-426614174010";
  const OTHER_FLOW = "123e4567-e89b-12d3-a456-426614174011";
  const seed = () => {
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash" },
      { id: "c-2", account_id: "acct-1", name: "Sagar" },
    ];
    h.flowRuns = [
      { contact_id: "c-1", account_id: "acct-1", flow_id: FLOW },
      { contact_id: "c-2", account_id: "acct-1", flow_id: OTHER_FLOW },
    ];
    h.recordings = [
      recording({ id: "r-1", contact_id: "c-1" }),
      recording({ id: "r-2", contact_id: "c-2" }),
      recording({ id: "r-u", contact_id: null }),
    ];
  };
  const ids = async (qs: string) => {
    const res = await GET(new Request(`https://app.test/api/recordings?${qs}`));
    const json = (await res.json()) as { recordings: Array<{ id: string }> };
    return json.recordings.map((r) => r.id).sort();
  };

  it("returns only the selected table's linked recordings, never unlinked", async () => {
    seed();
    expect(await ids(`workspace_table=${FLOW}`)).toEqual(["r-1"]);
    expect(await ids(`workspace_table=${OTHER_FLOW}`)).toEqual(["r-2"]);
  });

  it("omitting the table restores linked and unlinked recordings", async () => {
    seed();
    expect(await ids("")).toEqual(["r-1", "r-2", "r-u"]);
  });

  it("returns empty for a foreign or empty flow (no cross-tenant oracle)", async () => {
    seed();
    h.flowRuns = [
      { contact_id: "c-1", account_id: "acct-evil", flow_id: FLOW },
    ];
    expect(await ids(`workspace_table=${FLOW}`)).toEqual([]);
    const res = await GET(
      new Request(`https://app.test/api/recordings?workspace_table=${FLOW}&summary=1`)
    );
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary).toEqual({
      total: 0,
      totalDurationSecs: 0,
      phone: 0,
      whatsapp: 0,
      unlinked: 0,
    });
  });

  it("combines with status and direction filters", async () => {
    seed();
    expect(await ids(`workspace_table=${FLOW}&status=linked`)).toEqual(["r-1"]);
    // Unlinked can never satisfy a specific-table selection.
    expect(await ids(`workspace_table=${FLOW}&status=unlinked`)).toEqual([]);
  });

  it("passes the table membership to the summary RPC and drops phone digits", async () => {
    seed();
    h.rpcResult = {
      total: 1,
      totalDurationSecs: 16,
      phone: 1,
      whatsapp: 0,
      whatsappBusiness: 0,
      unlinked: 0,
    };
    const res = await GET(
      new Request(
        `https://app.test/api/recordings?summary=1&workspace_table=${FLOW}&q=5555555555`
      )
    );
    expect(res.status).toBe(200);
    // Digits alone match only the unlinked r-3, which the table
    // excludes: membership intersects to nothing... except the
    // mock search prefetch finds no contact for those digits, so
    // the intersection is empty and the route short-circuits.
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary.total).toBe(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("intersects table membership with text-search candidates for the RPC", async () => {
    seed();
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash", phone_normalized: "919876543210" },
      { id: "c-2", account_id: "acct-1", name: "Sagar", phone_normalized: "911234567890" },
    ];
    h.rpcResult = {
      total: 1,
      totalDurationSecs: 16,
      phone: 1,
      whatsapp: 0,
      whatsappBusiness: 0,
      unlinked: 0,
    };
    const res = await GET(
      new Request(
        `https://app.test/api/recordings?summary=1&workspace_table=${FLOW}&q=aka`
      )
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary.total).toBe(1);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0].args).toMatchObject({ p_contact_ids: ["c-1"] });
  });
});

describe("GET /api/recordings search and filters", () => {
  const USER_9 = "123e4567-e89b-12d3-a456-426614174000";
  const USER_8 = "123e4567-e89b-12d3-a456-426614174001";
  const seed = () => {
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash", phone: "+919876543210", phone_normalized: "919876543210" },
      { id: "c-2", account_id: "acct-1", name: "Sagar", phone: "+911234567890", phone_normalized: "911234567890" },
    ];
    h.recordings = [
      recording({ id: "r-1", contact_id: "c-1", phone_number: "+919876543210", direction: "out", call_type: "phone", duration_seconds: 16, recorded_at: "2026-10-06T10:37:00.000Z", uploaded_by: USER_9 }),
      recording({ id: "r-2", contact_id: "c-2", phone_number: "+911234567890", direction: "in", call_type: "whatsapp", duration_seconds: 138, recorded_at: "2026-10-05T10:00:00.000Z", uploaded_by: USER_8 }),
      recording({ id: "r-3", contact_id: null, phone_number: "+915555555555", direction: null, call_type: "whatsapp_business", duration_seconds: null, recorded_at: "2026-10-04T10:00:00.000Z", uploaded_by: USER_9 }),
    ];
  };

  it("searches linked lead names", async () => {
    seed();
    const res = await GET(new Request("https://app.test/api/recordings?q=aka"));
    const json = (await res.json()) as { recordings: Array<{ id: string }>; total: number };
    expect(res.status).toBe(200);
    expect(json.total).toBe(1);
    expect(json.recordings[0].id).toBe("r-1");
  });

  it("searches phone digits against contacts and recording numbers", async () => {
    seed();
    const byContact = await GET(new Request("https://app.test/api/recordings?q=911234567890"));
    const byContactJson = (await byContact.json()) as { recordings: Array<{ id: string }> };
    expect(byContactJson.recordings.map((r) => r.id)).toEqual(["r-2"]);
    const byNumber = await GET(new Request("https://app.test/api/recordings?q=5555555555"));
    const byNumberJson = (await byNumber.json()) as { recordings: Array<{ id: string }> };
    expect(byNumberJson.recordings.map((r) => r.id)).toEqual(["r-3"]);
  });

  it("returns empty — never unfiltered — for a search with no match", async () => {
    seed();
    const res = await GET(new Request("https://app.test/api/recordings?q=zzz-no-match"));
    const json = (await res.json()) as { recordings: unknown[]; total: number };
    expect(json.total).toBe(0);
    expect(json.recordings).toEqual([]);
  });

  it("filters by call type, direction (incl. unknown), status, and uploader", async () => {
    seed();
    const ids = async (qs: string) => {
      const res = await GET(new Request(`https://app.test/api/recordings?${qs}`));
      const json = (await res.json()) as { recordings: Array<{ id: string }> };
      return json.recordings.map((r) => r.id).sort();
    };
    expect(await ids("call_type=whatsapp")).toEqual(["r-2", "r-3"]);
    // Legacy alias: whatsapp_business selects the same merged set.
    expect(await ids("call_type=whatsapp_business")).toEqual(["r-2", "r-3"]);
    // Phone stays separate: excludes both WhatsApp values.
    expect(await ids("call_type=phone")).toEqual(["r-1"]);
    expect(await ids("call_type=phone&status=linked")).toEqual(["r-1"]);
    expect(await ids("direction=in")).toEqual(["r-2"]);
    expect(await ids("direction=unknown")).toEqual(["r-3"]);
    expect(await ids("status=unlinked")).toEqual(["r-3"]);
    expect(await ids("status=linked")).toEqual(["r-1", "r-2"]);
    expect(await ids(`uploaded_by=${USER_9}`)).toEqual(["r-1", "r-3"]);
  });

  it("filters by effective-time window", async () => {
    seed();
    const res = await GET(
      new Request(
        "https://app.test/api/recordings?from=2026-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z"
      )
    );
    const json = (await res.json()) as { recordings: Array<{ id: string }> };
    expect(json.recordings.map((r) => r.id)).toEqual(["r-2"]);
  });

  it("400s invalid filter values", async () => {
    seed();
    for (const qs of [
      "call_type=missed",
      "direction=sideways",
      "status=maybe",
      "uploaded_by=nope",
      "from=not-a-date",
      "from=2026-10-06T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    ]) {
      const res = await GET(new Request(`https://app.test/api/recordings?${qs}`));
      expect(res.status).toBe(400);
    }
  });

  it("summarizes via the exact RPC with the caller's filters", async () => {
    seed();
    h.rpcResult = {
      total: 3,
      totalDurationSecs: 154,
      phone: 1,
      whatsapp: 1,
      whatsappBusiness: 1,
      unlinked: 1,
    };
    const res = await GET(
      new Request("https://app.test/api/recordings?summary=1&status=linked")
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number> };
    // Merged reporting: whatsapp + whatsapp_business fold into one
    // "WhatsApp" count; no separate business KPI is returned.
    expect(json.summary).toEqual({
      total: 3,
      totalDurationSecs: 154,
      phone: 1,
      whatsapp: 2,
      unlinked: 1,
    });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0].fn).toBe("call_recordings_summary");
    expect(h.rpcCalls[0].args).toMatchObject({
      p_account_id: "acct-1",
      p_status: "linked",
    });
  });

  it("merges whatsapp + whatsapp_business into one WhatsApp count (4 + 3 = 7)", async () => {
    seed();
    h.rpcResult = {
      total: 12,
      totalDurationSecs: 700,
      phone: 5,
      whatsapp: 4,
      whatsappBusiness: 3,
      unlinked: 2,
    };
    const res = await GET(new Request("https://app.test/api/recordings?summary=1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary.whatsapp).toBe(7);
    expect(json.summary.phone).toBe(5);
    expect(json.summary).not.toHaveProperty("whatsappBusiness");
  });

  it("passes a WhatsApp type filter through to the RPC for exact aggregation", async () => {
    seed();
    h.rpcResult = {
      total: 2,
      totalDurationSecs: 138,
      phone: 0,
      whatsapp: 1,
      whatsappBusiness: 1,
      unlinked: 1,
    };
    const res = await GET(
      new Request("https://app.test/api/recordings?summary=1&call_type=whatsapp")
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary.whatsapp).toBe(2);
    expect(h.rpcCalls[0].args).toMatchObject({ p_call_type: "whatsapp" });
  });

  it("is exact past 5000 matches: the RPC total is returned verbatim, never truncated", async () => {
    // Only 2 rows exist in the mock, but the database reports 6001
    // matches. The old paged implementation could never return more
    // than it fetched; the RPC path returns the true aggregate.
    seed();
    h.rpcResult = {
      total: 6001,
      totalDurationSecs: 360060,
      phone: 3000,
      whatsapp: 2000,
      whatsappBusiness: 1001,
      unlinked: 17,
    };
    const res = await GET(new Request("https://app.test/api/recordings?summary=1"));
    const json = (await res.json()) as { summary: { total: number; unlinked: number; whatsapp: number } };
    expect(json.summary.total).toBe(6001);
    expect(json.summary.unlinked).toBe(17);
    expect(json.summary.whatsapp).toBe(3001);
  });

  it("passes search candidates and date bounds through to the RPC", async () => {
    seed();
    h.rpcResult = {
      total: 1,
      totalDurationSecs: 16,
      phone: 1,
      whatsapp: 0,
      whatsappBusiness: 0,
      unlinked: 0,
    };
    const res = await GET(
      new Request(
        "https://app.test/api/recordings?summary=1&q=Akash&from=2026-10-01T00:00:00.000Z&to=2026-10-07T00:00:00.000Z"
      )
    );
    expect(res.status).toBe(200);
    expect(h.rpcCalls[0].args).toMatchObject({
      p_contact_ids: ["c-1"],
      p_from: "2026-10-01T00:00:00.000Z",
      p_to: "2026-10-07T00:00:00.000Z",
    });
  });

  it("short-circuits a matchless search to zeros without calling the RPC", async () => {
    seed();
    const res = await GET(
      new Request("https://app.test/api/recordings?summary=1&q=zzz-no-match")
    );
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary).toEqual({
      total: 0,
      totalDurationSecs: 0,
      phone: 0,
      whatsapp: 0,
      unlinked: 0,
    });
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe("GET /api/recordings agent scoping", () => {
  const AGENT = "123e4567-e89b-12d3-a456-426614174010";
  const OTHER = "123e4567-e89b-12d3-a456-426614174011";
  const seed = () => {
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash", phone: "+919876543210", phone_normalized: "919876543210" },
      { id: "c-2", account_id: "acct-1", name: "Sagar", phone: "+911234567890", phone_normalized: "911234567890" },
    ];
    h.profiles = [{ user_id: AGENT, full_name: "Agent", email: "a@x.com" }];
    h.recordings = [
      recording({ id: "r-own", contact_id: "c-1", phone_number: "+919876543210", uploaded_by: AGENT }),
      recording({ id: "r-other", contact_id: "c-2", phone_number: "+911234567890", uploaded_by: OTHER }),
    ];
    h.events = [
      {
        id: "e-own",
        account_id: "acct-1",
        contact_id: "c-1",
        user_id: AGENT,
        direction: "in",
        call_type: "phone",
        outcome: "missed",
        phone_number: "+919876543210",
        occurred_at: "2026-10-06T23:25:00.000Z",
        created_at: "2026-10-06T23:25:00.000Z",
      },
      {
        id: "e-other",
        account_id: "acct-1",
        contact_id: "c-2",
        user_id: OTHER,
        direction: "in",
        call_type: "phone",
        outcome: "missed",
        phone_number: "+911234567890",
        occurred_at: "2026-10-06T23:26:00.000Z",
        created_at: "2026-10-06T23:26:00.000Z",
      },
    ];
  };
  const fetchIds = async (qs: string) => {
    const res = await GET(new Request(`https://app.test/api/recordings?${qs}`));
    const json = (await res.json()) as { recordings: Array<{ id: string }>; total: number };
    return { res, ids: json.recordings.map((r) => r.id) };
  };

  it("agents see only their own recordings, even when requesting another uploader", async () => {
    seed();
    h.role = "agent";
    h.userId = AGENT;
    // A smuggled uploaded_by for another agent is ignored.
    const { res, ids } = await fetchIds(`uploaded_by=${OTHER}`);
    expect(res.status).toBe(200);
    expect(ids).toEqual(["e-own", "r-own"]);
  });

  it("agents see only their own missed events", async () => {
    seed();
    h.role = "agent";
    h.userId = AGENT;
    const { ids } = await fetchIds("");
    expect(ids).toEqual(["e-own", "r-own"]);
  });

  it("agents cannot widen scope via search or table filters", async () => {
    seed();
    h.role = "agent";
    h.userId = AGENT;
    // Search matches the other lead too (both names contain "a"),
    // but only own rows return.
    const { ids } = await fetchIds("q=a");
    expect(ids).toEqual(["e-own", "r-own"]);
  });

  it("agents get a self-scoped summary", async () => {
    seed();
    h.role = "agent";
    h.userId = AGENT;
    h.rpcResult = { total: 1, totalDurationSecs: 35, phone: 1, whatsapp: 0, whatsappBusiness: 0, unlinked: 0 };
    const res = await GET(new Request("https://app.test/api/recordings?summary=1"));
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0].args).toMatchObject({ p_uploaded_by: AGENT });
  });

  it("owners keep the requested uploader scope", async () => {
    seed();
    h.role = "owner";
    const { res, ids } = await fetchIds(`uploaded_by=${OTHER}`);
    expect(res.status).toBe(200);
    expect(ids).toEqual(["e-other", "r-other"]);
  });
});

describe("GET /api/recordings missed-call merge", () => {
  const USER_9 = "123e4567-e89b-12d3-a456-426614174000";
  type Row = {
    id: string;
    row_kind?: string;
    contact_id: string | null;
    direction: string | null;
    uploader_name?: string | null;
    contact_name?: string | null;
    workspace_table_name?: string | null;
    recorded_at?: string | null;
  };
  const seed = () => {
    h.contacts = [
      { id: "c-1", account_id: "acct-1", name: "Akash", phone: "+919876543210", phone_normalized: "919876543210" },
      { id: "c-2", account_id: "acct-1", name: "Sagar", phone: "+911234567890", phone_normalized: "911234567890" },
    ];
    h.profiles = [{ user_id: USER_9, full_name: "Akash", email: "a@x.com" }];
    h.recordings = [
      recording({
        id: "r-1",
        contact_id: "c-1",
        direction: "out",
        call_type: "phone",
        recorded_at: "2026-10-06T10:37:00.000Z",
        uploaded_by: USER_9,
      }),
    ];
    h.events = [
      {
        id: "e-1",
        account_id: "acct-1",
        contact_id: "c-2",
        user_id: USER_9,
        direction: "in",
        call_type: "phone",
        outcome: "missed",
        phone_number: "+911234567890",
        occurred_at: "2026-10-06T23:25:00.000Z",
        created_at: "2026-10-06T23:25:00.000Z",
      },
      {
        id: "e-2",
        account_id: "acct-1",
        contact_id: null,
        user_id: null,
        direction: "in",
        call_type: "phone",
        outcome: "missed",
        phone_number: "+915555555555",
        occurred_at: "2026-10-05T10:00:00.000Z",
        created_at: "2026-10-05T10:00:00.000Z",
      },
    ];
  };
  const rows = async (qs: string) => {
    const res = await GET(new Request(`https://app.test/api/recordings?${qs}`));
    const json = (await res.json()) as { recordings: Row[]; total: number; missedTotal: number };
    return { res, json };
  };

  it("merges missed events with recordings, newest call first", async () => {
    seed();
    const { res, json } = await rows("");
    expect(res.status).toBe(200);
    // e-1 (Oct 6 23:25) > r-1 (Oct 6 10:37) > e-2 (Oct 5).
    expect(json.recordings.map((r) => r.id)).toEqual(["e-1", "r-1", "e-2"]);
    expect(json.total).toBe(3);
    expect(json.missedTotal).toBe(2);
  });

  it("marks missed rows with no audio affordance and stable ids", async () => {
    seed();
    const { json } = await rows("");
    const missed = json.recordings.filter((r) => r.row_kind === "missed");
    expect(missed).toHaveLength(2);
    expect(missed.map((r) => r.id).sort()).toEqual(["e-1", "e-2"]);
    for (const m of missed) {
      expect(m).not.toHaveProperty("storage_path");
      expect(m).not.toHaveProperty("storage_bucket");
    }
    const rec = json.recordings.find((r) => r.id === "r-1");
    expect(rec).not.toHaveProperty("row_kind");
  });

  it("joins lead, salesperson, and workspace names for missed rows", async () => {
    seed();
    h.flowRuns = [{ contact_id: "c-2", account_id: "acct-1", flow_id: "f-1", started_at: "2026-10-06T00:00:00.000Z" }];
    h.flows = [{ id: "f-1", account_id: "acct-1", name: "Leads" }];
    const { json } = await rows("");
    const e1 = json.recordings.find((r) => r.id === "e-1")!;
    expect(e1.contact_name).toBe("Sagar");
    expect(e1.uploader_name).toBe("Akash");
    expect(e1.workspace_table_name).toBe("Leads");
    const e2 = json.recordings.find((r) => r.id === "e-2")!;
    expect(e2.contact_name).toBeNull();
    expect(e2.uploader_name).toBeNull();
    expect(e2.workspace_table_name).toBeNull();
  });

  it("never duplicates: recordings and missed events are disjoint populations", async () => {
    seed();
    const { json } = await rows("");
    const ids = json.recordings.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A missed event can never have a recording by construction —
    // the merge shows both kinds side by side, never merged away.
    expect(ids).toContain("r-1");
    expect(ids).toContain("e-1");
  });

  it("scopes missed events to the account (no cross-tenant leak)", async () => {
    seed();
    h.events = h.events.map((e) => ({ ...e, account_id: "acct-evil" }));
    const { json } = await rows("");
    expect(json.recordings.map((r) => r.id)).toEqual(["r-1"]);
    expect(json.total).toBe(1);
    expect(json.missedTotal).toBe(0);
  });

  it("applies search to missed rows by lead name and phone digits", async () => {
    seed();
    expect((await rows("q=Sagar")).json.recordings.map((r) => r.id)).toEqual(["e-1"]);
    expect((await rows("q=9155555555")).json.recordings.map((r) => r.id)).toEqual(["e-2"]);
  });

  it("applies date, direction, salesperson, table, and status filters to both", async () => {
    seed();
    // Date window keeps r-1 and e-1, drops e-2 (Oct 5).
    expect(
      (await rows("from=2026-10-06T00:00:00.000Z&to=2026-10-07T00:00:00.000Z")).json.recordings.map((r) => r.id)
    ).toEqual(["e-1", "r-1"]);
    // Missed events are inherently incoming: out/unknown match no events.
    expect((await rows("direction=out")).json.recordings.map((r) => r.id)).toEqual(["r-1"]);
    expect((await rows("direction=unknown")).json.recordings.map((r) => r.id)).toEqual([]);
    expect((await rows("direction=in")).json.recordings.map((r) => r.id)).toEqual(["e-1", "e-2"]);
    // Same uploader on r-1 and e-1.
    expect((await rows(`uploaded_by=${USER_9}`)).json.recordings.map((r) => r.id).sort()).toEqual(["e-1", "r-1"]);
    // Unlinked: e-2 only.
    expect((await rows("status=unlinked")).json.recordings.map((r) => r.id)).toEqual(["e-2"]);
    expect((await rows("status=linked")).json.recordings.map((r) => r.id).sort()).toEqual(["e-1", "r-1"]);
    // Table membership: only c-2's table matches e-1.
    const FLOW = "123e4567-e89b-12d3-a456-426614174099";
    h.flowRuns = [{ contact_id: "c-2", account_id: "acct-1", flow_id: FLOW }];
    h.flows = [{ id: FLOW, account_id: "acct-1", name: "Leads" }];
    expect((await rows(`workspace_table=${FLOW}`)).json.recordings.map((r) => r.id)).toEqual(["e-1"]);
  });

  it("excludes missed events for whatsapp filters and the lead view", async () => {
    seed();
    const wa = await rows("call_type=whatsapp");
    expect(wa.json.recordings.map((r) => r.id)).toEqual([]);
    expect(wa.json.missedTotal).toBe(0);
    const lead = await GET(new Request("https://app.test/api/recordings?contact_id=c-2"));
    const leadJson = (await lead.json()) as { recordings: Row[]; total: number };
    expect(leadJson.recordings.map((r) => r.id)).toEqual([]);
    expect(leadJson.total).toBe(0);
  });

  it("keeps the summary recordings-only when missed events exist", async () => {
    seed();
    h.rpcResult = {
      total: 1,
      totalDurationSecs: 16,
      phone: 1,
      whatsapp: 0,
      whatsappBusiness: 0,
      unlinked: 0,
    };
    const res = await GET(new Request("https://app.test/api/recordings?summary=1"));
    const json = (await res.json()) as { summary: Record<string, number> };
    expect(json.summary).toEqual({
      total: 1,
      totalDurationSecs: 16,
      phone: 1,
      whatsapp: 0,
      unlinked: 0,
    });
    expect(json).not.toHaveProperty("recordings");
    expect(json).not.toHaveProperty("missedTotal");
  });
});
