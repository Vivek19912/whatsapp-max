import { describe, expect, it } from "vitest";
import {
  buildSearchKey,
  canLoadMoreSearch,
  decodeSearchCursor,
  encodeSearchCursor,
  mergeSearchPage,
  normalizeSearchQuery,
  parseSearchRequestParams,
  SearchParamsError,
  SearchRequestGate,
  type LoadMoreReadiness,
} from "./search";

const conv = (id: string) => ({ id });

describe("normalizeSearchQuery", () => {
  it('trims " john " to "john" and preserves internal spaces', () => {
    expect(normalizeSearchQuery(" john ")).toBe("john");
    expect(normalizeSearchQuery("new  delhi")).toBe("new  delhi");
  });

  it("maps whitespace-only and empty to empty", () => {
    expect(normalizeSearchQuery("   ")).toBe("");
    expect(normalizeSearchQuery("")).toBe("");
  });

  it("caps pathological lengths", () => {
    expect(normalizeSearchQuery("a".repeat(500)).length).toBeLessThanOrEqual(
      200,
    );
  });
});

describe("search cursor codec", () => {
  it("round-trips (ts, id), including null timestamps", () => {
    const c = { last_message_at: "2026-09-20T10:00:00.000Z", id: "11111111-1111-1111-1111-111111111111" };
    expect(decodeSearchCursor(encodeSearchCursor(c))).toEqual({
      ts: c.last_message_at,
      id: c.id,
    });
    const n = { last_message_at: null, id: "22222222-2222-2222-2222-222222222222" };
    expect(decodeSearchCursor(encodeSearchCursor(n))).toEqual({
      ts: null,
      id: n.id,
    });
  });

  it("rejects missing, malformed, and hand-crafted cursors", () => {
    expect(decodeSearchCursor(null)).toBeNull();
    expect(decodeSearchCursor("")).toBeNull();
    expect(decodeSearchCursor("!!!not-base64!!!")).toBeNull();
    // Valid base64 but not our shape.
    expect(
      decodeSearchCursor(Buffer.from("hello", "utf8").toString("base64url")),
    ).toBeNull();
    // Non-UUID id smuggling attempt.
    const evil = Buffer.from(
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", id: "1 OR 1=1" }),
      "utf8",
    ).toString("base64url");
    expect(decodeSearchCursor(evil)).toBeNull();
    // Garbage timestamp.
    const badTs = Buffer.from(
      JSON.stringify({ ts: "not-a-date", id: "11111111-1111-1111-1111-111111111111" }),
      "utf8",
    ).toString("base64url");
    expect(decodeSearchCursor(badTs)).toBeNull();
  });
});

describe("SearchRequestGate", () => {
  it("keeps only the latest sequence current (abc → abcd)", () => {
    const gate = new SearchRequestGate();
    const a = gate.next(); // "abc"
    const b = gate.next(); // "abcd"
    expect(gate.isCurrent(a)).toBe(false);
    expect(gate.isCurrent(b)).toBe(true);
  });

  it("A → B → C leaves only C current", () => {
    const gate = new SearchRequestGate();
    const a = gate.next();
    gate.next();
    const c = gate.next();
    expect(gate.isCurrent(a)).toBe(false);
    expect(gate.isCurrent(c)).toBe(true);
  });

  it("invalidate() kills everything (clear / unmount)", () => {
    const gate = new SearchRequestGate();
    const a = gate.next();
    gate.invalidate();
    expect(gate.isCurrent(a)).toBe(false);
  });
});

