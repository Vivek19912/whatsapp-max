"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Contact, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  StickyNote,
  Workflow,
  Plus,
  X,
  Loader2,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import {
  contactFlowRunsQuery,
  pickContactFlow,
  type ContactFlowRun,
} from "@/lib/inbox/contact-flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
  onTagsChanged?: () => void;
   className?: string;
}

// Same palette as the Settings > Tags manager, so a tag created here
// looks identical to one created there — no separate colour system.
const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function ContactSidebar({ contact, onTagsChanged,className }: ContactSidebarProps) {
  const { user, accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [flowName, setFlowName] = useState<string | null>(null);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Tag-picker dropdown state
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[3]);
  const [creatingTag, setCreatingTag] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch notes, tags, and the contact's flow in parallel
    const [notesRes, tagsRes, flowRes] = await Promise.all([
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      contactFlowRunsQuery(supabase, accountId, contact.id),
    ]);

    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    // Flow name for the selected contact (null → "No flow" empty state).
    // Cast via unknown: the untyped supabase client infers the embedded
    // `flow` relation as an array.
    setFlowName(
      pickContactFlow((flowRes.data ?? []) as unknown as ContactFlowRun[]),
    );
  }, [contact, accountId]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  // All account tags, for the assign/unassign picker. Same source table
  // and scoping as Settings > Tags (`TagManager`) so both surfaces stay
  // in sync — creating a tag here shows up there and vice versa.
  // Intentional manual memoization (narrow dep); the compiler's
  // inferred dep would refire this fetch more often. Not refactored
  // to avoid changing fetch timing on a live surface.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const fetchAllTags = useCallback(async () => {
    if (!user?.id) return;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tags")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("Failed to fetch tags:", error);
      return;
    }
    setAllTags((data as Tag[]) ?? []);
  }, [user?.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAllTags();
  }, [fetchAllTags]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  // Assign an existing tag to the current contact.
  const handleAssignTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      setTogglingTagId(tag.id);

      const supabase = createClient();
      const { data, error } = await supabase
        .from("contact_tags")
        .insert({
          contact_id: contact.id,
          tag_id: tag.id,
        })
        .select("id")
        .single();

      if (error) {
        console.error("Failed to assign tag:", error);
        toast.error("Failed to add tag");
        setTogglingTagId(null);
        return;
      }

      setTags((prev) => [...prev, { ...tag, contact_tag_id: data.id }]);
      setTogglingTagId(null);
      onTagsChanged?.();

      // A manual tag add should also be able to fire a `tag_added`
      // automation. The server route resolves the account from the session
      // and matches the tag; fire-and-forget so the UI never blocks on it.
      void fetch("/api/automations/engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger_type: "tag_added",
          contact_id: contact.id,
          context: { tag_id: tag.id },
        }),
      }).catch(() => {});
    },
    [contact, accountId, onTagsChanged],
  );

  // Remove a tag from the current contact (does not delete the tag
  // itself — just the contact_tags join row). Manual memoization is
  // intentional here; see the note on fetchAllTags above.
  /* eslint-disable react-hooks/preserve-manual-memoization -- see note above */
  const handleRemoveTag = useCallback(
    async (contactTagId: string, tagId: string) => {
      setTogglingTagId(tagId);
      const supabase = createClient();
      const { error } = await supabase
        .from("contact_tags")
        .delete()
        .eq("id", contactTagId);

      if (error) {
        console.error("Failed to remove tag:", error);
        toast.error("Failed to remove tag");
        setTogglingTagId(null);
        return;
      }

      setTags((prev) => prev.filter((t) => t.contact_tag_id !== contactTagId));
      setTogglingTagId(null);
      onTagsChanged?.();
    },
    [],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const handleToggleTag = useCallback(
    (tag: Tag) => {
      const existing = tags.find((t) => t.id === tag.id);
      if (existing) {
        void handleRemoveTag(existing.contact_tag_id, tag.id);
      } else {
        void handleAssignTag(tag);
      }
    },
    [tags, handleAssignTag, handleRemoveTag],
  );

  // Create a brand-new tag (same insert shape as Settings > Tags) and
  // immediately assign it to the current contact. Manual memoization
  // is intentional here; see the note on fetchAllTags above.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleCreateTag = useCallback(async () => {
    if (!newTagName.trim() || !user?.id || !accountId || !contact) return;
    setCreatingTag(true);

    const supabase = createClient();
    const { data: created, error } = await supabase
      .from("tags")
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: newTagColor,
      })
      .select()
      .single();

    if (error || !created) {
      console.error("Failed to create tag:", error);
      toast.error("Failed to create tag");
      setCreatingTag(false);
      return;
    }

    setAllTags((prev) => [...prev, created as Tag]);
    await handleAssignTag(created as Tag);
    setNewTagName("");
    setNewTagColor(PRESET_COLORS[3]);
    setCreatingTag(false);
  }, [newTagName, newTagColor, user?.id, accountId, contact, handleAssignTag]);

  if (!contact) {
    return (
  <div className={cn("flex h-full w-70 flex-col border-l border-border bg-card", className)}></div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();
  const assignedTagIds = new Set(tags.map((t) => t.id));

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}

            {/* Click-to-WhatsApp source URL — where this lead came from.
                Opens in a new tab. Only shown when the contact has one. */}
            {contact.source_url && (
              <a
                href={contact.source_url}
                target="_blank"
                rel="noopener noreferrer"
                title={contact.source_url}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary transition-colors hover:bg-muted"
              >
                <span className="truncate">
                  <span className="text-muted-foreground">Ad URL: </span>
                  <ExternalLink className="inline h-3.5 w-3.5 align-text-bottom" />{" "}
                  {contact.source_url.replace(/^https?:\/\//, "").replace(/^www\./, "")}
                </span>
              </a>
            )}

            {/* Click-to-WhatsApp click id (ctwa_clid) — one line, same
                format. Not a link; copyable text only. */}
            {contact.ctwa_clid && (
              <div
                title={contact.ctwa_clid}
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
              >
                <span className="truncate">
                  <span className="text-muted-foreground">ctwa_clid: </span>
                  {contact.ctwa_clid}
                </span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                Tags
              </div>
              <DropdownMenu open={tagMenuOpen} onOpenChange={setTagMenuOpen}>
                <DropdownMenuTrigger
                  className="inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Manage tags"
                >
                  <Plus className="h-3 w-3" />
                  <ChevronDown className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-64 border-border bg-popover p-2"
                >
                  {/* Existing tags — click to toggle assign/unassign */}
                  <div className="max-h-48 space-y-0.5 overflow-y-auto">
                    {allTags.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        No tags yet — create one below.
                      </p>
                    ) : (
                      allTags.map((tag) => {
                        const isAssigned = assignedTagIds.has(tag.id);
                        const isToggling = togglingTagId === tag.id;
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => handleToggleTag(tag)}
                            disabled={isToggling}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                              isAssigned ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                            />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {isToggling ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                            ) : isAssigned ? (
                              <Check className="h-3 w-3 shrink-0 text-primary" />
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>

                  {/* Inline create — same shape as Settings > Tags */}
                  <div className="mt-2 space-y-2 border-t border-border pt-2">
                    <Input
                      placeholder="New tag name"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") handleCreateTag();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      disabled={creatingTag}
                      maxLength={40}
                      className="h-8 text-xs"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex gap-1">
                        {PRESET_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setNewTagColor(color)}
                            aria-label={`Use ${color}`}
                            aria-pressed={newTagColor === color}
                            className={cn(
                              "h-4 w-4 rounded-full transition-transform hover:scale-110",
                              newTagColor === color &&
                                "outline outline-2 outline-offset-1 outline-primary",
                            )}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <Button
                        size="sm"
                        className="h-7 bg-primary px-2 text-xs hover:bg-primary/90"
                        onClick={handleCreateTag}
                        disabled={creatingTag || !newTagName.trim()}
                      >
                        {creatingTag ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        Add
                      </Button>
                    </div>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag.contact_tag_id, tag.id)}
                      disabled={togglingTagId === tag.id}
                      aria-label={`Remove ${tag.name}`}
                      className="opacity-60 transition-opacity hover:opacity-100"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Flow — the flow associated with this contact, resolved from
              its flow_runs (active run first, else most recent run). */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Workflow className="h-3 w-3" />
              Flow
            </div>
            <div className="mt-2">
              {flowName ? (
                <p className="break-words px-1 text-sm font-medium text-foreground" title={flowName}>
                  {flowName}
                </p>
              ) : (
                <p className="px-1 text-xs text-muted-foreground">No flow</p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}