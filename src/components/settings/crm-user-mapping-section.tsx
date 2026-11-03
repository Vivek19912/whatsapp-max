"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  resolveCrmDisplayName,
  resolveWacrmDisplayName,
} from "@/lib/integrations/travel-crm/user-mapping";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

/**
 * CRM User Mapping — Section 2 of Settings → Integrations →
 * Travel Agency CRM (Owner/Admin only).
 *
 * Maps each WhatsApp Max user (internal profiles.user_id) to the
 * Travel Agency CRM salesperson (internal Travel CRM users.id) that
 * user's Workspace-created leads are assigned to. Identity is by ID
 * on both sides — emails/names may differ between the systems.
 *
 * Unmapped creators fall back to the workspace owner (existing
 * behavior); a stale mapping (salesperson left the CRM account)
 * degrades to "needs attention" here and to the owner fallback at
 * lead-creation time, never blocking the lead.
 */

interface WacrmUserOption {
  id: string;
  name: string;
  email: string | null;
  role: string;
  has_mapping: boolean;
}

interface CrmUserOption {
  id: string;
  fullName: string;
  username: string | null;
  email: string | null;
}

type MappingStatus = "active" | "crm-user-removed" | "wacrm-user-removed" | "unknown";

interface Mapping {
  id: string;
  wacrm_user_id: string;
  wacrm_name: string | null;
  wacrm_email: string | null;
  crm_user_id: string;
  crm_name: string | null;
  crm_email: string | null;
  status: MappingStatus;
  created_at: string;
  updated_at: string;
}

const STATUS_COPY: Record<MappingStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  "crm-user-removed": { label: "Salesperson removed", variant: "destructive" },
  "wacrm-user-removed": { label: "User removed", variant: "destructive" },
  unknown: { label: "Unknown", variant: "secondary" },
};

function crmLabel(u: CrmUserOption): string {
  return u.email && u.email !== u.fullName ? `${u.fullName} (${u.email})` : u.fullName;
}