describe("mergeSearchPage", () => {
  const page = (key: string, ids: string[], hasMore = true) => ({
    key,
    items: ids.map(conv),
    hasMore,
    nextCursor: hasMore ? "cursor" : null,
  });

  it("appends unseen ids in server order and skips duplicates", () => {
    const merged = mergeSearchPage(
      [conv("a"), conv("b")],
      page("k", ["b", "c", "d"], false),
      "k",
    );
    expect(merged?.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("discards pages from a superseded search (late john p2 vs rahul)", () => {
    const merged = mergeSearchPage([conv("r1")], page("john", ["j3"], true), "rahul");
    expect(merged).toBeNull();
  });

  it("returns the existing array untouched when nothing new arrives", () => {
    const existing = [conv("a")];
    expect(mergeSearchPage(existing, page("k", ["a"], false), "k")).toBe(
      existing,
    );
  });
});

describe("buildSearchKey", () => {
  it("is stable regardless of id ordering and distinguishes queries", () => {
    const base = {
      q: "john",
      status: "all",
      tagIds: ["t2", "t1"],
      company: null,
      flowId: null,
      memberIds: ["m1"],
      from: null,
      to: null,
      source: "all",
      metaFormId: null,
    };
    expect(buildSearchKey(base)).toBe(
      buildSearchKey({ ...base, tagIds: ["t1", "t2"] }),
    );
    expect(buildSearchKey(base)).not.toBe(buildSearchKey({ ...base, q: "rahul" }));
    expect(buildSearchKey(base)).not.toBe(
      buildSearchKey({ ...base, status: "open" }),
    );
  });

  it("distinguishes Lead Source selections so stale results are never shown", () => {
    const base = {
      q: "john",
      status: "all",
      tagIds: [],
      company: null,
      flowId: null,
      memberIds: [],
      from: null,
      to: null,
      source: "all",
      metaFormId: null,
    };
    expect(buildSearchKey(base)).not.toBe(
      buildSearchKey({ ...base, source: "instant_form" }),
    );
    expect(buildSearchKey(base)).not.toBe(
      buildSearchKey({ ...base, source: "ctwa" }),
    );
    expect(buildSearchKey(base)).not.toBe(
      buildSearchKey({ ...base, source: "other" }),
    );
    expect(buildSearchKey({ ...base, source: "ctwa" })).toBe(
      buildSearchKey({ ...base, source: "ctwa" }),
    );
  });

  it("distinguishes Meta Form selections within Instant Form", () => {
    const base = {
      q: "john",
      status: "all",
      tagIds: [],
      company: null,
      flowId: null,
      memberIds: [],
      from: null,
      to: null,
      source: "instant_form",
      metaFormId: null,
    };
    expect(buildSearchKey(base)).not.toBe(
      buildSearchKey({ ...base, metaFormId: "form-1" }),
    );
    expect(buildSearchKey({ ...base, metaFormId: "form-1" })).toBe(
      buildSearchKey({ ...base, metaFormId: "form-1" }),
    );
    expect(buildSearchKey({ ...base, metaFormId: "form-1" })).not.toBe(
      buildSearchKey({ ...base, metaFormId: "form-2" }),
    );
  });
});

describe("parseSearchRequestParams", () => {
  const params = (q: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({ q, ...extra });

  it("parses a full valid request", () => {
    const p = parseSearchRequestParams(
      params(" +91 98765 43210 ", {
        status: "open",
        tags: "11111111-1111-1111-1111-111111111111",
        company: "Acme",
        flow: "__no_flow__",
        members: "unassigned,22222222-2222-2222-2222-222222222222",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-20T00:00:00.000Z",
        limit: "10",
      }),
    );
    expect(p.q).toBe("+91 98765 43210");
    expect(p.status).toBe("open");
    expect(p.tagIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(p.company).toBe("Acme");
    expect(p.flowId).toBe("__no_flow__");
    expect(p.memberIds).toEqual([
      "unassigned",
      "22222222-2222-2222-2222-222222222222",
    ]);
    expect(p.limit).toBe(10);
    expect(p.cursor).toBeNull();
    expect(p.metaFormId).toBeNull();
  });

  it("parses the Meta Form facet and defaults it to All Forms", () => {
    expect(parseSearchRequestParams(params("x")).metaFormId).toBeNull();
    expect(
      parseSearchRequestParams(params("x", { meta_form: "" })).metaFormId,
    ).toBeNull();
    expect(
      parseSearchRequestParams(params("x", { meta_form: "  " })).metaFormId,
    ).toBeNull();
    // Raw Meta string id — trimmed, never UUID-validated.
    expect(
      parseSearchRequestParams(params("x", { meta_form: "  form-abc-123  " }))
        .metaFormId,
    ).toBe("form-abc-123");
  });

  it("defaults Lead Source to all and parses each valid option", () => {
    expect(parseSearchRequestParams(params("x")).source).toBe("all");
    expect(parseSearchRequestParams(params("x", { source: "all" })).source).toBe(
      "all",
    );
    expect(
      parseSearchRequestParams(params("x", { source: "instant_form" })).source,
    ).toBe("instant_form");
    expect(
      parseSearchRequestParams(params("x", { source: "ctwa" })).source,
    ).toBe("ctwa");
    expect(
      parseSearchRequestParams(params("x", { source: "other" })).source,
    ).toBe("other");
  });

  it("rejects empty queries, bad enums, and malformed ids/dates", () => {
    expect(() => parseSearchRequestParams(params("   "))).toThrow(
      SearchParamsError,
    );
    expect(() => parseSearchRequestParams(params("x", { status: "bogus" }))).toThrow(
      SearchParamsError,
    );
    expect(() => parseSearchRequestParams(params("x", { tags: "nope" }))).toThrow(
      SearchParamsError,
    );
    expect(() =>
      parseSearchRequestParams(params("x", { flow: "nope" })),
    ).toThrow(SearchParamsError);
    expect(() =>
      parseSearchRequestParams(params("x", { members: "nope" })),
    ).toThrow(SearchParamsError);
    expect(() =>
      parseSearchRequestParams(params("x", { from: "not-a-date" })),
    ).toThrow(SearchParamsError);
    expect(() =>
      parseSearchRequestParams(params("x", { source: "bogus" })),
    ).toThrow(SearchParamsError);
  });

  it("clamps limits and round-trips cursors", () => {
    expect(
      parseSearchRequestParams(params("x", { limit: "9999" })).limit,
    ).toBe(100);
    expect(parseSearchRequestParams(params("x")).limit).toBe(25);
    const cursor = encodeSearchCursor({
      last_message_at: "2026-09-20T10:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    });
    expect(
      parseSearchRequestParams(params("x", { cursor })).cursor,
    ).toEqual({
      ts: "2026-09-20T10:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    });
    // Malformed cursor degrades to first page, never errors.
    expect(
      parseSearchRequestParams(params("x", { cursor: "bogus" })).cursor,
    ).toBeNull();
  });
});

describe("canLoadMoreSearch", () => {
  const ready: LoadMoreReadiness = {
    searching: true,
    searchLoading: false,
    loadedSearchKey: "B",
    searchKey: "B",
    searchHasMore: true,
    searchLoadingMore: false,
    searchCursor: "cursor-B",
  };

  it("allows Load More once the current search page-1 is loaded", () => {
    expect(canLoadMoreSearch(ready)).toBe(true);
  });

  it("blocks while a new page-1 is in flight (old cursor must not fire)", () => {
    // Search A loaded, user typed B: cursor-A is stale until B loads.
    expect(
      canLoadMoreSearch({ ...ready, searchLoading: true, searchKey: "B", loadedSearchKey: "A" }),
    ).toBe(false);
  });

  it("blocks before any page-1 has loaded", () => {
    expect(
      canLoadMoreSearch({ ...ready, searchLoading: true, loadedSearchKey: "" }),
    ).toBe(false);
  });

  it("blocks when the loaded key differs, even with a cursor present", () => {
    expect(
      canLoadMoreSearch({ ...ready, loadedSearchKey: "A", searchKey: "B" }),
    ).toBe(false);
  });

  it("blocks when not searching, exhausted, paging, or cursorless", () => {
    expect(canLoadMoreSearch({ ...ready, searching: false })).toBe(false);
    expect(canLoadMoreSearch({ ...ready, searchHasMore: false })).toBe(false);
    expect(canLoadMoreSearch({ ...ready, searchLoadingMore: true })).toBe(false);
    expect(canLoadMoreSearch({ ...ready, searchCursor: null })).toBe(false);
  });

  it("re-allows paging after the new search settles (normal flow resumes)", () => {
    expect(
      canLoadMoreSearch({
        ...ready,
        loadedSearchKey: "B",
        searchKey: "B",
        searchCursor: "cursor-B2",
      }),
    ).toBe(true);
  });
});
