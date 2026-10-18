"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  NO_FLOW_FILTER_ID,
  type ConversationDateFilter,
  getConversationDateRange,
  matchesContactFilters,
  matchesConversationDateFilter,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import {
  addPin,
  canPinMore,
  isConversationPinned,
  partitionPinnedConversations,
  pinnedAtMapFromRecords,
  removePin,
} from "@/lib/inbox/pins";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  buildSearchKey,
  canLoadMoreSearch,
  mergeSearchPage,
  normalizeSearchQuery,
  SEARCH_PAGE_SIZE,
  SearchRequestGate,
} from "@/lib/inbox/search";
import type {
  AccountMember,
  Conversation,
  Tag,
} from "@/types";
import { Search, ChevronDown, Users, X, Pin, Loader2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this only on explicit manual refresh (handleManualRefresh).
   * Tab visibility and Realtime reconnect no longer bump it (removed
   * for egress). Optional so existing callers keep working.
   */
  resyncToken?: number;
}

type InboxFilter = "all" | "unread";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
];

const DATE_FILTER_OPTIONS: { label: string; value: ConversationDateFilter }[] =
  [
    { label: "All dates", value: "all" },
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "Custom...", value: "custom" },
  ];

const PIN_LIMIT_TITLE = "Pin limit reached";
const PIN_LIMIT_DESCRIPTION =
  "You can pin up to 30 chats at a time. Unpin an existing chat before pinning another one.";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [dateFilter, setDateFilter] = useState<ConversationDateFilter>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [draftCustomFrom, setDraftCustomFrom] = useState("");
  const [draftCustomTo, setDraftCustomTo] = useState("");
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  // Flow matches the contact's active (or most recent) flow run.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  // Server-side search state — deliberately separate from the normal
  // `conversations` list so entering/leaving search, paging, or a
  // stale response can never corrupt it. Text matching + every
  // active filter runs in Postgres (GET /api/inbox/search); the
  // client only renders pages.
  const [searchResults, setSearchResults] = useState<Conversation[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetry, setSearchRetry] = useState(0);
  // Key of the last successfully loaded page-1. While a newer key is
  // in flight, results below belong to the previous query — dimmed,
  // never presented as current.
  const [loadedSearchKey, setLoadedSearchKey] = useState("");
  const searchGateRef = useRef<SearchRequestGate | null>(null);
  const getSearchGate = () => {
    if (!searchGateRef.current) searchGateRef.current = new SearchRequestGate();
    return searchGateRef.current;
  };

  // Pinned chats (migration 054). Per-user, held as a
  // conversation_id -> pinned_at map. `pinBusyIds` tracks in-flight
  // pin/unpin calls so a row can show a spinner and ignore double
  // clicks. Both are pure UI state; the DB is the source of truth.
  const [pinnedAt, setPinnedAt] = useState<Record<string, string>>({});
  const [pinBusyIds, setPinBusyIds] = useState<Set<string>>(new Set());

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);
      const dateRange = getConversationDateRange({
        filter: dateFilter,
        customFrom,
        customTo,
      });
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (dateRange) {
        query = query
          .gte("last_message_at", dateRange.from.toISOString())
          .lte("last_message_at", dateRange.to.toISOString());
      }

      const { data, error } = await query;

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent's manual-refresh button
    // can force a refetch. It no longer bumps on visibilitychange or
    // reconnect (removed for egress — Realtime patching keeps the list
    // consistent), so tab return does not re-download the list.
  }, [resyncToken, dateFilter, customFrom, customTo]);

  // Load the caller's pinned chats. Runs on mount and on manual
  // refresh (resyncToken). No longer re-fetches on tab return or
  // Realtime reconnect — manual refresh is the only resync path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inbox/pins");
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && Array.isArray(data.pins)) {
          setPinnedAt(pinnedAtMapFromRecords(data.pins));
        }
      } catch {
        // Best-effort: a failed pin fetch just renders an unpinned inbox.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Assignment roster — loaded on mount and on manual refresh.
  // Previously re-fetched on every tab return / reconnect (driving egress);
  // now only on explicit manual refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/account/members");
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && Array.isArray(data.members)) {
        setMembers(data.members as AccountMember[]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded on mount and on
  // manual refresh. Narrowed from select("*") to explicit id,name,color
  // to reduce egress.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("id, name, color").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Flow definitions for the filter picker — loaded on mount and on
  // manual refresh (same as tags).
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("flows")
        .select("id, name")
        // Meta Lead Ads virtual flows have no conversations, so they
        // never belong in the inbox conversation flow filter.
        .eq("kind", "whatsapp_flow")
        .order("name");
      if (!cancelled && data) setFlows(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Server-side search: debounced query + every active filter become
  // ONE request per settled state (Contacts-style sequence guard, so
  // a slow "abc" response can never overwrite "abcd"). Clearing the
  // box returns to the untouched normal list.
  const debouncedSearch = useDebouncedValue(search, 280);
  const activeQuery = normalizeSearchQuery(debouncedSearch);
  const searching = activeQuery !== "";
  const searchDateRange = getConversationDateRange({
    filter: dateFilter,
    customFrom,
    customTo,
  });
  const searchKey = searching
    ? buildSearchKey({
        q: activeQuery,
        status: filter,
        tagIds: selectedTagIds,
        company: selectedCompany,
        flowId: selectedFlowId,
        memberIds: selectedMemberIds,
        from: searchDateRange?.from.toISOString() ?? null,
        to: searchDateRange?.to.toISOString() ?? null,
      })
    : "";

  useEffect(() => {
    const gate = getSearchGate();
    if (!searching) {
      gate.invalidate();
      setSearchResults([]);
      setSearchCursor(null);
      setSearchHasMore(false);
      setSearchLoading(false);
      setSearchLoadingMore(false);
      setSearchError(null);
      setLoadedSearchKey("");
      return;
    }
    const token = gate.next();
    const key = searchKey;
    setSearchLoading(true);
    setSearchError(null);    const params = new URLSearchParams({ q: activeQuery, status: filter });
    if (selectedTagIds.length > 0) params.set("tags", selectedTagIds.join(","));
    if (selectedCompany) params.set("company", selectedCompany);
    if (selectedFlowId) params.set("flow", selectedFlowId);
    if (selectedMemberIds.length > 0)
      params.set("members", selectedMemberIds.join(","));
    if (searchDateRange) {
      params.set("from", searchDateRange.from.toISOString());
      params.set("to", searchDateRange.to.toISOString());
    }
    params.set("limit", String(SEARCH_PAGE_SIZE));
    (async () => {
      try {
        const res = await fetch(`/api/inbox/search?${params.toString()}`);
        const json = (await res.json().catch(() => null)) as {
          conversations?: Conversation[];
          has_more?: boolean;
          next_cursor?: string | null;
          error?: string;
        } | null;
        if (!gate.isCurrent(token)) return;
        if (!res.ok || !json || !Array.isArray(json.conversations)) {
          throw new Error(json?.error || "Search failed. Please try again.");
        }
        const merged = mergeSearchPage(
          [],
          {
            key,
            items: json.conversations,
            hasMore: !!json.has_more,
            nextCursor: json.next_cursor ?? null,
          },
          key,
        );
        setSearchResults(merged ?? []);
        setSearchCursor(json.next_cursor ?? null);
        setSearchHasMore(!!json.has_more);
        setLoadedSearchKey(key);
      } catch (err) {
        if (!gate.isCurrent(token)) return;
        setSearchResults([]);
        setSearchCursor(null);
        setSearchHasMore(false);
        setSearchError(
          err instanceof Error ? err.message : "Search failed. Please try again.",
        );
      } finally {
        if (gate.isCurrent(token)) setSearchLoading(false);
      }
    })();
    // `searchKey` already captures every input (query + filters +
    // date range); listing them individually would only risk drift.
    // `searchRetry` forces a refetch of the identical key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, searchKey, resyncToken, searchRetry]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    // Search mode: the server already applied the text match AND every
    // active filter (status/tags/company/flow/team/date). Applying them
    // again client-side would double-filter, so search results go
    // straight to pin partitioning below.
    if (searching) return searchResults;

    let result = conversations;
    const dateRange = getConversationDateRange({
      filter: dateFilter,
      customFrom,
      customTo,
    });

    if (dateRange) {
      result = result.filter((c) =>
        matchesConversationDateFilter(c, dateRange)
      );
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    }

    // Contact-based filters (tags via OR logic, exact company match,
    // flow via the contact's active/most-recent flow run).
    if (
      selectedTagIds.length > 0 ||
      selectedCompany !== null ||
      selectedFlowId != null
    ) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
          flowId: selectedFlowId,
        })
      );
    }

    if (selectedMemberIds.length > 0) {
      result = result.filter((c) =>
        selectedMemberIds.includes(c.assigned_agent_id ?? "unassigned")
      );
    }

    // NOTE: no client-side text search here — all text matching runs
    // server-side (see the search effect above). The old
    // `conversations.filter(...)` only ever saw the loaded window.

    return result;
  }, [
    conversations,
    searching,
    searchResults,
    dateFilter,
    customFrom,
    customTo,
    filter,
    selectedTagIds,
    selectedCompany,
    selectedFlowId,
    selectedMemberIds,
  ]);

  // Split the (already filtered/searched) list into pinned + regular.
  // Partitioning AFTER filtering means the pinned section only shows
  // pins that match the active search/filters, and the regular section
  // keeps the existing last_message_at-desc order untouched.
  const { pinned, regular } = useMemo(
    () => partitionPinnedConversations(filtered, pinnedAt),
    [filtered, pinnedAt]
  );

  // Realtime freshness for search snapshots: merge live scalar fields
  // (preview text, timestamps, unread, status) into visible search
  // rows by id. Never inserts, removes, or reorders — the search set
  // stays exactly what the server returned.
  useEffect(() => {
    if (searchResults.length === 0) return;
    setSearchResults((prev) => {
      if (prev.length === 0) return prev;
      const live = new Map(conversations.map((c) => [c.id, c]));
      let changed = false;
      const next = prev.map((r) => {
        const l = live.get(r.id);
        if (
          !l ||
          (l.last_message_text === r.last_message_text &&
            l.last_message_at === r.last_message_at &&
            l.unread_count === r.unread_count &&
            l.status === r.status)
        ) {
          return r;
        }
        changed = true;
        return {
          ...r,
          last_message_text: l.last_message_text,
          last_message_at: l.last_message_at,
          unread_count: l.unread_count,
          status: l.status,
          contact: l.contact ?? r.contact,
        };
      });
      return changed ? next : prev;
    });
  }, [conversations, searchResults.length]);

  // Next search page. The readiness gate below is load-bearing:
  // Load More may only fire with the cursor of the CURRENTLY LOADED
  // search — never while a new page-1 is in flight and never with a
  // previous search's cursor (which would both kill page-1 via the
  // sequence bump and append wrong-query rows). Guarded responses
  // are still discarded by token + key as a second layer.
  const loadMoreReady = canLoadMoreSearch({
    searching,
    searchLoading,
    loadedSearchKey,
    searchKey,
    searchHasMore,
    searchLoadingMore,
    searchCursor,
  });
  const handleLoadMore = useCallback(() => {
    if (!loadMoreReady) {
      return;
    }
    const gate = getSearchGate();
    const token = gate.next();
    const key = searchKey;
    // loadMoreReady guarantees a cursor, but TS can't see through the
    // helper — narrow explicitly.
    const cursor = searchCursor;
    if (!cursor) return;
    setSearchLoadingMore(true);
    const params = new URLSearchParams({ q: activeQuery, status: filter });
    if (selectedTagIds.length > 0) params.set("tags", selectedTagIds.join(","));
    if (selectedCompany) params.set("company", selectedCompany);
    if (selectedFlowId) params.set("flow", selectedFlowId);
    if (selectedMemberIds.length > 0)
      params.set("members", selectedMemberIds.join(","));
    if (searchDateRange) {
      params.set("from", searchDateRange.from.toISOString());
      params.set("to", searchDateRange.to.toISOString());
    }
    params.set("limit", String(SEARCH_PAGE_SIZE));
    params.set("cursor", cursor);
    (async () => {
      try {
        const res = await fetch(`/api/inbox/search?${params.toString()}`);
        const json = (await res.json().catch(() => null)) as {
          conversations?: Conversation[];
          has_more?: boolean;
          next_cursor?: string | null;
          error?: string;
        } | null;
        if (!gate.isCurrent(token)) return;
        if (!res.ok || !json || !Array.isArray(json.conversations)) {
          throw new Error(json?.error || "Search failed. Please try again.");
        }
        setSearchResults((prev) => {
          const merged = mergeSearchPage(
            prev,
            {
              key,
              items: json.conversations ?? [],
              hasMore: !!json.has_more,
              nextCursor: json.next_cursor ?? null,
            },
            key,
          );
          return merged ?? prev;
        });
        setSearchCursor(json.next_cursor ?? null);
        setSearchHasMore(!!json.has_more);
        setSearchError(null);
      } catch (err) {
        if (!gate.isCurrent(token)) return;
        setSearchError(
          err instanceof Error ? err.message : "Search failed. Please try again.",
        );
      } finally {
        if (gate.isCurrent(token)) setSearchLoadingMore(false);
      }
    })();
    // `searchKey`/`searchCursor` snapshots are captured above; the
    // gate token covers staleness. `loadMoreReady` carries the
    // freshness rule; remaining deps are the live request inputs.
  }, [
    loadMoreReady,
    searchKey,
    searchCursor,
    activeQuery,
    filter,
    selectedTagIds,
    selectedCompany,
    selectedFlowId,
    selectedMemberIds,
    searchDateRange,
  ]);

  const setPinBusy = useCallback((id: string, busy: boolean) => {
    setPinBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleTogglePin = useCallback(
    async (conv: Conversation, nextPinned: boolean) => {
      const id = conv.id;
      if (pinBusyIds.has(id)) return;

      // Client-side cap pre-empt so we don't even fire the request for
      // the 31st pin — the backend enforces this too (source of truth).
      if (
        nextPinned &&
        !isConversationPinned(id, pinnedAt) &&
        !canPinMore(pinnedAt)
      ) {
        toast.error(PIN_LIMIT_TITLE, { description: PIN_LIMIT_DESCRIPTION });
        return;
      }

      // Snapshot the previous pinned_at so an unpin can be rolled back
      // to its exact prior value if the request fails.
      const prevPinnedAtValue = pinnedAt[id];

      // Optimistic flip (functional update so concurrent toggles on
      // other rows don't clobber each other).
      setPinnedAt((prev) =>
        nextPinned
          ? addPin(prev, id, new Date().toISOString())
          : removePin(prev, id)
      );
      setPinBusy(id, true);

      try {
        const res = nextPinned
          ? await fetch("/api/inbox/pins", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversationId: id }),
            })
          : await fetch(`/api/inbox/pins/${id}`, { method: "DELETE" });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          // Roll back the optimistic change.
          setPinnedAt((prev) =>
            nextPinned
              ? removePin(prev, id)
              : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString())
          );
          if (res.status === 409) {
            toast.error(data.error ?? PIN_LIMIT_TITLE, {
              description: data.message ?? PIN_LIMIT_DESCRIPTION,
            });
          } else {
            toast.error("Unable to update pinned chat. Please try again.");
          }
          return;
        }

        toast.success(nextPinned ? "Chat pinned" : "Chat unpinned");
      } catch {
        setPinnedAt((prev) =>
          nextPinned
            ? removePin(prev, id)
            : addPin(prev, id, prevPinnedAtValue ?? new Date().toISOString())
        );
        toast.error("Unable to update pinned chat. Please try again.");
      } finally {
        setPinBusy(id, false);
      }
    },
    [pinBusyIds, pinnedAt, setPinBusy]
  );

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setSelectedFlowId(null);
    setSelectedMemberIds([]);
  }, []);

  const toggleMember = useCallback((id: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(id)
        ? prev.filter((memberId) => memberId !== id)
        : [...prev, id]
    );
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    selectedFlowId != null ||
    selectedMemberIds.length > 0;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleDateFilterSelect = useCallback(
    (next: ConversationDateFilter) => {
      if (next === "custom") {
        setDateFilter("custom");
        setDraftCustomFrom(customFrom);
        setDraftCustomTo(customTo);
        setCustomDateOpen(true);
        return;
      }

      setDateFilter(next);
      setCustomDateOpen(false);
      if (next === "all") {
        setCustomFrom("");
        setCustomTo("");
        setDraftCustomFrom("");
        setDraftCustomTo("");
      }
    },
    [customFrom, customTo]
  );

  const applyCustomDateFilter = useCallback(() => {
    if (!draftCustomFrom || !draftCustomTo) return;
    setDateFilter("custom");
    setCustomFrom(draftCustomFrom);
    setCustomTo(draftCustomTo);
    setCustomDateOpen(false);
  }, [draftCustomFrom, draftCustomTo]);

  const clearDateFilter = useCallback(() => {
    setDateFilter("all");
    setCustomFrom("");
    setCustomTo("");
    setDraftCustomFrom("");
    setDraftCustomTo("");
    setCustomDateOpen(false);
  }, []);

  const handleSelect = useCallback(
    (conv: Conversation) => {
      // Mirror the parent's optimistic unread reset inside search
      // snapshots so the opened row clears immediately there too.
      setSearchResults((prev) =>
        prev.some((c) => c.id === conv.id && c.unread_count > 0)
          ? prev.map((c) =>
              c.id === conv.id ? { ...c, unread_count: 0 } : c,
            )
          : prev,
      );
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);
  const activeFlow = flows.find((f) => f.id === selectedFlowId);
  const activeFlowName =
    selectedFlowId === NO_FLOW_FILTER_ID
      ? "No flow"
      : (activeFlow?.name ?? "Flow");
  const activeDateFilter = DATE_FILTER_OPTIONS.find(
    (o) => o.value === dateFilter
  );
  const activeDateRange = getConversationDateRange({
    filter: dateFilter,
    customFrom,
    customTo,
  });
  const hasDateFilter = activeDateRange !== null;
  const customDateReady = draftCustomFrom !== "" && draftCustomTo !== "";

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full min-w-0 flex-col border-r">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations..."
            className={cn(
              "border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm",
              search !== "" && "pr-9"
            )}
          />
          {search !== "" && !searchLoading && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
              className="text-muted-foreground absolute top-1/2 right-3 -translate-y-1/2 rounded transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {searchLoading && (
            <span
              aria-label="Searching..."
              className="absolute top-1/2 right-3 -translate-y-1/2"
            >
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? "All"}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center gap-1">
            <Popover open={customDateOpen} onOpenChange={setCustomDateOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-7 max-w-36 gap-1 px-2 text-xs",
                      hasDateFilter
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  />
                }
              >
                <span className="truncate">
                  Date
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 gap-2 p-2">
                <p className="text-muted-foreground px-2 pt-1 text-xs font-medium">
                  Date
                </p>
                <div className="grid gap-1">
                  {DATE_FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleDateFilterSelect(opt.value)}
                      className={cn(
                        "hover:bg-muted rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        dateFilter === opt.value
                          ? "text-primary"
                          : "text-popover-foreground"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {dateFilter === "custom" && (
                  <div className="border-border space-y-2 border-t pt-2">
                    <div className="space-y-1">
                      <label className="text-foreground text-xs font-medium">
                        From Date
                      </label>
                      <Input
                        type="date"
                        value={draftCustomFrom}
                        onChange={(e) => setDraftCustomFrom(e.target.value)}
                        className="border-border bg-muted h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-foreground text-xs font-medium">
                        To Date
                      </label>
                      <Input
                        type="date"
                        value={draftCustomTo}
                        onChange={(e) => setDraftCustomTo(e.target.value)}
                        className="border-border bg-muted h-8 text-sm"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearDateFilter}
                        className="text-muted-foreground"
                      >
                        Clear
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={applyCustomDateFilter}
                        disabled={!customDateReady}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Company"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All companies
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {flows.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedFlowId
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Workflow className="h-3 w-3" />
                <span className="max-w-24 truncate">
                  {activeFlowName}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedFlowId(null)}
                  className={cn(
                    "text-sm",
                    selectedFlowId === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All flows
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFlowId(NO_FLOW_FILTER_ID)}
                  className={cn(
                    "text-sm",
                    selectedFlowId === NO_FLOW_FILTER_ID
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  No flow
                </DropdownMenuItem>
                {flows.map((flow) => (
                  <DropdownMenuItem
                    key={flow.id}
                    onClick={() => setSelectedFlowId(flow.id)}
                    className={cn(
                      "text-sm",
                      selectedFlowId === flow.id
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{flow.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {members.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedMemberIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Users className="h-3 w-3" />
                Team
                {selectedMemberIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedMemberIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuCheckboxItem
                  checked={selectedMemberIds.includes("unassigned")}
                  onCheckedChange={() => toggleMember("unassigned")}
                  className="text-popover-foreground text-sm"
                >
                  Unassigned
                </DropdownMenuCheckboxItem>
                {members.map((member) => (
                  <DropdownMenuCheckboxItem
                    key={member.user_id}
                    checked={selectedMemberIds.includes(member.user_id)}
                    onCheckedChange={() => toggleMember(member.user_id)}
                    className="text-popover-foreground text-sm"
                  >
                    {member.full_name || "Unnamed member"}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? "var(--muted-foreground)",
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? "Tag"}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedFlowId && (
              <button
                onClick={() => setSelectedFlowId(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <Workflow className="h-3 w-3 shrink-0" />
                <span className="max-w-24 truncate">
                  {activeFlowName}
                </span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedMemberIds.map((id) => {
              const member = members.find((item) => item.user_id === id);
              return (
                <button
                  key={id}
                  onClick={() => toggleMember(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span className="max-w-24 truncate">
                    {id === "unassigned"
                      ? "Unassigned"
                      : member?.full_name || "Team member"}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              Clear all
            </button>
          </div>
        )}
        {hasDateFilter && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={clearDateFilter}
              className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
            >
              <span className="max-w-40 truncate">
                {dateFilter === "custom" && customFrom && customTo
                  ? `${customFrom} to ${customTo}`
                  : activeDateFilter?.label ?? "Date filter"}
              </span>
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading || (searching && searchLoading && filtered.length === 0) ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {searching
                ? searchError ??
                  `No conversations found for "${activeQuery}"`
                : hasDateFilter
                  ? "No chats found for this date."
                  : "No conversations found"}
            </p>
            {!searching && hasDateFilter && (
              <button
                type="button"
                onClick={clearDateFilter}
                className="text-primary mt-2 text-xs hover:underline"
              >
                Clear date filter
              </button>
            )}
            {searching && searchError && (
              <button
                type="button"
                onClick={() => setSearchRetry((n) => n + 1)}
                className="text-primary mt-2 text-xs hover:underline"
              >
                Retry search
              </button>
            )}
          </div>
        ) : (
          <div
            className={
              searching && searchLoading && loadedSearchKey !== searchKey
                ? "flex flex-col opacity-50 transition-opacity"
                : "flex flex-col"
            }
          >
            {/* Pinned chats float to the top (only those matching the
                current search/filters). No section labels — a thin
                divider separates them from the rest, WhatsApp-style. */}
            {pinned.length > 0 && (
              <>
                {pinned.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === activeConversationId}
                    onSelect={handleSelect}
                    isPinned
                    isPinBusy={pinBusyIds.has(conv.id)}
                    onTogglePin={handleTogglePin}
                  />
                ))}
                {regular.length > 0 && (
                  <div className="border-border border-b" aria-hidden="true" />
                )}
              </>
            )}

            {regular.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                isPinned={false}
                isPinBusy={pinBusyIds.has(conv.id)}
                onTogglePin={handleTogglePin}
              />
            ))}

            {/* Search pagination — normal list stays unbounded as
                before; only search pages (25 at a time). The button
                stays disabled until the current search's page-1 has
                fully loaded, so a previous search's cursor can never
                be reused. */}
            {searching && searchHasMore && (
              <div className="flex justify-center px-3 py-3">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={!loadMoreReady}
                  className="text-primary inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70"
                >
                  {searchLoadingMore && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {searchLoadingMore
                    ? "Loading more…"
                    : `Load more (${filtered.length} shown)`}
                </button>
              </div>
            )}
            {searching && searchError && filtered.length > 0 && (
              <div className="px-4 py-3 text-center">
                <p className="text-muted-foreground text-xs">{searchError}</p>
                <button
                  type="button"
                  onClick={() => setSearchRetry((n) => n + 1)}
                  className="text-primary mt-1 text-xs hover:underline"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  isPinned: boolean;
  isPinBusy: boolean;
  onTogglePin: (conversation: Conversation, nextPinned: boolean) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  isPinned,
  isPinBusy,
  onTogglePin,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // The row is a div (not a button) so it can host the pin/menu controls
  // — nesting buttons inside a button is invalid HTML. Re-implement the
  // keyboard affordance a button gave us for free.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(conversation);
      }
    },
    [onSelect, conversation]
  );

  const handlePinClick = useCallback(() => {
    onTogglePin(conversation, !isPinned);
  }, [onTogglePin, conversation, isPinned]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  // `contact.tags` is already hydrated Tag[] by CONVERSATION_SELECT's
  // `contact_tags(tags(*))` embed — no id lookup needed here, unlike
  // the filter-bar chips which start from raw selectedTagIds.
  const contactTags = contact?.tags ?? [];

  const pinTooltip = isPinned ? "Unpin chat" : "Pin chat";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={displayName}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group hover:bg-muted/50 focus-visible:bg-muted/60 relative flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors focus:outline-none",
        isActive && "border-primary bg-muted/70 border-l-2"
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 pr-4 text-xs whitespace-nowrap">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}

            {/* Pin toggle — WhatsApp-style: a filled pin sits in the
                bottom-right of pinned chats; for unpinned chats it stays
                hidden and reveals on hover/focus. Clicking it toggles the
                pin without selecting the row. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePinClick();
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    disabled={isPinBusy}
                    aria-label={pinTooltip}
                    aria-pressed={isPinned}
                    className={cn(
                      "text-muted-foreground hover:bg-muted flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-60",
                      // Pinned: always shown (filled). Unpinned: always
                      // tappable on touch (no hover there), but only
                      // hover/focus-revealed on desktop to keep the list clean.
                      isPinned
                        ? "opacity-100"
                        : "opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 lg:opacity-0"
                    )}
                  >
                    {isPinBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pin
                        className={cn(
                          "h-3.5 w-3.5",
                          isPinned && "fill-current"
                        )}
                      />
                    )}
                  </button>
                }
              />
              <TooltipContent>{pinTooltip}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Tag pill(s) — only rendered when the contact has at least one
            tag. Matches the screenshot: a small rounded label sitting
            below the last-message line. */}
        {contactTags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {contactTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `${tag.color}26`, // ~15% tint of the tag color
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
