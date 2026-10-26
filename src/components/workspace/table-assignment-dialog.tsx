"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pause, Play, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ConfigDialog,
  ConfigFooterActions,
  ConfigSection,
  ConfigStatusBadge,
} from "./config-dialog";
import { SearchableSelect } from "./searchable-select";

/** Common IANA zones for quick picking; full list follows. */
const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
];

function allTimezones(): string[] {
  try {
    const supported = (Intl as unknown as {
      supportedValuesOf?: (kind: string) => string[];
    }).supportedValuesOf;
    if (typeof supported === "function") {
      const zones = supported.call(Intl, "timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    // Fall through to the curated list below.
  }
  return COMMON_TIMEZONES;
}

/** "Paused until 29 Oct, 5:00 PM" in the table's zone (display only). */
function formatPausedUntilFull(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")}`.replace("  ", " ");
  } catch {
    return iso;
  }
}

/**
 * Per-table Lead Assignment settings (Meta Lead Ads tables and
 * Flow tables alike). Opened from the Workspace header via
 * "Assignment". One compact single-panel dialog: status,
 * distribution method, timezone, assignees, pauses, and
 * notification preferences live in sections (no step flow).
 * Every read and write is scoped to this table server-side.
 */

interface AssigneeView {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  position: number;
  weight: number;
  is_active: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  pause_scope: "table" | "account";
  notify_email: boolean;
  notify_whatsapp: boolean;
  available: boolean;
  unavailable_reason: "active" | "paused" | "ineligible-member" | null;
  status_label: string;
}

interface AssignmentPayload {
  flow: { id: string; kind: string; form_db_id: string | null };
  config: {
    id: string;
    enabled: boolean;
    mode: "round_robin" | "percentage";
    timezone: string;
    whatsapp_template_name: string | null;
    whatsapp_template_language: string;
  } | null;
  assignees: AssigneeView[];
}

interface RosterMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

interface NotificationRow {
  id: string;
  channel: string;
  to_email: string | null;
  to_phone: string | null;
  subject: string | null;
  status: string;
  attempt: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

type Draft = {
  key: string;
  user_id: string | null;
  display_name: string;
  email: string;
  phone: string;
  weight: string;
  is_active: boolean;
  notify_email: boolean;
  notify_whatsapp: boolean;
};

const emptyDraft = (): Draft => ({
  key: `new-${Date.now()}`,
  user_id: null,
  display_name: "",
  email: "",
  phone: "",
  weight: "0",
  is_active: true,
  notify_email: true,
  notify_whatsapp: false,
});

export function TableAssignmentDialog({
  flowId,
  flowName,
  tableKind,
  open,
  onOpenChange,
}: {
  flowId: string;
  flowName?: string | null;
  tableKind?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [payload, setPayload] = useState<AssignmentPayload | null>(null);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"round_robin" | "percentage">("round_robin");
  const [timezone, setTimezone] = useState("UTC");
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("en_US");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<Draft>(emptyDraft());
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  const [pauseMode, setPauseMode] = useState<"today" | "days" | "until" | "resume">("today");
  const [pauseDays, setPauseDays] = useState("1");
  const [pauseUntil, setPauseUntil] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [pauseScope, setPauseScope] = useState<"table" | "account">("table");
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const readJson = async (res: Response) => {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof json.error === "string" ? json.error : `Request failed (${res.status})`,
      );
    }
    return json;
  };

  const toDraft = useCallback((a: AssigneeView): Draft => {
    return {
      key: a.id,
      user_id: a.user_id,
      display_name: a.display_name,
      email: a.email ?? "",
      phone: a.phone ?? "",
      weight: String(a.weight ?? 0),
      is_active: a.is_active,
      notify_email: a.notify_email,
      notify_whatsapp: a.notify_whatsapp,
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assignJson, rosterJson] = await Promise.all([
        readJson(
          await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment`, {
            cache: "no-store",
          }),
        ),
        readJson(await fetch(`/api/account/members`, { cache: "no-store" })).catch(
          () => ({ members: [] }),
        ),
      ]);
      const data = assignJson as unknown as AssignmentPayload;
      setPayload(data);
      setEnabled(data.config?.enabled ?? false);
      setMode(data.config?.mode ?? "round_robin");
      setTimezone(data.config?.timezone ?? "UTC");
      setTemplateName(data.config?.whatsapp_template_name ?? "");
      setTemplateLanguage(data.config?.whatsapp_template_language ?? "en_US");
      setDrafts((data.assignees ?? []).map(toDraft));
      const members = (rosterJson as { members?: RosterMember[] }).members ?? [];
      setRoster(members);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load assignment settings.");
    } finally {
      setLoading(false);
    }
  }, [flowId, toDraft]);

  useEffect(() => {
    if (open) {
      setEditingKey(null);
      setForm(emptyDraft());
      setPauseFor(null);
      setShowNotifications(false);
      setNotifications(null);
      void load();
    }
  }, [open, load]);

  const rosterById = useMemo(() => {
    return new Map(roster.map((m) => [m.user_id, m]));
  }, [roster]);

  const timezoneOptions = useMemo(() => {
    const zones = allTimezones();
    const ordered = [
      ...COMMON_TIMEZONES.filter((z) => zones.includes(z)),
      ...zones.filter((z) => !COMMON_TIMEZONES.includes(z)),
    ];
    return ordered.map((z) => ({ value: z, label: z }));
  }, []);

  const rosterOptions = useMemo(
    () =>
      roster.map((m) => ({
        value: m.user_id,
        label: m.full_name?.trim() || m.email || m.user_id,
        hint: m.role,
      })),
    [roster]
  );

  const activeWeightTotal = useMemo(() => {
    return drafts
      .filter((d) => d.is_active)
      .reduce((sum, d) => sum + (Number.parseInt(d.weight, 10) || 0), 0);
  }, [drafts]);

  const weightError =
    mode === "percentage" && drafts.some((d) => d.is_active) && activeWeightTotal !== 100
      ? `Active percentages must total exactly 100% (currently ${activeWeightTotal}%).`
      : null;

  const patchDraft = (key: string, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const removeDraft = (key: string) => {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  };

  const startAdd = () => {
    setEditingKey("__new__");
    setForm(emptyDraft());
  };

  const startEdit = (d: Draft) => {
    setEditingKey(d.key);
    setForm({ ...d });
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setForm(emptyDraft());
  };

  const confirmEdit = () => {
    const name = form.display_name.trim();
    if (!name) {
      toast.error("Give the assignee a display name.");
      return;
    }
    if (!form.user_id && !form.email.trim() && !form.phone.trim()) {
      toast.error("Link a team member or enter an email address or phone number.");
      return;
    }
    if (form.user_id) {
      const clash = drafts.some((d) => d.key !== form.key && d.user_id === form.user_id);
      if (clash) {
        toast.error("That team member is already on this table.");
        return;
      }
      const member = rosterById.get(form.user_id);
      if (member && !form.display_name.trim()) {
        form.display_name = member.full_name?.trim() || member.email || form.user_id;
      }
    }
    if (editingKey === "__new__") {
      setDrafts((prev) => [...prev, { ...form, key: `new-${Date.now()}` }]);
    } else {
      setDrafts((prev) => prev.map((d) => (d.key === form.key ? { ...form } : d)));
    }
    cancelEdit();
  };

  const linkMember = (userId: string) => {
    if (!userId) {
      setForm((f) => ({ ...f, user_id: null }));
      return;
    }
    const member = rosterById.get(userId);
    setForm((f) => ({
      ...f,
      user_id: userId,
      display_name: f.display_name.trim() || member?.full_name?.trim() || member?.email || userId,
      email: f.email.trim() || member?.email || "",
    }));
  };

  const save = async () => {
    if (weightError) {
      toast.error(weightError);
      return;
    }
    setBusy("save");
    setSaveError(null);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled,
            mode,
            timezone: timezone.trim() || "UTC",
            whatsapp_template_name: templateName.trim() || null,
            whatsapp_template_language: templateLanguage.trim() || "en_US",
            assignees: drafts.map((d) => ({
              user_id: d.user_id,
              display_name: d.display_name.trim(),
              email: d.email.trim() || null,
              phone: d.phone.trim() || null,
              weight: Number.parseInt(d.weight, 10) || 0,
              is_active: d.is_active,
              notify_email: d.notify_email,
              notify_whatsapp: d.notify_whatsapp,
            })),
          }),
        }),
      )) as unknown as { config: AssignmentPayload["config"] };
      toast.success("Assignment settings saved for this table.");
      if (json.config) {
        setPayload((p) =>
          p ? { ...p, config: { ...json.config!, }, assignees: p.assignees } : p,
        );
      }
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save assignment settings.";
      setSaveError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const submitPause = async () => {
    if (!pauseFor) return;
    setBusy("pause");
    try {
      const body: Record<string, unknown> = {
        assignee_id: pauseFor,
        mode: pauseMode,
        scope: pauseScope,
      };
      if (pauseMode === "days") body.days = Number.parseInt(pauseDays, 10);
      if (pauseMode === "until") body.until = pauseUntil;
      if (pauseReason.trim()) body.reason = pauseReason.trim();
      await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/pause`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      toast.success(pauseMode === "resume" ? "Assignee resumed." : "Pause updated.");
      setPauseFor(null);
      setPauseReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update the pause.");
    } finally {
      setBusy(null);
    }
  };

  const loadNotifications = async () => {
    setShowNotifications(true);
    try {
      const json = (await readJson(
        await fetch(`/api/flows/${encodeURIComponent(flowId)}/assignment/notifications`, {
          cache: "no-store",
        }),
      )) as unknown as { notifications: NotificationRow[] };
      setNotifications(json.notifications ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load deliveries.");
    }
  };

  const kindLabel = tableKind === "meta_lead_ads" ? "Meta Lead Ads table" : "Flow table";

  return (
    <ConfigDialog
      open={open}
      onOpenChange={onOpenChange}
      width="xl"
      icon={<UserPlus aria-hidden />}
      title="Assignment"
      tableLine={`${flowName ?? "This table"} · ${kindLabel}`}
      description="Settings apply to this table only. Saving never rewrites existing lead owners."
      status={
        <ConfigStatusBadge tone={enabled ? "default" : "secondary"}>
          {enabled ? "Automatic" : "Manual"}
        </ConfigStatusBadge>
      }
      loading={loading}
      loadingText="Loading assignment settings…"
      error={saveError}
      footer={
        <ConfigFooterActions
          onClose={() => onOpenChange(false)}
          closeLabel="Cancel"
          onSave={save}
          saveLabel="Save Assignment Settings"
          saving={busy === "save"}
          saveDisabled={loading}
        />
      }
    >
      {!loading && (
        <div className="flex flex-col gap-5">
          <section aria-label="Automatic assignment">
            <ConfigSection
              title="Automatic assignment"
              hint={
                enabled
                  ? "New leads are distributed to eligible assignees."
                  : "Off — new leads stay unassigned until someone assigns them."
              }
              action={
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Automatic assignment"
                />
              }
            >
              <div />
            </ConfigSection>
          </section>

          <section aria-label="Distribution method">
            <ConfigSection
              title="Distribution method"
              hint={
                mode === "round_robin"
                  ? "Leads go to each eligible assignee in turn."
                  : "A paused assignee's share is redistributed across the remaining eligible assignees; shares always total 100% of the active pool."
              }
            >
              <RadioGroup
                value={mode}
                onValueChange={(v) => {
                  if (v === "round_robin" || v === "percentage") setMode(v);
                }}
                aria-label="Distribution method"
                className="grid gap-2 sm:grid-cols-2"
              >
                <label
                  htmlFor="assign-mode-rr"
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors",
                    mode === "round_robin"
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/50"
                  )}
                >
                  <RadioGroupItem value="round_robin" id="assign-mode-rr" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">Round robin</span>
                    <span className="block text-xs text-muted-foreground">
                      Equal rotation across everyone eligible.
                    </span>
                  </span>
                </label>
                <label
                  htmlFor="assign-mode-pct"
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors",
                    mode === "percentage"
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-card hover:bg-muted/50"
                  )}
                >
                  <RadioGroupItem value="percentage" id="assign-mode-pct" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Percentage-based
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Weighted shares; paused members drop out and the rest absorb their share.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </ConfigSection>
          </section>

          <section aria-label="Timezone">
            <ConfigSection
              title="Timezone"
              hint="Controls pause calculations (“Pause for today” ends at local midnight here) and how availability times are displayed."
            >
              <div className="flex w-full flex-col gap-1.5">
                <Label htmlFor="assign-tz">Table timezone (IANA name)</Label>
                <SearchableSelect
                  value={timezoneOptions.some((o) => o.value === timezone) ? timezone : ""}
                  options={timezoneOptions}
                  onChange={(v) => setTimezone(v)}
                  placeholder="Select a timezone…"
                  searchPlaceholder="Search timezones…"
                  emptyText="No matching timezone."
                  ariaLabel="Table timezone"
                  triggerClassName="h-9 font-mono text-[13px]"
                />
              </div>
            </ConfigSection>
          </section>

          <section aria-label="WhatsApp notifications">
            <ConfigSection
              title="WhatsApp notifications"
              hint="Separate from assignment ownership: these alerts notify assignees without changing who owns the lead. They send only when the template below is set, APPROVED, and the account sender is connected. Email alerts use SMTP."
            >
              <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="assign-wa-template">WhatsApp template (optional)</Label>
                  <Input
                    id="assign-wa-template"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="new_lead_assigned"
                    className="h-9"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="assign-wa-lang">Template language</Label>
                  <Input
                    id="assign-wa-lang"
                    value={templateLanguage}
                    onChange={(e) => setTemplateLanguage(e.target.value)}
                    placeholder="en_US"
                    className="h-9 max-w-48"
                  />
                </div>
              </div>
            </ConfigSection>
          </section>

          <section aria-label="Assignees">
            <ConfigSection
              title={`Assignees (${drafts.length})`}
              hint={
                mode === "percentage"
                  ? `Active shares must total exactly 100% — current active total: ${activeWeightTotal}%.`
                  : "Everyone listed takes turns receiving new leads while eligible."
              }
              action={
                <Button type="button" variant="outline" size="sm" onClick={startAdd}>
                  <Plus className="mr-1.5 size-4" aria-hidden /> Add assignee
                </Button>
              }
            >
              {weightError ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {weightError}
                </p>
              ) : null}
              {drafts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center">
                  <p className="text-sm font-medium text-foreground">No assignees yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    Link a team member or add an external contact. New leads stay
                    unassigned until someone is eligible.
                  </p>
                </div>
              ) : (
                <>
                <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Contact</TableHead>
                        {mode === "percentage" && <TableHead className="w-20">Share %</TableHead>}
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {drafts.map((d) => {
                        const saved = payload?.assignees.find((a) => a.id === d.key);
                        return (
                          <TableRow key={d.key} className={cn(!d.is_active && "opacity-60")}>
                            <TableCell>
                              <p className="text-sm font-medium">{d.display_name || "—"}</p>
                              <p className="text-muted-foreground text-xs">
                                {d.user_id
                                  ? `Team member${rosterById.get(d.user_id)?.full_name ? ` · ${rosterById.get(d.user_id)?.full_name}` : ""}`
                                  : "External recipient"}
                              </p>
                            </TableCell>
                            <TableCell>
                              <p className="text-xs">{d.email || "—"}</p>
                              <p className="text-muted-foreground text-xs">{d.phone || ""}</p>
                              <p className="text-muted-foreground text-xs">
                                {d.notify_email ? "Email on" : "Email off"} ·{" "}
                                {d.notify_whatsapp ? "WhatsApp on" : "WhatsApp off"}
                              </p>
                            </TableCell>
                            {mode === "percentage" && (
                              <TableCell>
                                <Input
                                  value={d.weight}
                                  inputMode="numeric"
                                  className="w-16"
                                  aria-label={`Share percentage for ${d.display_name}`}
                                  onChange={(e) =>
                                    patchDraft(d.key, { weight: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })
                                  }
                                />
                              </TableCell>
                            )}
                      <TableCell>
                        {saved ? (
                          <div className="flex flex-col items-start gap-1">
                            <span className="flex items-center gap-1">
                              <Badge variant={saved.available ? "default" : "secondary"}>
                                {saved.available ? "Available" : saved.status_label}
                              </Badge>
                              {!d.is_active && (
                                <Badge variant="secondary">
                                  Inactive
                                </Badge>
                              )}
                            </span>
                            {saved.paused_until && (
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                until {formatPausedUntilFull(saved.paused_until, timezone)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline">Unsaved</Badge>
                        )}
                      </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => patchDraft(d.key, { is_active: !d.is_active })}
                                  aria-label={d.is_active ? "Deactivate" : "Activate"}
                                >
                                  {d.is_active ? "Deactivate" : "Activate"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => startEdit(d)}
                                >
                                  Edit
                                </Button>
                                {saved && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setPauseFor(saved.id)}
                                    aria-label={saved.paused_until ? "Resume or extend pause" : "Pause"}
                                  >
                                    {saved.paused_until ? <Play className="size-4" /> : <Pause className="size-4" />}
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeDraft(d.key)}
                                  aria-label="Remove"
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
                  </div>
                  <div className="flex flex-col gap-2 md:hidden">
                    {drafts.map((d) => {
                      const saved = payload?.assignees.find((a) => a.id === d.key);
                      return (
                        <div
                          key={d.key}
                          className={cn(
                            "rounded-lg border border-border bg-card p-3",
                            !d.is_active && "opacity-60"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {d.display_name || "—"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {d.user_id ? "Team member" : "External recipient"}
                              </p>
                            </div>
                            {saved ? (
                              <Badge variant={saved.available ? "default" : "secondary"} className="shrink-0">
                                {saved.status_label}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="shrink-0">
                                Unsaved
                              </Badge>
                            )}
                          </div>
                          <dl className="mt-2 space-y-1 text-xs">
                            <div className="flex gap-1.5">
                              <dt className="w-16 shrink-0 text-muted-foreground">Contact</dt>
                              <dd className="min-w-0 flex-1 truncate text-foreground">
                                {[d.email, d.phone].filter(Boolean).join(" · ") || "—"}
                              </dd>
                            </div>
                            {mode === "percentage" ? (
                              <div className="flex items-center gap-1.5">
                                <dt className="w-16 shrink-0 text-muted-foreground">Share</dt>
                                <dd className="flex flex-1 items-center gap-1">
                                  <Input
                                    value={d.weight}
                                    inputMode="numeric"
                                    className="h-8 w-20"
                                    aria-label={`Share percentage for ${d.display_name}`}
                                    onChange={(e) =>
                                      patchDraft(d.key, {
                                        weight: e.target.value.replace(/[^0-9]/g, "").slice(0, 3),
                                      })
                                    }
                                  />
                                  <span className="text-muted-foreground">%</span>
                                </dd>
                              </div>
                            ) : null}
                            <div className="flex gap-1.5">
                              <dt className="w-16 shrink-0 text-muted-foreground">Alerts</dt>
                              <dd className="flex-1 text-foreground">
                                {d.notify_email ? "Email on" : "Email off"} ·{" "}
                                {d.notify_whatsapp ? "WhatsApp on" : "WhatsApp off"}
                              </dd>
                            </div>
                          </dl>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() => patchDraft(d.key, { is_active: !d.is_active })}
                            >
                              {d.is_active ? "Deactivate" : "Activate"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() => startEdit(d)}
                            >
                              Edit
                            </Button>
                            {saved ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                onClick={() => setPauseFor(saved.id)}
                              >
                                {saved.paused_until ? "Resume / extend" : "Pause"}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs text-destructive"
                              onClick={() => removeDraft(d.key)}
                              aria-label={`Remove ${d.display_name || "assignee"}`}
                            >
                              <Trash2 className="size-4" aria-hidden /> Remove
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  </>
                )}
              </ConfigSection>
            </section>

                {(editingKey || pauseFor) && (
                  <section aria-label="Assignee editor">
                    <ConfigSection
                      title={pauseFor ? "Pause controls" : editingKey === "__new__" ? "Add assignee" : "Edit assignee"}
                      hint={
                        pauseFor
                          ? "Pauses take effect immediately for new leads. Existing ownership never changes."
                          : "Link a team member for ownership, or enter contact details for a notification-only recipient."
                      }
                    >
                      <div className="flex flex-col gap-3">
                  {editingKey && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col gap-3 pt-4">
                      <p className="text-sm font-medium">
                        {editingKey === "__new__" ? "Add assignee" : "Edit assignee"}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1.5 sm:col-span-2">
                          <Label>Link team member (optional)</Label>
                          <SearchableSelect
                            value={form.user_id ?? ""}
                            options={[
                              { value: "", label: "External contact (no login)" },
                              ...rosterOptions,
                            ]}
                            onChange={(v) => linkMember(v)}
                            placeholder="External contact (no login)"
                            searchPlaceholder="Search team members…"
                            emptyText="No team members match."
                            ariaLabel="Link team member"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Display name</Label>
                          <Input
                            value={form.display_name}
                            onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                            placeholder="Priya Sharma"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Email {form.user_id ? "(optional — roster email is used)" : ""}</Label>
                          <Input
                            value={form.email}
                            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                            placeholder="priya@example.com"
                            inputMode="email"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Phone (with country code)</Label>
                          <Input
                            value={form.phone}
                            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                            placeholder="+911234567890"
                            inputMode="tel"
                          />
                        </div>
                      </div>
                      {form.user_id && (
                        <p className="text-muted-foreground text-xs">
                          Linked members take ownership in the Assigned To column. External
                          contacts receive notifications only — the lead stays Unassigned.
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={form.notify_email}
                            onCheckedChange={(v) => setForm((f) => ({ ...f, notify_email: v }))}
                          />
                          Email alerts
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={form.notify_whatsapp}
                            onCheckedChange={(v) => setForm((f) => ({ ...f, notify_whatsapp: v }))}
                          />
                          WhatsApp alerts
                        </label>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={confirmEdit}>
                          {editingKey === "__new__" ? "Add" : "Done"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {pauseFor &&
                  (() => {
                    const target = payload?.assignees.find((a) => a.id === pauseFor);
                    return (
                      <Card className="border-dashed">
                        <CardContent className="flex flex-col gap-3 pt-4">
                          <p className="text-sm font-medium">
                            {target ? `Pause ${target.display_name}` : "Pause assignee"}
                          </p>
                      {target?.paused_until ? (
                        <p className="text-muted-foreground text-xs">
                          Current: Paused until{" "}
                          {formatPausedUntilFull(target.paused_until, timezone)}
                          {target.pause_reason ? ` — ${target.pause_reason}` : ""} (
                          {target.pause_scope === "account" ? "whole account" : "this table"})
                        </p>
                      ) : null}
                          <div className="flex flex-wrap gap-2">
                            {(
                              [
                                ["today", "Pause for today"],
                                ["days", "Pause N days"],
                                ["until", "Pause until…"],
                                ["resume", "Resume now"],
                              ] as const
                            ).map(([value, label]) => (
                              <Button
                                key={value}
                                type="button"
                                variant={pauseMode === value ? "default" : "outline"}
                                size="sm"
                                onClick={() => setPauseMode(value)}
                              >
                                {label}
                              </Button>
                            ))}
                          </div>
                          {pauseMode === "days" && (
                            <div className="flex flex-col gap-1.5">
                              <Label>Days (1–365)</Label>
                              <Input
                                value={pauseDays}
                                inputMode="numeric"
                                className="w-28"
                                onChange={(e) =>
                                  setPauseDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))
                                }
                              />
                            </div>
                          )}
                          {pauseMode === "until" && (
                            <div className="flex flex-col gap-1.5">
                              <Label>Resume date and time</Label>
                              <Input
                                type="datetime-local"
                                value={pauseUntil}
                                onChange={(e) => setPauseUntil(e.target.value)}
                              />
                            </div>
                          )}
                          {pauseMode !== "resume" && (
                            <>
                              <div className="flex flex-col gap-1.5">
                                <Label>Reason (optional)</Label>
                                <Input
                                  value={pauseReason}
                                  onChange={(e) => setPauseReason(e.target.value)}
                                  placeholder="On leave"
                                  maxLength={280}
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant={pauseScope === "table" ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setPauseScope("table")}
                                >
                                  This table only
                                </Button>
                                <Button
                                  type="button"
                                  variant={pauseScope === "account" ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setPauseScope("account")}
                                >
                                  Whole account
                                </Button>
                              </div>
                            </>
                          )}
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setPauseFor(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy === "pause"}
                              onClick={submitPause}
                            >
                              {pauseMode === "resume" ? "Resume" : "Pause"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })()}
                    </div>
                  </ConfigSection>
                </section>
              )}

          <section aria-label="Alert deliveries">
            <Accordion
              value={showNotifications ? ["deliveries"] : []}
              onValueChange={(v: unknown) => {
                const open = Array.isArray(v) && v.includes("deliveries");
                setShowNotifications(open);
                if (open && notifications === null) void loadNotifications();
              }}
            >
              <AccordionItem value="deliveries" className="rounded-lg border border-border bg-card/50 px-3">
                <AccordionTrigger className="py-2.5 text-sm font-semibold hover:no-underline">
                  Recent alert deliveries
                  {notifications && notifications.length > 0 ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      · {notifications.length} shown
                    </span>
                  ) : null}
                </AccordionTrigger>
                <AccordionContent className="pb-3">
                  {!showNotifications && notifications === null ? (
                    <p className="text-xs text-muted-foreground">
                      Expand to load the latest email and WhatsApp delivery attempts for this
                      table, with per-row status and error details.
                    </p>
                  ) : notifications === null ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  ) : notifications.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No alerts sent yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Channel</TableHead>
                          <TableHead>To</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Detail</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {notifications.slice(0, 20).map((n) => (
                          <TableRow key={n.id}>
                            <TableCell className="text-xs">{n.channel}</TableCell>
                            <TableCell className="max-w-40 truncate text-xs">
                              {n.to_email || n.to_phone || "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={n.status === "sent" ? "default" : "secondary"}
                              >
                                {n.status}
                                {n.status === "failed" ? ` (try ${n.attempt})` : ""}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground max-w-64 truncate text-xs">
                              {n.status === "sent"
                                ? n.sent_at ?? ""
                                : (n.last_error ?? "retrying")}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>
        </div>
      )}
    </ConfigDialog>
  );
}

export function AssignmentButtonIcon() {
  return <UserPlus className="mr-1.5 size-4" />;
}
