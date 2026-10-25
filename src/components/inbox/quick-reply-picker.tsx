"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Star,
  Clock,
  Search,
  X,
  MessageSquareText,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  Sticker,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types";
import type { QuickReplyMessageType } from "@/lib/quick-replies/media-validation";

// ── Types ──────────────────────────────────────────────────────────────

export type QuickReplyMedia = {
  media_url: string | null;
  media_path: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_file_size: number | null;
  media_caption: string | null;
};

export interface QuickReply {
  id: string;
  account_id: string;
  created_by: string;
  title: string;
  shortcut: string;
  message: string;
  category: string;
  visibility: "personal" | "shared";
  is_favorite: boolean;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  message_type: QuickReplyMessageType;
  media_url: string | null;
  media_path: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_file_size: number | null;
  media_caption: string | null;
  whatsapp_media_id: string | null;
}

export interface QuickReplyPickerHandle {
  handleKey: (key: string) => void;
}

export interface QuickReplySelection {
  kind: QuickReplyMessageType;
  text: string; // for text: substituted message; for media: caption
  mediaUrl?: string | null;
  filename?: string | null;
  reply: QuickReply;
}

interface QuickReplyPickerProps {
  contact: Contact | null;
  agentName: string | null;
  onSelect: (selection: QuickReplySelection) => void;
  /** Legacy text-only callers: still supported */
  onSelectText?: (text: string) => void;
  /** Inline slash-command mode: position above the input. */
  mode: "modal" | "inline";
  /** For inline mode: the current slash query (e.g. "greet" from "/greet"). */
  slashQuery?: string;
  onClose: () => void;
  open: boolean;
}

// ── Variable substitution ──────────────────────────────────────────────

function substituteVariables(
  message: string,
  contact: Contact | null,
  agentName: string | null,
): string {
  const vars: Record<string, string> = {
    name: contact?.name || "",
    phone: contact?.phone || "",
    email: contact?.email || "",
    company: contact?.company || "",
    city: "",
    agent_name: agentName || "",
  };
  return message.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const val = vars[key.toLowerCase()];
    return val !== undefined ? val : match;
  });
}

export function quickReplyCaption(reply: QuickReply, contact: Contact | null, agentName: string | null): string {
  const raw = reply.media_caption ?? reply.message ?? "";
  return substituteVariables(raw, contact, agentName);
}

// ── Icons ──────────────────────────────────────────────────────────────

export function QuickReplyTypeIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case "image":
      return <ImageIcon className={cn("h-3.5 w-3.5", className)} />;
    case "video":
      return <Video className={cn("h-3.5 w-3.5", className)} />;
    case "audio":
      return <Music className={cn("h-3.5 w-3.5", className)} />;
    case "document":
      return <FileText className={cn("h-3.5 w-3.5", className)} />;
    case "sticker":
      return <Sticker className={cn("h-3.5 w-3.5", className)} />;
    default:
      return <MessageSquareText className={cn("h-3.5 w-3.5", className)} />;
  }
}

function typeLabel(reply: QuickReply): string {
  const t = (reply.message_type || "text") as QuickReplyMessageType;
  if (t === "text") return "Text";
  if (t === "image") return "Image";
  if (t === "video") return "Video";
  if (t === "audio") return "Audio";
  if (t === "document") return reply.media_file_name?.split(".").pop()?.toUpperCase() || "Document";
  if (t === "sticker") return "Sticker";
  return t;
}

function previewSnippet(reply: QuickReply, contact: Contact | null, agentName: string | null): string {
  const mt = (reply.message_type || "text") as QuickReplyMessageType;
  if (mt === "text") return substituteVariables(reply.message || "", contact, agentName).slice(0, 80);
  if (mt === "image" || mt === "video" || mt === "document") {
    const cap = quickReplyCaption(reply, contact, agentName);
    if (cap) return cap.slice(0, 80);
    return reply.media_file_name || reply.media_url || "";
  }
  if (mt === "audio") return reply.media_file_name || "Audio";
  if (mt === "sticker") return reply.media_file_name || "Sticker";
  return "";
}

// ── Recently-used storage ──────────────────────────────────────────────

const RECENT_KEY = "interscale:quick-reply:recent";
const MAX_RECENT = 15;

function getRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function pushRecentId(id: string) {
  const ids = getRecentIds().filter((x) => x !== id);
  ids.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
}

// ── Component ──────────────────────────────────────────────────────────

export const QuickReplyPicker = forwardRef<
  QuickReplyPickerHandle,
  QuickReplyPickerProps
