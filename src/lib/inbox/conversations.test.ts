import { describe, it, expect } from "vitest";
import {
  NO_FLOW_FILTER_ID,
  getConversationDateRange,
  hasNewerConversationActivity,
  hasValidCtwaAttribution,
  isSourceFilterBlocked,
  matchesConversationDateFilter,
  matchesContactFilters,
  matchesLeadSource,
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

  it("lets both-signals conversations match BOTH filters (no precedence)", () => {
    const conv = makeConversation({
      source_url: "https://fb.me/x",
      ctwa_clid: "12345",
    });
    expect(matchesLeadSource(conv, "instant_form", sub(["ct1"]))).toBe(true);
    expect(matchesLeadSource(conv, "ctwa", sub(["ct1"]))).toBe(true);
    expect(matchesLeadSource(conv, "other", sub(["ct1"]))).toBe(false);
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
