import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  contact: { id: "c-1", account_id: "acct-1" } as Record<string, unknown> | null,
  recordings: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: null as unknown,
}));

function fakeSupabase() {
  const state = {
    table: "",
    filters: [] as Array<[string, unknown]>,
    orGroups: [] as string[],
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
    const source = state.table === "contacts" ? h.contacts : h.recordings;
    return source.filter(
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
    );
  };
  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
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
    userId: "user-1",
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
  h.contact = { id: "c-1", account_id: "acct-1" };
  h.recordings = [];
  h.profiles = [{ user_id: "u-9", full_name: "Akash", email: "a@x.com" }];
  h.contacts = [{ id: "c-1", account_id: "acct-1", name: "Akash" }];
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