export function CrmUserMappingSection() {
  const { canEditSettings } = useAuth();

  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [wacrmUsers, setWacrmUsers] = useState<WacrmUserOption[]>([]);
  const [crmUsers, setCrmUsers] = useState<CrmUserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [crmUnreachable, setCrmUnreachable] = useState(false);

  const [selectedWacrm, setSelectedWacrm] = useState("");
  const [selectedCrm, setSelectedCrm] = useState("");
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<Mapping | null>(null);
  const [editCrm, setEditCrm] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [deleting, setDeleting] = useState<Mapping | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [listRes, optionsRes] = await Promise.all([
        fetch("/api/settings/crm-user-mappings", { cache: "no-store" }),
        fetch("/api/settings/crm-user-mappings/options", { cache: "no-store" }),
      ]);
      const list = await listRes.json().catch(() => null);
      const options = await optionsRes.json().catch(() => null);
      if (!listRes.ok || !list?.success) {
        throw new Error(
          list?.error ?? "Failed to load mappings. Try again.",
        );
      }
      setMappings(list.mappings ?? []);
      setCrmUnreachable(list.crmReachable === false);
      if (optionsRes.ok && options?.success) {
        setWacrmUsers(options.wacrm_users ?? []);
        setCrmUsers(options.crm_users ?? []);
      } else {
        // Options feed the dropdowns only; the table above already
        // loaded. Surface CRM outages distinctly from list failures.
        setCrmUnreachable(true);
        setWacrmUsers([]);
        setCrmUsers([]);
      }
      setSelectedWacrm("");
      setSelectedCrm("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load mappings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only unmapped members are offered for new mappings — updates go
  // through Edit on the existing row (the API 409s duplicates).
  const unmappedUsers = useMemo(
    () => wacrmUsers.filter((u) => !u.has_mapping),
    [wacrmUsers],
  );

  // Explicit trigger labels (never raw ids): Base UI's Select.Value
  // resolves an item's text only from mounted popup items, so after
  // the popup closes it falls back to the raw value (the UUID).
  // Passing the resolved name as children makes the display
  // deterministic regardless of popup/item mount state.
  const selectedWacrmLabel = selectedWacrm
    ? resolveWacrmDisplayName(selectedWacrm, wacrmUsers)
    : undefined;
  const selectedCrmLabel = selectedCrm
    ? resolveCrmDisplayName(selectedCrm, crmUsers)
    : undefined;
  const editCrmLabel = editing
    ? resolveCrmDisplayName(editCrm || editing.crm_user_id, crmUsers, editing.crm_name)
    : undefined;

  async function handleSave() {
    if (!selectedWacrm || !selectedCrm || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings/crm-user-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wacrm_user_id: selectedWacrm, crm_user_id: selectedCrm }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Failed to save the mapping.");
        return;
      }
      toast.success("Mapping saved.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  function openEdit(m: Mapping) {
    setEditing(m);
    setEditCrm(m.crm_user_id);
  }

  async function handleEditSave() {
    if (!editing || !editCrm || editSaving) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/settings/crm-user-mappings/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crm_user_id: editCrm }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Failed to update the mapping.");
        return;
      }
      toast.success("Mapping updated.");
      setEditing(null);
      await load();
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting || deleteSaving) return;
    setDeleteSaving(true);
    try {
      const res = await fetch(`/api/settings/crm-user-mappings/${deleting.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Failed to delete the mapping.");
        return;
      }
      toast.success("Mapping deleted. Future leads fall back to the workspace owner.");
      setDeleting(null);
      await load();
    } finally {
      setDeleteSaving(false);
    }
  }

  if (!canEditSettings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <ArrowLeftRight className="size-4 text-primary" />
            CRM User Mapping
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Only account owners and admins can manage user mappings.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <ArrowLeftRight className="size-4 text-primary" />
          CRM User Mapping
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Map each WhatsApp Max user to the Travel Agency CRM salesperson their
          Workspace-created leads are assigned to. Users without a mapping fall back to the
          workspace owner. Mappings are stored by internal user IDs — matching emails or
          names are not required, and different emails work fine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading users…</p>
        ) : loadError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="wacrm-user">WhatsApp Max user</Label>
              <Select value={selectedWacrm} onValueChange={(v) => setSelectedWacrm(v ?? "")}>
                <SelectTrigger id="wacrm-user">
                  <SelectValue placeholder="Select user">
                    {selectedWacrmLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {unmappedUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                      {u.email && u.email !== u.name ? ` (${u.email})` : ""} · {u.role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="crm-user">Travel Agency CRM salesperson</Label>
              <Select value={selectedCrm} onValueChange={(v) => setSelectedCrm(v ?? "")}>
                <SelectTrigger id="crm-user">
                  <SelectValue placeholder="Select salesperson">
                    {selectedCrmLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {crmUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {crmLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleSave}
              disabled={!selectedWacrm || !selectedCrm || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  Save mapping
                </>
              )}
            </Button>
          </div>
        )}
        {crmUnreachable && !loading && (
          <p className="text-xs text-muted-foreground">
            Travel Agency CRM is currently unreachable — the saved mappings
            below are intact, but names and statuses may be stale.
          </p>
        )}

        {loading || mappings === null ? (
          <p className="text-sm text-muted-foreground">Loading mappings…</p>
        ) : mappings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mappings yet. Leads are assigned to the workspace owner until you add one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>WhatsApp Max user</TableHead>
                <TableHead>CRM salesperson</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((m) => {
                const status = STATUS_COPY[m.status];
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">
                        {m.wacrm_name ?? "Unknown user"}
                      </div>
                      {m.wacrm_email && (
                        <div className="text-xs text-muted-foreground">{m.wacrm_email}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {m.crm_name ?? "Unknown salesperson"}
                      </div>
                      {m.crm_email && (
                        <div className="text-xs text-muted-foreground">{m.crm_email}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(m.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit mapping for ${m.wacrm_name ?? "user"}`}
                          onClick={() => openEdit(m)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete mapping for ${m.wacrm_name ?? "user"}`}
                          onClick={() => setDeleting(m)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit mapping</DialogTitle>
              <DialogDescription>
                Change the salesperson for {editing?.wacrm_name ?? "this user"}. Applies to
                future leads only.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-2">
              <Label htmlFor="edit-crm-user">Travel Agency CRM salesperson</Label>
              <Select value={editCrm} onValueChange={(v) => setEditCrm(v ?? "")}>
                <SelectTrigger id="edit-crm-user">
                  <SelectValue placeholder="Select salesperson">
                    {editCrmLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {crmUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {crmLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={handleEditSave} disabled={!editCrm || editSaving}>
                {editSaving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete mapping?</DialogTitle>
              <DialogDescription>
                {deleting?.wacrm_name ?? "This user"}’s future leads will fall back to the
                workspace owner. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleteSaving}>
                {deleteSaving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete mapping"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
