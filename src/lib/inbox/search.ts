// Server-side Inbox search — shared pure helpers (unit-tested).
//
// The browser never searches its loaded array anymore: the query goes
// to GET /api/inbox/search, which runs search_inbox_conversations()
// (migration 078) and hydrates via CONVERSATION_SELECT, so results
// render identically to normal Inbox conversations.

export const SEARCH_PAGE_SIZE = 25;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_QUERY_LENGTH = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NO_FLOW_SENTINEL = "__no_flow__";

export type InboxLeadSource = "all" | "instant_form" | "ctwa" | "other";

export const LEAD_SOURCES: InboxLeadSource[] = [
  "all",
  "instant_form",
  "ctwa",
  "other",
];

/** Toolbar labels for the Lead Source dropdown (value → display). */
export const LEAD_SOURCE_LABELS: Record<InboxLeadSource, string> = {
  all: "All Sources",
  instant_form: "Meta Lead Ads (Instant Form)",
  // "Click-to-WhatsApp" without "Ads": the predicate also matches organic
  // Facebook Page-post referrals (source_type 'post'), not only paid ads.
  ctwa: "Click-to-WhatsApp",
  other: "Other / Unknown",
};

export type InboxSearchStatus =
  | "all"
  | "unread"
  | "open"
  | "pending"
  | "closed";

const STATUSES: InboxSearchStatus[] = [
  "all",
  "unread",
  "open",
  "pending",
  "closed",
];

/** Trimmed query. Internal spaces preserved; outer whitespace dropped
 *  (the old client kept whitespace in the actual match string). */
