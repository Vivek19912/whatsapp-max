"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AccountMember } from "@/types";

interface AssignableConversation {
  id: string;
  assigned_agent_id: string | null;
  last_message_at: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

interface AssignDialogProps {
  open: boolean;
  onClose: () => void;
  members: AccountMember[];
  /** Called after a successful assign so the parent can mirror it into list state. */
  onAssigned?: (conversationId: string, agentId: string | null) => void;
}

/**
 * Cross-thread assignment dialog for owners/admins and agents with
 * the Manage Assignments permission. Lists threads the viewer may
 * not be able to open (no messages, no media — display name and
 * current assignee only) with a per-row assignee picker.
 *
 * Server enforcement lives in GET /api/inbox/assignable (who may
 * list) and POST /api/inbox/conversations/[id]/assign (who may
 * write); this dialog never decides access itself.
 */
export function AssignDialog({ open, onClose, members, onAssigned }: AssignDialogProps) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<AssignableConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery("");
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/inbox/assignable?limit=200", {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as {
          conversations?: AssignableConversation[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !json || !Array.isArray(json.conversations)) {
          throw new Error(json?.error || "Could not load conversations.");
        }
        setRows(json.conversations);
      } catch (err) {
        if (!cancelled) {
          setRows([]);
          setError(err instanceof Error ? err.message : "Could not load conversations.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open ]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const name = (r.contact?.name ?? "").toLowerCase();
      const phone = (r.contact?.phone ?? "").replace(/\D/g, "");
      const digits = q.replace(/\D/g, "");
      return (
        name.includes(q) ||
        (digits !== "" && phone.includes(digits)) ||
        (r.contact?.phone ?? "").includes(q)
      );
    });
  }, [rows, query]);

  async function handleAssign(conversationId: string, agentId: string | null) {
    setSavingId(conversationId);
    try {
      const res = await fetch(`/api/inbox/conversations/${conversationId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: agentId }),
      });
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(payload?.error || "Could not update assignment.");
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === conversationId ? { ...r, assigned_agent_id: agentId } : r
        )
      );
      onAssigned?.(conversationId, agentId);
      toast.success(agentId ? "Conversation assigned." : "Conversation unassigned.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update assignment.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="border-border bg-popover max-h-[80vh] w-[calc(100%-2rem)] max-w-lg overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle className="text-popover-foreground text-sm">
            Assign conversations
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            Names and current assignees only — message history stays
            private to each thread&apos;s owner.
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 pb-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or number..."
            className="border-border bg-muted h-8 text-sm"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-4 pb-4">
          {loading ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              Loading conversations…
            </p>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground text-sm">{error}</p>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary mt-2"
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  fetch("/api/inbox/assignable?limit=200", { cache: "no-store" })
                    .then(async (res) => {
                      const json = (await res.json().catch(() => null)) as {
                        conversations?: AssignableConversation[];
                        error?: string;
                      } | null;
                      if (!res.ok || !json || !Array.isArray(json.conversations)) {
                        throw new Error(json?.error || "Could not load conversations.");
                      }
                      setRows(json.conversations);
                    })
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : "Could not load conversations.")
                    )
                    .finally(() => setLoading(false));
                }}
              >
                Retry
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No conversations found.
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {visible.map((row) => {
                const displayName =
                  row.contact?.name?.trim() ||
                  row.contact?.phone ||
                  "Unknown";
                const busy = savingId === row.id;
                return (
                  <li key={row.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-popover-foreground truncate text-sm font-medium">
                        {displayName}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {row.contact?.phone ?? "No number"}
                      </p>
                    </div>
                    <select
                      aria-label={`Assign ${displayName}`}
                      className={cn(
                        "border-border bg-muted text-foreground h-8 max-w-36 shrink-0 truncate rounded-md px-2 text-xs",
                        busy && "opacity-60"
                      )}
                      disabled={busy}
                      value={row.assigned_agent_id ?? ""}
                      onChange={(e) =>
                        handleAssign(row.id, e.target.value === "" ? null : e.target.value)
                      }
                    >
                      <option value="">Unassigned</option>
                      {members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.full_name || "Unnamed member"}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
