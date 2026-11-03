// ============================================================
// /api/inbox/search — server-side paginated Inbox search.
//
// Replaces the old client-side `conversations.filter(...)`: the DB
// matches (name / raw phone / normalized phone / last message)
// ANDed with the active Inbox filters, keyset-paginated, and the
// client hydrates each page via CONVERSATION_SELECT so results
// render exactly like normal conversations.
//
// Security: session auth via getCurrentAccount (RLS-scoped SSR
// client); the RPC resolves the account from auth.uid() itself —
// no account_id is accepted from the browser. Rate-limited per user.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import {
  CONVERSATION_SELECT,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import {
  filterHiddenIds,
  getHiddenConversationIds,
} from "@/lib/inbox/hidden";
import {
  SEARCH_PAGE_SIZE,
  encodeSearchCursor,
  parseSearchRequestParams,
  SearchParamsError,
} from "@/lib/inbox/search";

export const dynamic = "force-dynamic";

interface RpcResult {
  ids: string[];
  has_more: boolean;
}

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const limit = checkRateLimit(`inbox:search:${ctx.userId}`, RATE_LIMITS.search);
  if (!limit.success) return rateLimitResponse(limit);

  let params;
  try {
    params = parseSearchRequestParams(new URL(request.url).searchParams);
  } catch (err) {
    if (err instanceof SearchParamsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }

  const { data, error } = await ctx.supabase.rpc(
    "search_inbox_conversations",
    {
      p_search: params.q,
      p_status: params.status,
      p_tag_ids: params.tagIds,
      p_company: params.company,
      p_flow_id: params.flowId,
      p_member_ids: params.memberIds,
      p_from: params.from,
      p_to: params.to,
      p_cur_ts: params.cursor?.ts ?? null,
      p_cur_id: params.cursor?.id ?? null,
      p_limit: params.limit,
      p_source: params.source,
      p_form_id: params.metaFormId,
    },
  );

  if (error) {
    console.error("[inbox/search] rpc error:", {
      message: error.message,
      code: error.code,
    });
    return NextResponse.json(
      { error: "Search failed. Please try again." },
      { status: 500 },
    );
  }

  const { ids = [], has_more = false } = (data ?? {}) as Partial<RpcResult>;

  if (!Array.isArray(ids) || ids.length === 0) {
    const res = NextResponse.json({
      conversations: [],
      has_more: false,
      next_cursor: null,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  // Hydrate through the same select + normalizer as the normal list —
  // identical shape, tags, flow runs, and contact fields. RLS applies
  // again here (defense in depth alongside the RPC's own scoping).
  // Cap to a page: the RPC never returns more than limit+1 ids, and
  // `.in()` preserves no order, so re-sort by the RPC's ordering.
  // Tenant-scoped hidden threads are removed before hydration so they
  // never appear in results (Inbox display rule only).
  const hiddenIds = await getHiddenConversationIds(ctx.supabase);
  const visibleIds = filterHiddenIds(ids, hiddenIds);
  const pageIds = visibleIds.slice(0, params.limit || SEARCH_PAGE_SIZE);
  const { data: rows, error: hydrateError } = await ctx.supabase
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .in("id", pageIds);

  if (hydrateError) {
    console.error("[inbox/search] hydrate error:", {
      message: hydrateError.message,
      code: hydrateError.code,
    });
    return NextResponse.json(
      { error: "Search failed. Please try again." },
      { status: 500 },
    );
  }

  const order = new Map(pageIds.map((id, i) => [id, i]));
  const conversations = normalizeConversations(
    ((rows ?? []) as unknown as Parameters<typeof normalizeConversations>[0]),
  ).sort(
    (a, b) =>
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  const last = conversations[conversations.length - 1];
  const nextCursor =
    has_more && last
      ? encodeSearchCursor({ last_message_at: last.last_message_at ?? null, id: last.id })
      : null;

  const res = NextResponse.json({
    conversations,
    has_more,
    next_cursor: nextCursor,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
