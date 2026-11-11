"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface AgentInboxPermissions {
  can_manage_assignments: boolean;
  can_view_all: boolean;
}

interface AgentPermissionsDialogProps {
  /** The agent being edited, or null when closed. Owner-only surface. */
  member: { user_id: string; full_name: string } | null;
  onClose: () => void;
  onSaved: (userId: string, flags: AgentInboxPermissions) => void;
}

/**
 * Owner-only per-agent Inbox permission editor. Two independent
 * checkboxes, each with its exact access description:
 *
 * - Manage Assignments: reassign Workspace leads and Inbox
 *   conversations to any salesperson. Read access is NOT granted.
 * - View All Conversations: read every Inbox conversation, including
 *   other agents' and unassigned chats. Assignment rights NOT granted.
 *
 * Server enforces owner-only (PUT 403s otherwise, RLS would too);
 * the UI gates the open button the same way. Neither checkbox
 * implies the other — both are stored and evaluated independently.
 */
export function AgentPermissionsDialog({
  member,
  onClose,
  onSaved,
}: AgentPermissionsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState(false);
  const [viewAll, setViewAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/account/agent-permissions?user_id=${encodeURIComponent(member.user_id)}`,
          { cache: "no-store" }
        );
        const data = (await res.json().catch(() => null)) as {
          permission?: Partial<AgentInboxPermissions>;
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.permission) {
          throw new Error(data?.error || "Could not load permissions.");
        }
        setManage(data.permission.can_manage_assignments === true);
        setViewAll(data.permission.can_view_all === true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not load permissions.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [member]);

  async function handleSave() {
    if (!member || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/account/agent-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: member.user_id,
          can_manage_assignments: manage,
          can_view_all: viewAll,
        }),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        permission?: AgentInboxPermissions;
      } | null;
      if (!res.ok || !payload?.permission) {
        throw new Error(payload?.error || "Could not save permissions.");
      }
      onSaved(member.user_id, {
        can_manage_assignments: payload.permission.can_manage_assignments,
        can_view_all: payload.permission.can_view_all,
      });
      toast.success(`Updated inbox access for ${member.full_name || "agent"}.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save permissions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            Inbox access — {member?.full_name || "agent"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Independent permissions. Neither grants the other, and neither
            changes the agent&apos;s role.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <p className="py-4 text-center text-sm text-destructive">{loadError}</p>
        ) : (
          <div className="space-y-4 py-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/50">
              <Checkbox
                checked={manage}
                onCheckedChange={(v) => setManage(v === true)}
                aria-label="Manage Assignments"
              />
              <span>
                <span className="text-sm font-medium text-popover-foreground">
                  Manage Assignments
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Can reassign Workspace leads and Inbox conversations to any salesperson.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/50">
              <Checkbox
                checked={viewAll}
                onCheckedChange={(v) => setViewAll(v === true)}
                aria-label="View All Conversations"
              />
              <span>
                <span className="text-sm font-medium text-popover-foreground">
                  View All Conversations
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Can view all Inbox conversations, including conversations
                  assigned to other agents and unassigned conversations.
                </span>
              </span>
            </label>

            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <KeyRound className="mt-0.5 size-3 shrink-0" />
              Applies immediately — no re-login needed. Revoking takes
              effect on the agent&apos;s next Inbox load or realtime sync.
            </p>
          </div>
        )}

        <DialogFooter className="border-border">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading || !!loadError || saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Saving…
              </>
            ) : (
              "Save permissions"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
