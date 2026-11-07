import { describe, it, expect } from "vitest";
import {
  NO_FLOW_FILTER_ID,
  getConversationDateRange,
  hasActiveInboxFilters,
  hasNewerConversationActivity,
  hasValidCtwaAttribution,
  isSourceFilterBlocked,
  matchesConversationDateFilter,
  matchesContactFilters,
  buildFormOptions,
  matchesFormFilter,
  matchesLeadSource,
  matchesStatusFilter,
  matchesTeamFilter,
  normalizeConversation,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      })
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null })
    ).toBe(true);
    expect(matchesContactFilters(conv, { tagIds: ["t9"], company: null })).toBe(
      false
    );
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(matchesContactFilters(conv, { tagIds: ["t1"], company: null })).toBe(
      false
    );
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      })
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(matchesContactFilters(conv, { tagIds: [], company: "Acme" })).toBe(
      true
    );
    expect(matchesContactFilters(conv, { tagIds: [], company: "Other" })).toBe(
      false
    );
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" })
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" })
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" })
    ).toBe(false);
  });

  it("matches by flow id against the contact's hydrated flow", () => {
    const conv = makeConversation({
      flow_id: "f1",
      flow_name: "Bali Automation",
    });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: null, flowId: "f1" })
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: null, flowId: "f2" })
    ).toBe(false);
    // A contact with no flow never matches an active flow filter.
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
        flowId: "f1",
      })
    ).toBe(false);
    // A null flow filter is a no-op.
    expect(
      matchesContactFilters(conv, { tagIds: [], company: null, flowId: null })
    ).toBe(true);
  });

  it("matches only flow-less conversations for the No-flow filter", () => {
    const withFlow = makeConversation({ flow_id: "f1", flow_name: "GOA" });
    const withoutFlow = makeConversation({ flow_id: null, flow_name: null });
    const noContact = makeConversation(null);

    // No flow → only conversations without an associated flow.
    expect(
      matchesContactFilters(withoutFlow, {
        tagIds: [],
        company: null,
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(true);
    expect(
      matchesContactFilters(withFlow, {
        tagIds: [],
        company: null,
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(false);
    // No contact means no flow runs → counts as No flow.
    expect(
      matchesContactFilters(noContact, {
        tagIds: [],
        company: null,
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(true);
  });

  it("combines the No-flow filter with tags and company (AND across facets)", () => {
    const match = makeConversation({
      company: "Acme",
      tags: [tag("t1")],
      flow_id: null,
    });
    const wrongFlow = makeConversation({
      company: "Acme",
      tags: [tag("t1")],
      flow_id: "f1",
    });
    const wrongTag = makeConversation({
      company: "Acme",
      tags: [tag("t2")],
      flow_id: null,
    });
    expect(
      matchesContactFilters(match, {
        tagIds: ["t1"],
        company: "Acme",
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(true);
    expect(
      matchesContactFilters(wrongFlow, {
        tagIds: ["t1"],
        company: "Acme",
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(false);
    expect(
      matchesContactFilters(wrongTag, {
        tagIds: ["t1"],
        company: "Acme",
        flowId: NO_FLOW_FILTER_ID,
      })
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });

  it("flattens embedded flow_runs into contact.flow_id/flow_name", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        flow_runs: [
          {
            id: "run-1",
            status: "active",
            started_at: "2026-01-01T10:00:00Z",
            flow: { id: "f1", name: "Bali Automation" },
          },
        ],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.flow_id).toBe("f1");
    expect(normalized.contact?.flow_name).toBe("Bali Automation");
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).flow_runs
    ).toBeUndefined();
  });

  it("leaves flow fields null when the contact has no runs", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        flow_runs: [],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.flow_id).toBeNull();
    expect(normalized.contact?.flow_name).toBeNull();
  });
});

describe("getConversationDateRange", () => {
  it("returns null for all chats", () => {
    expect(
      getConversationDateRange({
        filter: "all",
      })
    ).toBeNull();
  });

  it("builds today's inclusive local-day range", () => {
    const range = getConversationDateRange(
      { filter: "today" },
      new Date(2026, 7, 22, 14, 30)
    );

    expect(range?.from).toEqual(new Date(2026, 7, 22, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });

  it("builds yesterday's inclusive local-day range", () => {
    const range = getConversationDateRange(
      { filter: "yesterday" },
      new Date(2026, 7, 1, 1, 15)
    );

    expect(range?.from).toEqual(new Date(2026, 6, 31, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 6, 31, 23, 59, 59, 999));
  });

  it("supports a custom single-day range", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(range?.from).toEqual(new Date(2026, 7, 22, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });

  it("supports a custom range across months", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-07-31",
      customTo: "2026-08-02",
    });

    expect(range?.from).toEqual(new Date(2026, 6, 31, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 2, 23, 59, 59, 999));
  });

  it("normalizes a reversed custom date range", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-01",
    });

    expect(range?.from).toEqual(new Date(2026, 7, 1, 0, 0, 0, 0));
    expect(range?.to).toEqual(new Date(2026, 7, 22, 23, 59, 59, 999));
  });
});

describe("matchesConversationDateFilter", () => {
  it("matches inclusive activity boundaries around local midnight", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(
      matchesConversationDateFilter(
        { last_message_at: new Date(2026, 7, 22, 0, 0, 0, 0).toISOString() },
        range
      )
    ).toBe(true);
    expect(
      matchesConversationDateFilter(
        {
          last_message_at: new Date(2026, 7, 22, 23, 59, 59, 999).toISOString(),
        },
        range
      )
    ).toBe(true);
    expect(
      matchesConversationDateFilter(
        {
          last_message_at: new Date(2026, 7, 21, 23, 59, 59, 999).toISOString(),
        },
        range
      )
    ).toBe(false);
    expect(
      matchesConversationDateFilter(
        { last_message_at: new Date(2026, 7, 23, 0, 0, 0, 0).toISOString() },
        range
      )
    ).toBe(false);
  });

  it("excludes conversations without latest activity when date-filtered", () => {
    const range = getConversationDateRange({
      filter: "custom",
      customFrom: "2026-08-22",
      customTo: "2026-08-22",
    });

    expect(matchesConversationDateFilter({}, range)).toBe(false);
  });
});

describe("hasNewerConversationActivity", () => {
  const T1 = "2026-08-20T10:00:00.000Z";
  const T2 = "2026-08-21T10:00:00.000Z";

  it("returns false when last_message_at is unchanged (read-state update)", () => {
    expect(
      hasNewerConversationActivity(
        { last_message_at: T1 },
        { last_message_at: T1 }
      )
    ).toBe(false);
  });

  it("returns true when the incoming row has strictly newer activity", () => {
    expect(
      hasNewerConversationActivity(
        { last_message_at: T1 },
        { last_message_at: T2 }
      )
    ).toBe(true);
  });

  it("returns false when the incoming row is older (out-of-order event)", () => {
    expect(
      hasNewerConversationActivity(
        { last_message_at: T2 },
        { last_message_at: T1 }
      )
    ).toBe(false);
  });

  it("returns false when the incoming row carries no activity timestamp", () => {
    expect(hasNewerConversationActivity({ last_message_at: T1 }, {})).toBe(
      false
    );
  });

  it("returns true when the current row has no timestamp but incoming does", () => {
    expect(hasNewerConversationActivity({}, { last_message_at: T1 })).toBe(
      true
    );
  });

  it("returns false when neither row has a timestamp", () => {
    expect(hasNewerConversationActivity({}, {})).toBe(false);
  });

  it("returns false for unparseable incoming timestamps", () => {
    expect(
      hasNewerConversationActivity(
        { last_message_at: T1 },
        { last_message_at: "not-a-date" }
      )
    ).toBe(false);
  });
});

describe("matchesLeadSource", () => {
  const sub = (ids: string[]) => new Set(ids);

  it("matches everything when the filter is All Sources", () => {
    const conv = makeConversation({
      source_url: "https://fb.me/x",
      ctwa_clid: "clid",
    });
    expect(matchesLeadSource(conv, null, sub(["ct1"]))).toBe(true);
    expect(matchesLeadSource(conv, "all", sub(["ct1"]))).toBe(true);
    expect(
      matchesLeadSource(makeConversation(null), "all", sub([])),
    ).toBe(true);
  });

  it("matches Instant Form only via a processed-submission link", () => {
    const conv = makeConversation({ company: "Acme" });
    expect(matchesLeadSource(conv, "instant_form", sub(["ct1"]))).toBe(true);
    // Repeat submissions for the same contact are one set entry — the
    // thread still matches exactly once.
    expect(
      matchesLeadSource(conv, "instant_form", sub(["ct1", "ct1"])),
    ).toBe(true);
    expect(matchesLeadSource(conv, "instant_form", sub([]))).toBe(false);
    expect(matchesLeadSource(conv, "instant_form", sub(["other"]))).toBe(
      false,
    );
    // Submission link is by contact_id, not by CTWA fields.
    const ctwaOnly = makeConversation({ source_url: "https://fb.me/x" });
    expect(matchesLeadSource(ctwaOnly, "instant_form", sub([]))).toBe(false);
  });

  it("matches CTWA via source_url or ctwa_clid independently", () => {
    expect(
      matchesLeadSource(
        makeConversation({ source_url: "https://fb.me/x" }),
        "ctwa",
        sub([]),
      ),
    ).toBe(true);
    expect(
      matchesLeadSource(
        makeConversation({ ctwa_clid: "12345" }),
        "ctwa",
        sub([]),
      ),
    ).toBe(true);
    expect(
      matchesLeadSource(makeConversation({ company: "Acme" }), "ctwa", sub([])),
    ).toBe(false);
    expect(matchesLeadSource(makeConversation(null), "ctwa", sub([]))).toBe(
      false,
    );
  });

  it("excludes dual-source conversations from CTWA: Instant Form takes precedence", () => {
    const conv = makeConversation({
      source_url: "https://fb.me/x",
      ctwa_clid: "12345",
    });
    expect(matchesLeadSource(conv, "instant_form", sub(["ct1"]))).toBe(true);
    // Same thread is NOT a CTWA lead despite populated attribution —
    // metadata is preserved, only bucket membership changes.
    expect(matchesLeadSource(conv, "ctwa", sub(["ct1"]))).toBe(false);
    expect(matchesLeadSource(conv, "other", sub(["ct1"]))).toBe(false);
  });

  it("excludes audited dual-source leads (Narasimha/Sakthivel shape) from CTWA", () => {
    // fb.me + Meta click id + processed submission on the same contact:
    // Meta lead, excluded from Click-to-WhatsApp, attribution intact.
    const narasimha = makeConversation({
      source_url: "https://fb.me/9NXAdJ5P2",
      source_type: "ad",
      ctwa_clid: "AfjFMh7x2Kq",
    });
    expect(matchesLeadSource(narasimha, "instant_form", sub(["ct1"]))).toBe(
      true
    );
    expect(matchesLeadSource(narasimha, "ctwa", sub(["ct1"]))).toBe(false);
    expect(narasimha.contact?.source_url).toBe("https://fb.me/9NXAdJ5P2");
    expect(narasimha.contact?.ctwa_clid).toBe("AfjFMh7x2Kq");
    // instagram.com + click id + processed submission: same outcome.
    const sakthivel = makeConversation({
      source_url: "https://www.instagram.com/",
      source_type: "ad",
      ctwa_clid: "AfjKo9pQ1Rs",
    });
    expect(matchesLeadSource(sakthivel, "instant_form", sub(["ct1"]))).toBe(
      true
    );
    expect(matchesLeadSource(sakthivel, "ctwa", sub(["ct1"]))).toBe(false);
  });

  it("still includes genuine CTWA contacts with no submission", () => {
    const conv = makeConversation({
      source_url: "https://fb.me/x",
      ctwa_clid: "12345",
    });
    expect(matchesLeadSource(conv, "ctwa", sub([]))).toBe(true);
    expect(matchesLeadSource(conv, "ctwa", sub(["other-contact"]))).toBe(true);
  });

  it("matches Other only when NEITHER signal exists", () => {
    expect(
      matchesLeadSource(makeConversation({ company: "Acme" }), "other", sub([])),
    ).toBe(true);
    expect(matchesLeadSource(makeConversation(null), "other", sub([]))).toBe(
      true,
    );
    expect(
      matchesLeadSource(
        makeConversation({ source_url: "https://fb.me/x" }),
        "other",
        sub([]),
      ),
    ).toBe(false);
    expect(
      matchesLeadSource(
        makeConversation({ ctwa_clid: "12345" }),
        "other",
        sub([]),
      ),
    ).toBe(false);
    expect(
      matchesLeadSource(makeConversation(null), "other", sub(["ct1"])),
    ).toBe(false);
  });

  it("treats missing and empty attribution as absent (btrim parity)", () => {
    for (const contact of [
      {},
      { source_url: "", ctwa_clid: "" },
      { source_url: "   ", ctwa_clid: "   " },
      { source_url: undefined, ctwa_clid: undefined },
    ]) {
      const conv = makeConversation(contact);
      expect(matchesLeadSource(conv, "ctwa", sub([]))).toBe(false);
      expect(matchesLeadSource(conv, "other", sub([]))).toBe(true);
    }
    // DB NULLs arrive as null at runtime (the Contact type narrows to
    // string|undefined); the guards handle them without throwing.
    const dbNull = { source_url: null, ctwa_clid: null } as unknown as {
      source_url?: string;
      ctwa_clid?: string;
    };
    expect(hasValidCtwaAttribution(dbNull)).toBe(false);
    expect(hasValidCtwaAttribution(null)).toBe(false);
    expect(hasValidCtwaAttribution(undefined)).toBe(false);
    expect(
      matchesLeadSource(
        { contact_id: "ct1", contact: dbNull },
        "other",
        sub([]),
      ),
    ).toBe(true);
  });

  it("counts tab/newline-only values as valid (SQL btrim strips spaces only)", () => {
    const conv = makeConversation({ source_url: "\t" });
    expect(matchesLeadSource(conv, "ctwa", sub([]))).toBe(true);
    expect(matchesLeadSource(conv, "other", sub([]))).toBe(false);
  });

  it("combines with Date, Tags, Flow, Team and Lead Source filters", () => {    const conv = makeConversation({
      company: "Acme",
      tags: [tag("t1")],
      source_url: "https://fb.me/x",
    });
    const contactOk = matchesContactFilters(conv, {
      tagIds: ["t1"],
      company: "Acme",
      flowId: null,
    });
    expect(contactOk).toBe(true);
    expect(matchesLeadSource(conv, "ctwa", sub([]))).toBe(true);
    // Same thread under the wrong source is excluded while the
    // contact filters still pass — filters stay independent.
    expect(matchesLeadSource(conv, "instant_form", sub([]))).toBe(false);
    expect(matchesLeadSource(conv, "other", sub([]))).toBe(false);
  });
});

describe("isSourceFilterBlocked", () => {
  it("starts blocked: initially not ready", () => {
    expect(isSourceFilterBlocked(false, "instant_form", false)).toBe(true);
    expect(isSourceFilterBlocked(false, "other", false)).toBe(true);
  });

  it("never blocks CTWA or All Sources (no lookup needed)", () => {
    for (const ready of [false, true]) {
      expect(isSourceFilterBlocked(false, "ctwa", ready)).toBe(false);
      expect(isSourceFilterBlocked(false, "all", ready)).toBe(false);
      expect(isSourceFilterBlocked(false, null, ready)).toBe(false);
    }
  });

  it("unblocks Instant Form and Other once the lookup succeeds", () => {
    expect(isSourceFilterBlocked(false, "instant_form", true)).toBe(false);
    expect(isSourceFilterBlocked(false, "other", true)).toBe(false);
  });

  it("never blocks server-side search (SQL EXISTS classifies independently)", () => {
    // Even with the lookup pending or failed, search results — already
    // classified by the RPC — render untouched.
    for (const source of ["instant_form", "other", "ctwa", "all", null] as const) {
      expect(isSourceFilterBlocked(true, source, false)).toBe(false);
    }
  });

  it("stays blocked after a failed lookup until retry succeeds", () => {
    // Failure keeps ready=false, so both lookup-dependent options stay
    // gated; the retry path flips ready on success.
    expect(isSourceFilterBlocked(false, "instant_form", false)).toBe(true);
    expect(isSourceFilterBlocked(false, "other", false)).toBe(true);
    expect(isSourceFilterBlocked(false, "instant_form", true)).toBe(false);
  });
});

describe("matchesFormFilter", () => {
  const forms = (entries: [string, string[]][]) =>
    new Map(entries.map(([cid, fids]) => [cid, new Set(fids)]));

  it("matches everything when All Forms is selected", () => {
    const conv = makeConversation({ company: "Acme" });
    expect(matchesFormFilter(conv, null, new Map())).toBe(true);
    expect(
      matchesFormFilter(conv, null, forms([["ct1", ["form-1"]]]))
    ).toBe(true);
  });

  it("matches only conversations whose contact has that exact form", () => {
    const map = forms([
      ["ct1", ["form-1", "form-2"]],
      ["ct2", ["form-2"]],
    ]);
    const conv = makeConversation({ company: "Acme" });
    expect(matchesFormFilter(conv, "form-1", map)).toBe(true);
    expect(matchesFormFilter(conv, "form-2", map)).toBe(true);
    expect(matchesFormFilter(conv, "form-3", map)).toBe(false);
    // A different contact's forms never match this thread.
    expect(matchesFormFilter(conv, "form-1", forms([["ct9", ["form-1"]]]))).toBe(
      false
    );
    expect(matchesFormFilter(conv, "form-1", new Map())).toBe(false);
  });

  it("matches each submission independently: no duplicates, no cross-talk", () => {
    // Contact with two processed submissions for two forms matches
    // either form id exactly once (boolean match, never a row dup).
    const map = forms([["ct1", ["form-a", "form-b"]]]);
    const conv = makeConversation({ company: "Acme" });
    expect(matchesFormFilter(conv, "form-a", map)).toBe(true);
    expect(matchesFormFilter(conv, "form-b", map)).toBe(true);
    // Missing contact embed still matches via contact_id linkage.
    const bare = { id: "c1", contact_id: "ct1" };
    expect(matchesFormFilter(bare, "form-a", map)).toBe(true);
    expect(matchesFormFilter(bare, "form-z", map)).toBe(false);
  });

  it("combines with source and contact filters without interference", () => {
    const conv = makeConversation({
      company: "Acme",
      tags: [{ id: "t1", user_id: "u1", name: "t1", color: "#fff", created_at: "" }],
    });
    const contactOk = matchesContactFilters(conv, {
      tagIds: ["t1"],
      company: "Acme",
      flowId: null,
    });
    expect(contactOk).toBe(true);
    const map = forms([["ct1", ["form-1"]]]);
    expect(matchesFormFilter(conv, "form-1", map)).toBe(true);
    expect(matchesFormFilter(conv, "form-2", map)).toBe(false);
    expect(matchesLeadSource(conv, "instant_form", new Set(["ct1"]))).toBe(
      true
    );
  });
});

describe("matchesStatusFilter", () => {
  const base: { id: string; contact_id: string; unread_count?: number } = {
    id: "c",
    contact_id: "ct",
  };

  it("All passes everything regardless of unread count", () => {
    expect(matchesStatusFilter({ ...base, unread_count: 0 }, "all")).toBe(true);
    expect(matchesStatusFilter({ ...base, unread_count: 5 }, "all")).toBe(true);
  });

  it("Unread keeps only threads with unread messages", () => {
    expect(matchesStatusFilter({ ...base, unread_count: 0 }, "unread")).toBe(false);
    expect(matchesStatusFilter({ ...base, unread_count: 1 }, "unread")).toBe(true);
    expect(matchesStatusFilter({ ...base, unread_count: 12 }, "unread")).toBe(true);
  });
});

describe("hasActiveInboxFilters", () => {
  const idle = { hasContactFilters: false, hasDateFilter: false, status: "all" };

  it("is false only when every facet sits at its default", () => {
    expect(hasActiveInboxFilters(idle)).toBe(false);
  });

  it("is true for Unread alone (no chip exists for status)", () => {
    expect(hasActiveInboxFilters({ ...idle, status: "unread" })).toBe(true);
  });

  it("is true for an applied date alone (no chip exists for date here)", () => {
    expect(hasActiveInboxFilters({ ...idle, hasDateFilter: true })).toBe(true);
  });

  it("is true for any chip-backed facet and for combinations", () => {
    expect(hasActiveInboxFilters({ ...idle, hasContactFilters: true })).toBe(true);
    expect(
      hasActiveInboxFilters({ hasContactFilters: true, hasDateFilter: true, status: "unread" })
    ).toBe(true);
  });
});

// DB NULLs arrive as null at runtime even though the type says
// `string | undefined`; both mean "no value" to the classifiers.
const NULL = null as unknown as undefined;

describe("matchesTeamFilter", () => {
  const base: { id: string; contact_id: string; assigned_agent_id?: string } = {
    id: "c",
    contact_id: "ct",
  };

  it("empty selection matches everything (All team members)", () => {
    expect(matchesTeamFilter({ ...base, assigned_agent_id: "m1" }, [])).toBe(true);
    expect(matchesTeamFilter({ ...base, assigned_agent_id: NULL }, [])).toBe(true);
    expect(matchesTeamFilter({ ...base }, [])).toBe(true);
  });

  it("matches the assigned member id exactly", () => {
    expect(matchesTeamFilter({ ...base, assigned_agent_id: "m1" }, ["m1"])).toBe(true);
    expect(matchesTeamFilter({ ...base, assigned_agent_id: "m1" }, ["m2"])).toBe(false);
    expect(matchesTeamFilter({ ...base, assigned_agent_id: "m1" }, ["m1", "m2"])).toBe(true);
  });

  it("matches unassigned threads only via the unassigned sentinel", () => {
    expect(matchesTeamFilter({ ...base, assigned_agent_id: NULL }, ["unassigned"])).toBe(true);
    expect(matchesTeamFilter({ ...base }, ["unassigned"])).toBe(true);
    expect(matchesTeamFilter({ ...base, assigned_agent_id: NULL }, ["m1"])).toBe(false);
    expect(matchesTeamFilter({ ...base, assigned_agent_id: "m1" }, ["unassigned"])).toBe(false);
  });
});

describe("buildFormOptions", () => {
  it("returns distinct forms with actual records, labeled and sorted", () => {
    const out = buildFormOptions([
      { form_id: "f2", form_name: "Zebra Form" },
      { form_id: "f1", form_name: "Kashmir Couple Lead Form - 29 Oct" },
      { form_id: "f2", form_name: "Zebra Form" },
      { form_id: "f1", form_name: "Kashmir Couple Lead Form - 29 Oct" },
    ]);
    expect(out).toEqual([
      { id: "f1", name: "Kashmir Couple Lead Form - 29 Oct" },
      { id: "f2", name: "Zebra Form" },
    ]);
  });

  it("skips rows without a form id (unfilterable server-side)", () => {
    expect(
      buildFormOptions([
        { form_id: null, form_name: "Orphan" },
        { form_id: "f1", form_name: "Real Form" },
      ])
    ).toEqual([{ id: "f1", name: "Real Form" }]);
  });

  it("falls back to the raw id when the name is blank or missing", () => {
    expect(buildFormOptions([{ form_id: "abc123", form_name: "   " }])).toEqual([
      { id: "abc123", name: "abc123" },
    ]);
    expect(buildFormOptions([{ form_id: "abc123", form_name: null }])).toEqual([
      { id: "abc123", name: "abc123" },
    ]);
  });

  it("keeps the first non-blank name per form id and trims whitespace", () => {
    const out = buildFormOptions([
      { form_id: "f1", form_name: null },
      { form_id: "f1", form_name: "  Named Later  " },
    ]);
    // First-seen wins (null name stored); rows are deduped by id.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("f1");
  });

  it("returns an empty list when there are no form records", () => {
    expect(buildFormOptions([])).toEqual([]);
  });
});

describe("Inbox filter combinations (AND across facets, OR within tags)", () => {
  const T = (overrides: Record<string, unknown> = {}): Conversation => ({
    id: "cx",
    user_id: "u1",
    contact_id: "ctx",
    status: "open",
    unread_count: 0,
    last_message_at: "2026-09-10T12:00:00.000Z",
    created_at: "",
    updated_at: "",
    ...overrides,
  }) as Conversation;
  const sub = (ids: string[]) => new Set(ids);
  const forms = (entries: [string, string[]][]) =>
    new Map(entries.map(([cid, fids]) => [cid, new Set(fids)]));

  // Fixture threads:
  // A: instant-form (form f1) + tags + assigned m1 + unread, Sep 10
  // B: ctwa-only + company Acme + flow f9 + assigned m2, Sep 10
  // C: no source + no tags + unassigned + read, Sep 12
  const A = () =>
    T({
      id: "a",
      contact_id: "cA",
      unread_count: 3,
      contact: { id: "cA", tags: [{ id: "t1" }], flow_id: "f9" },
    });
  const B = () =>
    T({
      id: "b",
      contact_id: "cB",
      contact: { source_url: "https://fb.me/x", company: "Acme", flow_id: "f9", tags: [] },
      assigned_agent_id: "m2",
    });
  const C = () =>
    T({ id: "c", contact_id: "cC", last_message_at: "2026-09-12T12:00:00.000Z" });

  const subs = sub(["cA"]);
  const formMap = forms([["cA", ["f1", "f2"]]]);
  const rangeSep10 = getConversationDateRange(
    { filter: "custom", customFrom: "2026-09-10", customTo: "2026-09-10" },
    new Date(2026, 8, 15)
  )!;

  function pipeline(
    convs: ReturnType<typeof T>[],
    f: {
      status?: "all" | "unread";
      tagIds?: string[];
      company?: string | null;
      flowId?: string | null;
      source?: "all" | "instant_form" | "ctwa" | "other" | null;
      formId?: string | null;
      memberIds?: string[];
      range?: { from: Date; to: Date } | null;
    }
  ) {
    return convs
      .filter((c) => (f.range ? matchesConversationDateFilter(c, f.range) : true))
      .filter((c) => matchesStatusFilter(c, f.status ?? "all"))
      .filter((c) =>
        matchesContactFilters(c, {
          tagIds: f.tagIds ?? [],
          company: f.company ?? null,
          flowId: f.flowId ?? null,
        })
      )
      .filter((c) =>
        f.source && f.source !== "all"
          ? matchesLeadSource(c, f.source, subs)
          : true
      )
      .filter((c) =>
        f.source === "instant_form" && f.formId
          ? matchesFormFilter(c, f.formId, formMap)
          : true
      )
      .filter((c) => matchesTeamFilter(c, f.memberIds ?? []));
  }

  it("Lead Source + Date: instant_form on Sep 10 keeps only A", () => {
    expect(pipeline([A(), B(), C()], { source: "instant_form", range: rangeSep10 }).map((c) => c.id)).toEqual(["a"]);
    // Same date, ctwa source: only B.
    expect(pipeline([A(), B(), C()], { source: "ctwa", range: rangeSep10 }).map((c) => c.id)).toEqual(["b"]);
  });

  it("Lead Source + Tags: tags stay OR within, ANDed with source", () => {
    // A has t1 + submission; B has no tags.
    expect(
      pipeline([A(), B(), C()], { source: "instant_form", tagIds: ["t1", "t9"] }).map((c) => c.id)
    ).toEqual(["a"]);
    expect(
      pipeline([A(), B(), C()], { source: "instant_form", tagIds: ["t9"] }).map((c) => c.id)
    ).toEqual([]);
  });

  it("Lead Source + Team: assignment narrows within the source bucket", () => {
    expect(
      pipeline([A(), B(), C()], { source: "ctwa", memberIds: ["m2"] }).map((c) => c.id)
    ).toEqual(["b"]);
    expect(
      pipeline([A(), B(), C()], { source: "ctwa", memberIds: ["m1"] }).map((c) => c.id)
    ).toEqual([]);
    // Unassigned sentinel matches threads with no assignee (A and C here).
    expect(
      pipeline([A(), B(), C()], { memberIds: ["unassigned"] }).map((c) => c.id)
    ).toEqual(["a", "c"]);
  });

  it("Lead Source + Form: form narrows within instant_form", () => {
    expect(
      pipeline([A(), B(), C()], { source: "instant_form", formId: "f2" }).map((c) => c.id)
    ).toEqual(["a"]);
    expect(
      pipeline([A(), B(), C()], { source: "instant_form", formId: "f9" }).map((c) => c.id)
    ).toEqual([]);
    // All Forms (null) does not narrow.
    expect(
      pipeline([A(), B(), C()], { source: "instant_form", formId: null }).map((c) => c.id)
    ).toEqual(["a"]);
  });

  it("Date + Tags + Team combine with AND", () => {
    expect(
      pipeline([A(), B(), C()], {
        range: rangeSep10,
        tagIds: ["t1"],
        memberIds: [],
      }).map((c) => c.id)
    ).toEqual(["a"]);
  });

  it("Lead Source + Date + Tags + Team all apply together", () => {
    const all = [A(), B(), C()];
    expect(
      pipeline(all, {
        source: "ctwa",
        range: rangeSep10,
        tagIds: [],
        company: "Acme",
        memberIds: ["m2"],
      }).map((c) => c.id)
    ).toEqual(["b"]);
    // One facet off -> empty.
    expect(
      pipeline(all, {
        source: "ctwa",
        range: rangeSep10,
        memberIds: ["m1"],
      }).map((c) => c.id)
    ).toEqual([]);
  });

  it("Flow + Date + Team combine with AND", () => {
    expect(
      pipeline([A(), B(), C()], { flowId: "f9", range: rangeSep10, memberIds: ["m2"] }).map(
        (c) => c.id
      )
    ).toEqual(["b"]);
  });

  it("clearing one filter keeps the others (independence)", () => {
    // Source + tag active; clearing the tag keeps the source result.
    const withBoth = pipeline([A(), B(), C()], { source: "instant_form", tagIds: ["t1"] });
    expect(withBoth.map((c) => c.id)).toEqual(["a"]);
    const tagCleared = pipeline([A(), B(), C()], { source: "instant_form", tagIds: [] });
    expect(tagCleared.map((c) => c.id)).toEqual(["a"]);
  });

  it("clear-all state matches everything", () => {
    expect(pipeline([A(), B(), C()], {}).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("switching sources re-buckets the same threads", () => {
    const all = [A(), B(), C()];
    expect(pipeline(all, { source: "instant_form" }).map((c) => c.id)).toEqual(["a"]);
    expect(pipeline(all, { source: "ctwa" }).map((c) => c.id)).toEqual(["b"]);
    expect(pipeline(all, { source: "other" }).map((c) => c.id)).toEqual(["c"]);
    expect(pipeline(all, { source: "all" }).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("duplicate tag selections do not duplicate conversations", () => {
    const res = pipeline([A(), B(), C()], { tagIds: ["t1", "t1"] });
    expect(res.map((c) => c.id)).toEqual(["a"]);
  });
});
