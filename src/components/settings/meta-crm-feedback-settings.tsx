"use client";

// Meta CRM Feedback — workspace configuration + event monitoring
// (Settings → Meta → CRM Integration).
//
// New, independent Instant Form CRM Integration UI. It does NOT
// inspect, reuse, or depend on the retired Conversions API
// (`meta-capi`), which remains untouched and hidden.
//
// Statuses shown here are honest workspace-side states only:
//   1. Dataset created (from the dataset registry below/above).
//   2. CRM feedback configured (enabled + verified here).
//   3. Event received by Meta (per-event sent state).
//   4. Lead matching / coverage under validation (Meta Events
//      Manager — WhatsApp Max never fabricates a coverage %).
//   5. Eligible for CRM conversion optimization (confirmed only in
//      Meta Ads Manager — never claimed from an API response).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { normalizePublicDatasets } from "@/lib/meta-crm/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface SavedDataset {
  id: string;
  datasetId: string;
  datasetName: string;
  businessPortfolioId: string;
}

interface FeedbackConfig {
  enabled: boolean;
  datasetId: string | null;
  businessPortfolioId: string | null;
  datasetName: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
}

interface CrmEvent {
  id: string;
  eventName: string;
  fromQuality: string;
  toQuality: string;
  eventTime: string;
  datasetId: string;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: string;
  sentAt: string | null;
  createdAt: string;
  leadName: string | null;
  tableName: string | null;
}