>(function QuickReplyPicker(
  { contact, agentName, onSelect, onSelectText, mode, slashQuery, onClose, open },
  ref,
) {
  const { accountId } = useAuth();
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch all quick replies for this account
  const fetchReplies = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("quick_replies")
      .select("*")
      .eq("account_id", accountId)
      .order("title");
    // Backward compat: ensure message_type defaults to text
    const normalized = ((data as QuickReply[]) || []).map((r) => ({
      ...r,
      message_type: (r.message_type as QuickReplyMessageType) || "text",
    }));
    setReplies(normalized);
    setLoading(false);
  }, [accountId]);

  // Reset-on-open is intentional UI state choreography (open the
  // picker fresh each time). Kept as-is; restructuring risks
  // changing visible picker behaviour.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset, see above */
  useEffect(() => {
    if (open) {
      fetchReplies();
      setSearch("");
      setActiveCategory(null);
      setActiveIdx(0);
    }
  }, [open, fetchReplies]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Focus search input when modal opens
  useEffect(() => {
    if (open && mode === "modal") {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, mode]);

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set<string>();
    replies.forEach((r) => {
      if (r.category) cats.add(r.category);
    });
    return Array.from(cats).sort();
  }, [replies]);

  // Get recent IDs
  const recentIds = useMemo(() => (open ? getRecentIds() : []), [open]);

  // Filter and sort
  const filtered = useMemo(() => {
    const q = (mode === "inline" ? slashQuery : search)?.toLowerCase().trim() || "";

    let list = replies;

    // Category filter
    if (activeCategory) {
      list = list.filter((r) => r.category === activeCategory);
    }

    // Search filter
    if (q) {
      list = list.filter(
        (r) =>
          r.shortcut.toLowerCase().includes(q) ||
          r.title.toLowerCase().includes(q) ||
          r.message.toLowerCase().includes(q) ||
          (r.media_caption && r.media_caption.toLowerCase().includes(q)) ||
          (r.media_file_name && r.media_file_name.toLowerCase().includes(q)) ||
          r.category.toLowerCase().includes(q),
      );
    }

    // Sort: favorites first, then shortcut match > title match > rest
    return [...list].sort((a, b) => {
      if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
      if (q) {
        const aShortcut = a.shortcut.toLowerCase().startsWith(q);
        const bShortcut = b.shortcut.toLowerCase().startsWith(q);
        if (aShortcut !== bShortcut) return aShortcut ? -1 : 1;
        const aTitle = a.title.toLowerCase().startsWith(q);
        const bTitle = b.title.toLowerCase().startsWith(q);
        if (aTitle !== bTitle) return aTitle ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
  }, [replies, search, slashQuery, mode, activeCategory]);

  // Recent items (only shown when no search query)
  const recentItems = useMemo(() => {
    const q = (mode === "inline" ? slashQuery : search)?.trim() || "";
    if (q || activeCategory) return [];
    return recentIds
      .map((id) => replies.find((r) => r.id === id))
      .filter(Boolean) as QuickReply[];
  }, [replies, recentIds, search, slashQuery, mode, activeCategory]);

  // All display items: recent section + main list
  const displayItems = useMemo(() => {
    const items: { reply: QuickReply; section?: string }[] = [];
    if (recentItems.length > 0) {
      recentItems.forEach((r, i) =>
        items.push({ reply: r, section: i === 0 ? "Recently Used" : undefined }),
      );
    }
    const recentSet = new Set(recentItems.map((r) => r.id));
    const main = filtered.filter((r) => !recentSet.has(r.id));
    if (main.length > 0) {
      const label =
        recentItems.length > 0 ? "All Quick Replies" : undefined;
      main.forEach((r, i) =>
        items.push({ reply: r, section: i === 0 ? label : undefined }),
      );
    }
    return items;
  }, [filtered, recentItems]);

  // Reset active index on filter change
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset, see above */
  useEffect(() => {
    setActiveIdx(0);
  }, [search, slashQuery, activeCategory]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Handle selection — supports both media and text
  const handleSelect = useCallback(
    (reply: QuickReply) => {
      const mt = (reply.message_type || "text") as QuickReplyMessageType;
      const text = mt === "text"
        ? substituteVariables(reply.message || "", contact, agentName)
        : quickReplyCaption(reply, contact, agentName);
      const selection: QuickReplySelection = {
        kind: mt,
        text,
        mediaUrl: reply.media_url,
        filename: reply.media_file_name,
        reply,
      };
      // Preserve legacy contract: if caller still expects string, also call onSelectText
      if (onSelectText && mt === "text") onSelectText(text);
      // New contract: always call onSelect with structured selection
      (onSelect as unknown as (s: QuickReplySelection | string) => void)(
        selection as unknown as QuickReplySelection,
      );
      pushRecentId(reply.id);

      // Bump use_count and last_used_at in the background
      const supabase = createClient();
      void supabase
        .from("quick_replies")
        .update({
          use_count: reply.use_count + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", reply.id)
        .then();

      onClose();
    },
    [contact, agentName, onSelect, onSelectText, onClose],
  );

  // Expose imperative handle for parent to forward keyboard events
  useImperativeHandle(
    ref,
    () => ({
      handleKey: (key: string) => {
        if (key === "ArrowDown") {
          setActiveIdx((i) => Math.min(i + 1, displayItems.length - 1));
        } else if (key === "ArrowUp") {
          setActiveIdx((i) => Math.max(i - 1, 0));
        } else if (key === "Enter") {
          const item = displayItems[activeIdx];
          if (item) handleSelect(item.reply);
        } else if (key === "Escape") {
          onClose();
        }
      },
    }),
    [displayItems, activeIdx, handleSelect, onClose],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, displayItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = displayItems[activeIdx];
        if (item) handleSelect(item.reply);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [displayItems, activeIdx, handleSelect, onClose],
  );

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  // ── Inline mode (slash command dropdown) ─────────────────────────────
  if (mode === "inline") {
    return (
      <div
        className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
        onKeyDown={handleKeyDown}
      >
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : displayItems.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No quick replies found
          </div>
        ) : (
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {displayItems.map(({ reply, section }, idx) => (
              <div key={reply.id + (section || "")}>
                {section && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {section}
                  </div>
                )}
                <button
                  type="button"
                  data-idx={idx}
                  onClick={() => handleSelect(reply)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                    idx === activeIdx
                      ? "bg-primary/10 text-foreground"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  <span className="shrink-0 text-muted-foreground">
                    <QuickReplyTypeIcon type={reply.message_type || "text"} className="h-3.5 w-3.5" />
                  </span>
                  {reply.is_favorite && (
                    <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{reply.title}</span>
                      <span className="text-xs text-muted-foreground">
                        /{reply.shortcut}
                      </span>
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{typeLabel(reply)}</span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {previewSnippet(reply, contact, agentName)}
                    </p>
                  </div>
                  {reply.category && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      {reply.category}
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Modal mode (button-triggered) ────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/10 backdrop-blur-xs"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        style={{ maxHeight: "min(70vh, 560px)" }}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <MessageSquareText className="h-5 w-5 text-primary" />
          <h2 className="flex-1 text-sm font-semibold text-foreground">
            Quick Replies
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-border px-4 py-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, shortcut, or message…"
              className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Category filters */}
        {categories.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                activeCategory === null
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80",
              )}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() =>
                  setActiveCategory(activeCategory === cat ? null : cat)
                }
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  activeCategory === cat
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : displayItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <MessageSquareText className="h-8 w-8 opacity-40" />
              <p>No quick replies found</p>
              {search && (
                <p className="text-xs">Try a different search term</p>
              )}
            </div>
          ) : (
            <div className="py-1">
              {displayItems.map(({ reply, section }, idx) => (
                <div key={reply.id + (section || "")}>
                  {section && (
                    <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {section === "Recently Used" && (
                        <Clock className="h-3 w-3" />
                      )}
                      {section}
                    </div>
                  )}
                  <button
                    type="button"
                    data-idx={idx}
                    onClick={() => handleSelect(reply)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors",
                      idx === activeIdx
                        ? "bg-primary/10"
                        : "hover:bg-muted/50",
                    )}
                  >
                    <span className="mt-1 shrink-0 text-muted-foreground">
                      <QuickReplyTypeIcon type={reply.message_type || "text"} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {reply.is_favorite && (
                          <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                        )}
                        <span className="text-sm font-medium text-foreground">
                          {reply.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          /{reply.shortcut}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {typeLabel(reply)}
                        </span>
                        {reply.visibility === "personal" && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Personal
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {previewSnippet(reply, contact, agentName)}
                      </p>
                      {reply.category && (
                        <div className="mt-1">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {reply.category}
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border px-4 py-2">
          <p className="text-center text-[10px] text-muted-foreground">
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px]">↑↓</kbd>{" "}
            Navigate{" "}
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px]">↵</kbd>{" "}
            Insert{" "}
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px]">Esc</kbd>{" "}
            Close
          </p>
        </div>
      </div>
    </div>
  );
});
