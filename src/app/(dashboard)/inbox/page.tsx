"use client";

import { useState, useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  hasNewerConversationActivity,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import type { Conversation, Message, Contact } from "@/types";
import { isForwardMessageStatus } from "@/lib/whatsapp/message-status";
import {
  getHiddenConversationIds,
  isHidden,
} from "@/lib/inbox/hidden";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { canViewConversation, NO_INBOX_CAPS, type InboxViewerCaps } from "@/lib/inbox/assignment-access";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { toast } from "sonner";
import { WifiOff , X} from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "interscale:inbox:contact-panel-open";

const SIDEBAR_WIDTH_KEY = "interscale:inbox:sidebar-width";
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 320;

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, accountRole } = useAuth();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  /**
   * Bumped only when the user explicitly requests a refresh via the
   * thread-header refresh button (handleManualRefresh). The initial
   * mount fetches and Realtime patches keep the Inbox live; tab
   * visibility and Realtime reconnect no longer bump this token
   * (removed for egress — see effects below).
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [isDesktop, setIsDesktop] = useState(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (stored) {
        const w = parseInt(stored, 10);
        if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) setSidebarWidth(w);
      }
    } catch {}
  }, []);

  const handleResizePointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: globalThis.PointerEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + delta));
      setSidebarWidth(next);
    };

    const onUp = () => {
      isDraggingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setSidebarWidth((w) => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch {}
        return w;
      });
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [sidebarWidth]);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  // Assignment-scoped visibility for this viewer. Owners/admins see
  // every thread; agents see only their own assigned threads (never
  // unassigned ones) unless granted View All; viewers keep legacy
  // read-all. Mirrors the RLS policy in 148_inbox_assignment_access.sql
  // (+ the 149 view_all branch) — realtime payloads and hydrate
  // results are filtered through this before entering state, so a
  // revoked thread can never linger on screen. Caps come from the
  // server (/me); the empty default denies everything extra.
  // The viewer's granted Inbox permissions (View All / Manage
  // Assignments). Fetched once here (re-fetched on manual resync and
  // on any assignment-affecting realtime signal via the resync they
  // trigger) and handed to the list for Team gating, the Assign
  // entry point, and the Form-filter lookups below. Defaults deny.
  const [viewerCaps, setViewerCaps] = useState<InboxViewerCaps>(NO_INBOX_CAPS);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/agent-permissions/me", {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => null)) as {
          can_view_all?: boolean;
          can_manage_assignments?: boolean;
        } | null;
        if (!cancelled && res.ok && data) {
          setViewerCaps({
            canViewAll: data.can_view_all === true,
            canManageAssignments: data.can_manage_assignments === true,
          });
        }
      } catch {
        // Fail closed (deny extra access); RLS still enforces server-side.
        if (!cancelled) setViewerCaps(NO_INBOX_CAPS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);
  const viewer = useMemo(
    () => ({ role: accountRole, userId: user?.id ?? null }),
    [accountRole, user?.id]
  );
  const isVisibleConv = useCallback(
    (c: { assigned_agent_id?: string | null } | null | undefined) =>
      !!c && canViewConversation(viewer, c?.assigned_agent_id ?? null, viewerCaps),
    [viewer, viewerCaps]
  );

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Tenant-scoped hidden threads (Inbox display rule only — see
  // lib/inbox/hidden). Loaded once on mount; realtime INSERTs and
  // hydrates consult the ref so hidden threads never enter state.
  const hiddenConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ids = await getHiddenConversationIds(createClient());
        if (!cancelled) hiddenConvIdsRef.current = ids;
      } catch {
        // Best-effort: a failed fetch renders a normal inbox.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Moves a conversation to the front of the list while patching its
  // fields — realtime UPDATE/message events must bubble the touched
  // conversation back to the top of the list, same as a brand-new
  // conversation does when it's prepended on INSERT. Without this, the
  // list order stays frozen at whatever it was on initial load, since
  // `.map()` (the previous approach) preserves array position.
  function bubbleToTop<T extends { id: string }>(
    list: T[],
    id: string,
    updater: (item: T) => T,
  ): T[] {
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) return list;
    const updated = updater(list[idx]);
    const rest = list.filter((c) => c.id !== id);
    return [updated, ...rest];
  }

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    // Hidden threads (deep links included) never enter Inbox state.
    if (isHidden(hiddenConvIdsRef.current, convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", convId)
        .maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) return;
      const fetched = normalizeConversation(data);
      // Assignment gate (defense in depth — RLS already filters, but a
      // revoked thread must never re-enter through a stale event).
      if (!isVisibleConv(fetched)) return;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? { ...c, contact: c.contact ?? fetched.contact }
              : c,
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, [isVisibleConv]);

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;

      if (!user) return;

      // whatsapp_config is one-row-per-account post-multi-user, so
      // the previous `.eq('user_id', user.id)` would miss the row
      // for any teammate who didn't personally save the config —
      // the "WhatsApp not connected" banner would show in the
      // shared inbox even though the admin had it configured.
      // Resolve account_id via the profile and query by that.
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
    };

    checkConnection();
  }, []);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        // Add to messages if it belongs to active conversation
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Replace optimistic message if it exists
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("temp-")
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Update conversation list preview. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            bubbleToTop(prev, newMsg.conversation_id, (c) => ({
              ...c,
              last_message_text: newMsg.content_text ?? "",
              last_message_at: newMsg.created_at,
              unread_count:
                activeConversation?.id === newMsg.conversation_id
                  ? 0
                  : c.unread_count + 1,
            })),
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        // Update message status — forward-only: a late or duplicate
        // realtime event (e.g. `delivered` arriving after `read`)
        // must never regress a Seen bubble back to Unseen. Other
        // fields still merge unconditionally.
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== newMsg.id) return m;
            if (!isForwardMessageStatus(m.status, newMsg.status)) return m;
            return { ...m, ...newMsg };
          })
        );
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        // Hidden threads never enter state (see hiddenConvIdsRef).
        // Assignment gate: an INSERT the viewer may not see (RLS
        // usually suppresses it first) is dropped, never rendered.
        if (isHidden(hiddenConvIdsRef.current, conv.id)) return;
        if (!isVisibleConv(conv)) return;
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conv.id)) {
          // Assignment gate FIRST: if this update revoked the viewer's
          // access (reassigned away, or unassigned for an agent), drop
          // the row instead of patching it — RLS usually suppresses
          // the event itself, but a racing payload must never linger.
          if (!isVisibleConv(conv)) {
            setConversations((prev) => prev.filter((c) => c.id !== conv.id));
            if (activeConversation?.id === conv.id) {
              setActiveConversation(null);
              setActiveContact(null);
              setMessages([]);
              router.replace("/inbox", { scroll: false });
              toast.info("This conversation is no longer assigned to you.");
            }
            return;
          }
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          // Only genuine new activity (a strictly newer last_message_at)
          // bubbles the row to the top — the list sorts by
          // last_message_at desc. Read-state updates (unread_count → 0
          // when opening a chat), status/assignment changes, and the
          // incidental `updated_at` bump from the set_updated_at trigger
          // carry the same last_message_at and must patch in place,
          // otherwise opening an unread chat jumps it to position 1.
          setConversations((prev) => {
            const existing = prev.find((c) => c.id === conv.id);
            const patch = (c: Conversation): Conversation => ({
              ...c,
              ...conv,
              contact: conv.contact ?? c.contact,
              unread_count: isActive ? 0 : conv.unread_count,
            });
            if (
              existing &&
              hasNewerConversationActivity(existing, conv)
            ) {
              return bubbleToTop(prev, conv.id, patch);
            }
            return prev.map((c) => (c.id === conv.id ? patch(c) : c));
          });
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) =>
            prev ? { ...prev, ...conv } : prev
          );
        }
      }
    },
    [activeConversation, hydrateConversation, isVisibleConv, router]
  );

  // Re-checks the open thread against current visibility (RLS +
  // granted permissions). Used after any signal that may have moved
  // access: workspace_values writes (assignment changes whose
  // conversations UPDATE is RLS-suppressed for the loser) and
  // agent_inbox_permissions writes (grant/revocation of View All or
  // Manage Assignments). On invisibility the thread is closed with
  // notice; the parallel resyncToken bump re-fetches the list under
  // RLS so revoked rows vanish and granted rows appear.
  const reverifyActiveThread = useCallback(() => {
    const activeId = activeConversation?.id;
    if (!activeId) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .select("id, assigned_agent_id")
      .eq("id", activeId)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { assigned_agent_id: string | null } | null;
        const assigned = row?.assigned_agent_id ?? null;
        if (
          !row ||
          !canViewConversation(
            { role: accountRole, userId: user?.id ?? null },
            assigned,
            viewerCaps
          )
        ) {
          setActiveConversation(null);
          setActiveContact(null);
          setMessages([]);
          setConversations((prev) => prev.filter((c) => c.id !== activeId));
          router.replace("/inbox", { scroll: false });
          toast.info("This conversation is no longer assigned to you.");
        }
      });
  }, [activeConversation?.id, accountRole, user?.id, viewerCaps, router]);

  // Subscribe to realtime. `isConnected` is tracked below for the
  // offline indicator only — reconnect no longer triggers a full
  // resync (removed for egress). Realtime patches via
  // handleMessageEvent/handleConversationEvent keep the Inbox live.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    // Assignment changes land as workspace_values writes (both
    // Workspace- and Inbox-initiated). The conversations UPDATE that
    // mirrors them is RLS-suppressed for viewers who just lost
    // access, so without this the revoked thread would linger until
    // a refresh. Converge deterministically: resync the list (RLS
    // reapplies) and re-check the open thread right now.
    onWorkspaceValuesEvent: () => {
      setResyncToken((n) => n + 1);
      reverifyActiveThread();
    },
    enabled: true,
  });

  // Permission changes land in agent_inbox_permissions (grant AND
  // revoke). The viewer can always read their own row (RLS), so this
  // fires for them personally. Converge immediately: re-pull caps
  // (via the resyncToken-keyed fetch above), re-fetch the list under
  // the new RLS truth, and re-check the open thread — no logout or
  // manual refresh required in either direction.
  useEffect(() => {
    if (!user?.id) return;
    const supabase = createClient();
    const channel = supabase
      .channel("inbox-permissions")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_inbox_permissions",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          setResyncToken((n) => n + 1);
          reverifyActiveThread();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, reverifyActiveThread]);

  // Realtime connection tracking — no automatic full refetch.
  // Previously we bumped `resyncToken` on both WS reconnect and
  // visibilitychange → visible, which caused a full conversation-list
  // + 500-message + pins/members/tags/flows refetch on every tab return
  // (the confirmed 3 GB egress root cause). That behavior is removed.
  // Normal Realtime INSERT/UPDATE/DELETE patches local state via
  // handleMessageEvent/handleConversationEvent + hydrateConversation.
  // Only an explicit user action (the refresh button) now bumps
  // resyncToken. We keep the refs to track connection state for the
  // offline indicator if needed, but do not trigger a full refetch.
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (!initialConnectDoneRef.current) {
        initialConnectDoneRef.current = true;
      }
      // Intentionally NOT bumping resyncToken on reconnect.
      // Full-list + full-history refetches are handled only by
      // handleManualRefresh (user-initiated). Realtime patching
      // keeps the list consistent; missed events during a brief
      // disconnect converge on the next Realtime event or manual refresh.
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  // visibilitychange → visible no longer triggers a full refetch.
  // The previous unconditional setResyncToken(n+1) on every tab return
  // downloaded the entire conversation list (heavy CONVERSATION_SELECT)
  // and the active thread's 500 messages again, even when nothing
  // changed, driving Postgres egress. Removed for egress reduction.
  // Inbox correctness is preserved via Realtime patches.

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      // Resolve a pending deep-link here rather than in an effect — this
      // is an event handler, so the setState calls below are allowed by
      // react-hooks/set-state-in-effect. Runs once per ?c=<id> URL value
      // via the ref, so realtime refreshes of the list can't snap the
      // user back to the deep-linked thread after they've navigated.
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        // If the deep-linked conversation is already the active one
        // (e.g. because the user clicked it in the list and we
        // router.replace()'d the URL, which made the ConversationList
        // refetch and land us back here), do NOT re-apply it. Doing so
        // would setMessages([]) on a thread whose messages have
        // already been loaded by MessageThread — and because
        // conversationId didn't change, MessageThread wouldn't
        // refetch. The thread would read "No messages yet" until a
        // full page reload rehydrated state from scratch.
        if (activeConversation?.id === deepLinkConvId) return;
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);
          // Mirror the optimistic unread reset that handleSelectConversation
          // does — the user just deep-linked into this conv, treat that the
          // same as a click. Leaves activeConversation.unread_count alone so
          // the MessageThread reset effect still fires the server UPDATE.
          if (match.unread_count > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === match.id ? { ...c, unread_count: 0 } : c,
              ),
            );
          }
        }
      }
    },
    [deepLinkConvId, activeConversation?.id]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // messages array, but the fetch effect in MessageThread only re-runs
      // when conversationId changes — so messages would stay empty until
      // the user navigated away and back. Bail out early instead.
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      // Optimistically clear the unread badge for this conv. The
      // server-side reset is fired by the unread-reset effect inside
      // MessageThread (which reads activeConversation.unread_count, not
      // the list copy — so we deliberately leave that intact below to
      // keep the effect firing), and the realtime UPDATE that comes
      // back will sync to 0 again as a no-op. Zeroing the list copy
      // here means the user sees the badge disappear the instant they
      // click instead of waiting for the round-trip — and it persists
      // even if the realtime UPDATE is dropped.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0
            ? { ...c, unread_count: 0 }
            : c,
        ),
      );
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      router.replace(`/inbox?c=${conv.id}`, { scroll: false });
    },
    [activeConversation?.id, router]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/inbox", { scroll: false });
  }, [router]);


  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
      // Assignment gate: an agent who just unassigned (or reassigned
      // away) their own thread must lose it immediately — the RLS
      // policy already hides it from refetches, so drop it from state
      // too instead of waiting for a refresh. Owners/admins — and
      // agents holding View All — always keep full visibility.
      if (
        !canViewConversation(
          { role: accountRole, userId: user?.id ?? null },
          assignedAgentId,
          viewerCaps
        )
      ) {
        setConversations((prev) =>
          prev.filter((c) => c.id !== conversationId)
        );
        if (activeConversation?.id === conversationId) {
          setActiveConversation(null);
          setActiveContact(null);
          setMessages([]);
          router.replace("/inbox", { scroll: false });
          toast.info("This conversation is no longer assigned to you.");
        }
      }
    },
    [activeConversation, accountRole, user?.id, viewerCaps, router]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">
            WhatsApp® is not connected. Go to Settings to connect your account.
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
          style={isDesktop ? { width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX } : undefined}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            onAssignChange={handleAssignChange}
            viewerCaps={viewerCaps}
          />
        </div>

        {/* Resize handle between conversation list and message thread */}
        <div
          onPointerDown={handleResizePointerDown}
          className="hidden lg:flex h-full w-1 cursor-col-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors"
        >
          <div className="h-8 w-0.5 rounded-full bg-border" />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, only when a
            conversation is selected AND the agent hasn't collapsed it
            via the thread-header toggle (#258). Deriving from
            `hasActiveConv` (not CSS-hiding) means no width is reserved
            when nothing is selected and the empty state expands.
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
      {contactPanelOpen && hasActiveConv && (
  <>
    {/* Desktop: permanent side column */}
    <div className="hidden lg:block">
      <ContactSidebar
        contact={activeContact}
        onTagsChanged={handleManualRefresh}
      />
    </div>

    {/* Mobile: slide-over drawer with backdrop. Only makes sense
        when a conversation is open, which is implicitly true here
        since the toggle button only renders inside an active
        MessageThread. */}
    <div className="fixed inset-0 z-50 flex lg:hidden">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={handleToggleContactPanel}
        aria-hidden="true"
      />
      <div className="relative ml-auto flex h-full w-full max-w-xs flex-col bg-card shadow-xl sm:max-w-sm">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">
            Contact details
          </h3>
          <button
            type="button"
            onClick={handleToggleContactPanel}
            aria-label="Close contact panel"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ContactSidebar
          contact={activeContact}
          onTagsChanged={handleManualRefresh}
          className="w-full flex-1 border-l-0"
        />
      </div>
    </div>
  </>
)}
      </div>
    </div>
  );
}