function friendlyError(payload: { error?: string; metaCode?: number; metaSubcode?: number }, status: number): string {
  if (typeof payload.error === "string" && payload.error.trim() !== "") {
    const suffix =
      typeof payload.metaCode === "number"
        ? ` (Meta code ${payload.metaCode}${typeof payload.metaSubcode === "number" ? `, subcode ${payload.metaSubcode}` : ""})`
        : "";
    return `${payload.error}${suffix}`;
  }
  return `Request failed (${status}). Try again.`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EVENT_LABEL: Record<string, string> = {
  Lead: "Lead",
  InterestedLead: "Interested Lead",
  QualifiedLead: "Qualified Lead",
  BookingConfirmed: "Booking Confirmed",
  DisqualifiedLead: "Disqualified Lead",
};

export function MetaCrmFeedbackSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [config, setConfig] = useState<FeedbackConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configMigrationMissing, setConfigMigrationMissing] = useState(false);
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState("");
  const [enableChecked, setEnableChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const [events, setEvents] = useState<CrmEvent[] | null>(null);
  const [counts, setCounts] = useState({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);

  const disabled = !canEditSettings || profileLoading;

  // Dataset registry loads INDEPENDENTLY of the feedback config.
  // A config failure (e.g. missing table, transient error) must
  // never blank the dropdown: every registered dataset — Created
  // and Registered alike — stays selectable.
  const loadDatasets = useCallback(async () => {
    setDatasetsLoading(true);
    setDatasetsError(null);
    try {
      const dsRes = await fetch("/api/integrations/meta-crm/datasets", { cache: "no-store" });
      const ds = (await dsRes.json().catch(() => ({}))) as {
        ok?: boolean;
        datasets?: unknown;
        error?: string;
      };
      if (!dsRes.ok || !ds.ok) {
        throw new Error(typeof ds.error === "string" && ds.error ? ds.error : `Could not load datasets (${dsRes.status}).`);
      }
      setDatasets(normalizePublicDatasets(ds.datasets));
    } catch (err) {
      setDatasetsError(err instanceof Error ? err.message : "Could not load CRM datasets.");
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  const loadConfigState = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const cfgRes = await fetch("/api/integrations/meta-crm/config", { cache: "no-store" });
      const cfg = (await cfgRes.json().catch(() => ({}))) as {
        ok?: boolean;
        config?: FeedbackConfig;
        migrationMissing?: boolean;
        error?: string;
      };
      if (!cfgRes.ok || !cfg.ok || !cfg.config) {
        throw new Error(typeof cfg.error === "string" && cfg.error ? cfg.error : `Could not load feedback config (${cfgRes.status}).`);
      }
      setConfig(cfg.config);
      setEnableChecked(cfg.config.enabled);
      setConfigMigrationMissing(cfg.migrationMissing === true);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Could not load CRM feedback.");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // Pre-select the saved dataset once both payloads arrive. Only
  // fills an untouched select — never overrides the user's choice.
  useEffect(() => {
    if (selectedDataset !== "" || !config?.datasetId || datasets.length === 0) return;
    const current = datasets.find((d) => d.datasetId === config.datasetId);
    if (current) setSelectedDataset(current.id);
  }, [config, datasets, selectedDataset]);

  useEffect(() => {
    void loadDatasets();
    void loadConfigState();
  }, [loadDatasets, loadConfigState]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const qs = new URLSearchParams({ limit: "25" });
      if (statusFilter) qs.set("status", statusFilter);
      const res = await fetch(`/api/integrations/meta-crm/events?${qs.toString()}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        events?: CrmEvent[];
        counts?: { pending: number; sent: number; failed: number; skipped: number };
        migrationMissing?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(typeof json.error === "string" && json.error ? json.error : `Could not load events (${res.status}).`);
      }
      setEvents(Array.isArray(json.events) ? json.events : []);
      if (json.counts) setCounts(json.counts);
      setMigrationMissing(json.migrationMissing === true);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : "Could not load CRM events.");
    } finally {
      setEventsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/meta-crm/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: enableChecked,
          datasetRowId: enableChecked ? selectedDataset || null : null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        ownershipVerified?: boolean;
        config?: FeedbackConfig;
        error?: string;
        metaCode?: number;
        metaSubcode?: number;
      };
      if (!res.ok || !json.ok || !json.config) {
        throw new Error(friendlyError(json, res.status));
      }
      setConfig(json.config);
      if (json.config.enabled) {
        toast.success(
          json.ownershipVerified
            ? "CRM feedback enabled — dataset verified."
            : "CRM feedback saved.",
        );
      } else {
        toast.success("CRM feedback disabled. Lead capture continues normally.");
      }
      void loadEvents();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save CRM feedback.");
      // Refresh server truth (e.g. failed verification disables).
      void loadConfigState();
    } finally {
      setSaving(false);
    }
  }

  async function handleRetry(eventId: string) {
    setRetryingId(eventId);
    try {
      const res = await fetch("/api/integrations/meta-crm/events/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(typeof json.error === "string" && json.error ? json.error : `Retry failed (${res.status}).`);
      }
      toast.success("Event requeued for delivery.");
      void loadEvents();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">CRM Feedback</CardTitle>
          <CardDescription className="text-muted-foreground">
            Send verified lead-quality outcomes to your Meta CRM dataset. Lead
            capture keeps working normally whether this is on or off.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {configLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading feedback configuration…
            </p>
          ) : configError && !config ? (
            <div className="space-y-2">
              <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" /> {configError}
              </p>
              <Button variant="outline" size="sm" onClick={() => void loadConfigState()}>
                <RefreshCw className="size-4" /> Retry
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">CRM feedback</p>
                  <p className="text-xs text-muted-foreground">
                    {config?.enabled ? "Enabled — quality changes send Meta events." : "Disabled — leads are captured without Meta events."}
                  </p>
                </div>
                <Switch
                  checked={enableChecked}
                  onCheckedChange={setEnableChecked}
                  disabled={disabled || saving || configMigrationMissing}
                  aria-label="Enable CRM feedback"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="meta-crm-feedback-dataset">Selected CRM dataset</Label>
                {datasetsLoading ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading datasets…
                  </p>
                ) : (
                  <Select
                    value={selectedDataset}
                    onValueChange={(v) => setSelectedDataset(v ?? "")}
                    disabled={disabled || saving || datasets.length === 0}
                  >
                    <SelectTrigger
                      id="meta-crm-feedback-dataset"
                      className="h-auto min-h-9 w-full py-2 *:data-[slot=select-value]:line-clamp-none"
                    >
                      <SelectValue placeholder={datasets.length === 0 ? "No datasets registered yet" : "Select a dataset"} />
                    </SelectTrigger>
                    <SelectContent className="w-max min-w-(--anchor-width) max-w-[calc(100vw-2rem)] [&_[data-slot=select-item-text]]:whitespace-normal [&_[data-slot=select-item-text]]:break-words">
                      {datasets.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.datasetName} · {d.datasetId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {datasetsError ? (
                  <p className="text-sm text-destructive">
                    {datasetsError}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void loadDatasets()}
                    >
                      Retry
                    </button>
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  One dataset per workspace. Both created and registered datasets are
                  listed here — register datasets in “Created CRM Datasets” above.
                </p>
              </div>

              {configMigrationMissing ? (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground">
                  CRM feedback settings are not available yet — apply migration{" "}
                  <code>175_meta_crm_feedback</code> to enable configuration and event
                  tracking. Dataset registration above is unaffected.
                </p>
              ) : null}

              {configError ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" /> {configError}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void loadConfigState()}
                  >
                    Retry
                  </button>
                </p>
              ) : null}

              {config?.lastError ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" /> {config.lastError}
                </p>
              ) : null}

              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <div className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Connection</p>
                  <p className="font-medium text-foreground">
                    {config?.enabled ? "Configured" : "Not configured"}
                  </p>
                </div>
                <div className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Verified</p>
                  <p className="font-medium text-foreground">
                    {config?.verifiedAt ? formatDateTime(config.verifiedAt) : "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Last event sent</p>
                  <p className="font-medium text-foreground">
                    {config?.lastEventAt ? formatDateTime(config.lastEventAt) : "No events sent yet"}
                  </p>
                </div>
              </div>

              <Button onClick={handleSave} disabled={disabled || saving || configMigrationMissing}>
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save CRM Feedback"
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-foreground">Event History</CardTitle>
              <CardDescription className="text-muted-foreground">
                Every quality transition WhatsApp Max queued for Meta — newest first.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "")}>
                <SelectTrigger className="w-36" aria-label="Filter by delivery status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="skipped">Skipped</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void loadEvents()} disabled={eventsLoading}>
                <RefreshCw className={`size-4 ${eventsLoading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Pending {counts.pending}</Badge>
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
              <CheckCircle2 className="mr-1 size-3" /> Sent {counts.sent}
            </Badge>
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Failed {counts.failed}
            </Badge>
            <Badge variant="outline">Skipped {counts.skipped}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {migrationMissing ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground">
              CRM feedback tables are not available yet — apply migration{" "}
              <code>175_meta_crm_feedback</code> to enable event tracking. Lead capture is unaffected.
            </p>
          ) : eventsLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading events…
            </p>
          ) : eventsError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{eventsError}</p>
              <Button variant="outline" size="sm" onClick={() => void loadEvents()}>
                <RefreshCw className="size-4" /> Retry
              </Button>
            </div>
          ) : !events || events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No CRM events yet. New Meta leads queue a Lead event automatically once feedback is
              enabled; quality changes queue their mapped event.
            </p>
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-foreground">
                      {EVENT_LABEL[e.eventName] ?? e.eventName}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {e.leadName ? `“${e.leadName}”` : "Lead"}
                        {e.tableName ? ` · ${e.tableName}` : ""}
                      </span>
                    </p>
                    <Badge
                      variant="outline"
                      className={
                        e.status === "sent"
                          ? "border-emerald-500/40 text-emerald-600"
                          : e.status === "failed"
                            ? "border-destructive/40 text-destructive"
                            : ""
                      }
                    >
                      {e.status}
                      {e.status === "pending" ? ` · try ${e.attempts + 1}/${e.maxAttempts}` : ""}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Event time {formatDateTime(e.eventTime)} · Dataset {e.datasetId}
                    {e.sentAt ? ` · Sent ${formatDateTime(e.sentAt)}` : ""}
                    {e.status === "pending" ? ` · Next try ${formatDateTime(e.nextRetryAt)}` : ""}
                  </p>
                  {e.lastError ? (
                    <p className="mt-1 text-xs text-destructive">{e.lastError}</p>
                  ) : null}
                  {(e.status === "failed" || e.status === "skipped") && canEditSettings ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={retryingId === e.id}
                      onClick={() => void handleRetry(e.id)}
                    >
                      <RotateCcw className="size-3" /> Retry delivery
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Integration status</p>
            <p>1. Dataset created — register it in “Created CRM Datasets”.</p>
            <p>2. CRM feedback configured — enabled and verified above.</p>
            <p>3. Event received by Meta — per-event “sent” state above (receipt only).</p>
            <p>4. Lead matching / coverage under validation — confirm in Meta Events Manager.</p>
            <p>5. Eligible for CRM conversion optimization — confirm in Meta Ads Manager; never assumed from an API response.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