export function normalizeSearchQuery(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

// ------------------------------------------------------------
// Opaque keyset cursor: base64url(JSON{ts: string|null, id: uuid}).
// `ts` is the row's last_message_at (null allowed — the Inbox
// orders nulls first). Same validation rigor as the v1 codec:
// hand-crafted cursors decode to null (first page), never into SQL.
// ------------------------------------------------------------

export interface SearchCursor {
  ts: string | null;
  id: string;
}

export function encodeSearchCursor(row: {
  last_message_at: string | null;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ ts: row.last_message_at, id: row.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeSearchCursor(value: string | null): SearchCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { ts?: unknown; id?: unknown };
    if (!parsed || typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) {
      return null;
    }
    if (parsed.ts !== null && parsed.ts !== undefined) {
      if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) {
        return null;
      }
      return { ts: parsed.ts, id: parsed.id };
    }
    return { ts: null, id: parsed.id };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Request gate (Contacts-style sequence guard as a pure unit).
// Every new search/page bumps the sequence; a response applies
// only if its sequence is still current — stale abc responses can
// never overwrite abcd, and late page-2s die with their search.
// ------------------------------------------------------------

export class SearchRequestGate {
  private seq = 0;

  /** Start a request; returns its sequence token. */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Invalidate everything outstanding (clear, unmount). */
  invalidate(): void {
    this.seq += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.seq;
  }
}

export interface SearchPage<T extends { id: string }> {
  key: string;
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Merge a fetched page into existing results. Returns null when the
 * page belongs to a superseded search (wrong key) — the caller
 * discards it. Otherwise appends unseen ids, preserving server order.
 */
export function mergeSearchPage<T extends { id: string }>(
  existing: T[],
  page: SearchPage<T>,
  key: string,
): T[] | null {
  if (page.key !== key) return null;
  if (existing.length === 0) return [...page.items];
  const seen = new Set(existing.map((c) => c.id));
  const fresh = page.items.filter((c) => !seen.has(c.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

/** Stable identity of one search (query + every applied filter). */
export function buildSearchKey(parts: {
  q: string;
  status: string;
  tagIds: string[];
  company: string | null;
  flowId: string | null;
  memberIds: string[];
  from: string | null;
  to: string | null;
  source: string;
}): string {
  return JSON.stringify({
    q: parts.q,
    status: parts.status,
    tagIds: [...parts.tagIds].sort(),
    company: parts.company,
    flowId: parts.flowId,
    memberIds: [...parts.memberIds].sort(),
    from: parts.from,
    to: parts.to,
    source: parts.source,
  });
}

export interface ParsedSearchRequest {
  q: string;
  status: InboxSearchStatus;
  tagIds: string[];
  company: string | null;
  flowId: string | null;
  memberIds: string[];
  from: string | null;
  to: string | null;
  /** Lead Source facet; always a validated InboxLeadSource. */
  source: InboxLeadSource;
  cursor: SearchCursor | null;
  limit: number;
}

export class SearchParamsError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "SearchParamsError";
  }
}

/** Validate + normalize URLSearchParams. Throws SearchParamsError(400). */
export function parseSearchRequestParams(
  params: URLSearchParams,
): ParsedSearchRequest {
  const q = normalizeSearchQuery(params.get("q") ?? "");
  if (!q) throw new SearchParamsError("Search query is required.");

  const status = params.get("status") ?? "all";
  if (!(STATUSES as string[]).includes(status)) {
    throw new SearchParamsError(`Invalid status: ${status}`);
  }

  const tagIds = (params.get("tags") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of tagIds) {
    if (!UUID_RE.test(id)) throw new SearchParamsError(`Invalid tag id: ${id}`);
  }

  const companyRaw = (params.get("company") ?? "").trim();
  const company = companyRaw ? companyRaw : null;

  const flowId = params.get("flow") ?? null;
  if (
    flowId !== null &&
    flowId !== NO_FLOW_SENTINEL &&
    !UUID_RE.test(flowId)
  ) {
    throw new SearchParamsError(`Invalid flow id: ${flowId}`);
  }

  const memberIds = (params.get("members") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of memberIds) {
    if (id !== "unassigned" && !UUID_RE.test(id)) {
      throw new SearchParamsError(`Invalid member id: ${id}`);
    }
  }

  const source = params.get("source") ?? "all";
  if (!(LEAD_SOURCES as string[]).includes(source)) {
    throw new SearchParamsError(`Invalid source: ${source}`);
  }

  const parseDate = (v: string | null, name: string): string | null => {
    if (v === null || v === "") return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new SearchParamsError(`Invalid ${name}: ${v}`);
    return new Date(t).toISOString();
  };
  const from = parseDate(params.get("from"), "from");
  const to = parseDate(params.get("to"), "to");

  const rawLimit = Number(params.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SEARCH_MAX_LIMIT)
      : SEARCH_PAGE_SIZE;

  return {
    q,
    status: status as InboxSearchStatus,
    tagIds,
    company,
    flowId,
    memberIds,
    from,
    to,
    source: source as InboxLeadSource,
    cursor: decodeSearchCursor(params.get("cursor")),
    limit,
  };
}

export interface LoadMoreReadiness {
  searching: boolean;
  /** Page-1 request for the CURRENT key still in flight. */
  searchLoading: boolean;
  /** Key of the last fully loaded page-1 ("" = none yet). */
  loadedSearchKey: string;
  /** Key of the currently requested search. */
  searchKey: string;
  searchHasMore: boolean;
  searchLoadingMore: boolean;
  searchCursor: string | null;
}

/**
 * Single rule for "may Load More fire with this cursor": only when a
 * page-1 for the CURRENT search key has fully loaded. A cursor from a
 * previous search must never be reused — while a new page-1 is in
 * flight (or before any has loaded) Load More stays disabled, so a
 * stale cursor can neither kill the new page-1 nor append rows from
 * the wrong query. Used by both the click guard and the button.
 */
export function canLoadMoreSearch(state: LoadMoreReadiness): boolean {
  return (
    state.searching &&
    !state.searchLoading &&
    state.loadedSearchKey !== "" &&
    state.loadedSearchKey === state.searchKey &&
    state.searchHasMore &&
    !state.searchLoadingMore &&
    state.searchCursor !== null
  );
}
