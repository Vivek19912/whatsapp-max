"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  XCircle,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface SheetsColumn {
  key: string;
  label: string;
}

interface SheetsStatus {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  email: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  sheetTab: string | null;
  autoSync: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  failed: number;
  formIds: string[] | null;
  columns: SheetsColumn[] | null;
  remapPending: boolean;
  cleanupPreview: { deselectedMappedRows: number };
}

interface FormOption {
  id: string;
  form_id: string;
  form_name: string | null;
  page_id: string;
  page_name: string;
  enabled: boolean;
  question_count: number;
  questions: Array<{ key: string; label: string }>;
}

interface DynamicOption {
  key: string;
  label: string;
  formNames: string[];
}

interface FieldsPayload {
  forms: FormOption[];
  standard: SheetsColumn[];
  dynamic: DynamicOption[];
  selected: { form_ids: string[] | null; columns: SheetsColumn[] | null };
}

const DEFAULT_COLUMNS: SheetsColumn[] = [
  { key: "meta_lead_id", label: "Meta Lead ID" },
  { key: "submitted_at", label: "Submitted At" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "form_name", label: "Form Name" },
  { key: "campaign_name", label: "Campaign" },
  { key: "ad_name", label: "Ad" },
  { key: "source", label: "Source" },
  { key: "assignee", label: "Assigned To" },
  { key: "lead_type", label: "Lead Type" },
  { key: "stage", label: "Stage" },
];

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Desired header preview: Meta Lead ID always pinned to column A. */
function previewHeaders(columns: SheetsColumn[]): string[] {
  const id = columns.find((c) => c.key === "meta_lead_id");
  const rest = columns.filter((c) => c.key !== "meta_lead_id");
  return [id ? id.label : "Meta Lead ID", ...rest.map((c) => c.label)];
}

/**
 * Google Sheets Sync — Meta Lead Ads ONLY. Separate Google OAuth
 * connection (`meta_lead_sheets_connections`), separate config, and
 * a single worksheet for the SELECTED forms. Flow Tables sheets are
 * untouched. Requires the customer to connect their own Google
 * account with write access to the spreadsheet (never public).
 */
export function MetaLeadSheetsSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [fields, setFields] = useState<FieldsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [spreadsheet, setSpreadsheet] = useState("");
  const [tab, setTab] = useState("Meta Leads");
  const [autoSync, setAutoSync] = useState(true);
  const [importExisting, setImportExisting] = useState(true);
  const [selectedForms, setSelectedForms] = useState<string[] | null>(null);
  const [columns, setColumns] = useState<SheetsColumn[] | null>(null);
  const prefilled = useRef(false);

  const readJson = async (res: Response) => {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof json.error === "string" ? json.error : `Request failed (${res.status})`,
      );
    }
    return json;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, f] = await Promise.all([
        readJson(
          await fetch("/api/integrations/meta-lead-ads/sheets/config", { cache: "no-store" }),
        ) as Promise<unknown> as Promise<SheetsStatus>,
        readJson(
          await fetch("/api/integrations/meta-lead-ads/sheets/fields", { cache: "no-store" }),
        ).catch(() => null) as Promise<FieldsPayload | null>,
      ]);
      setStatus(s);
      if (f) setFields(f);
      if (!prefilled.current) {
        prefilled.current = true;
        if (s.spreadsheetUrl ?? s.spreadsheetId) {
          setSpreadsheet((s.spreadsheetUrl ?? s.spreadsheetId ?? "") as string);
        }
        if (s.sheetTab) setTab(s.sheetTab);
        setAutoSync(s.autoSync);
        // Legacy configs (null) prefill every ENABLED form to preserve
        // current behavior; saving makes the selection explicit.
        setSelectedForms(
          s.formIds ?? (f?.forms ?? []).filter((form) => form.enabled).map((form) => form.form_id),
        );
        setColumns(s.columns ?? DEFAULT_COLUMNS);
      }
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        if (params.get("meta_sheets") === "connected") {
          toast.success("Google account connected. Select a spreadsheet to sync.");
        } else if (params.get("meta_sheets") === "error") {
          toast.error(`Google authorization failed (${params.get("reason") ?? "unknown"}).`);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Sheets sync.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const selectedSet = new Set(selectedForms ?? []);
  const columnKeys = new Set((columns ?? []).map((c) => c.key));

  function toggleForm(formId: string) {
    setSelectedForms((current) => {
      const next = new Set(current ?? []);
      if (next.has(formId)) next.delete(formId);
      else next.add(formId);
      return [...next];
    });
  }

  function addColumn(col: SheetsColumn) {
    setColumns((current) => {
      const next = [...(current ?? [])];
      if (next.some((c) => c.key === col.key)) return next;
      next.push({ ...col });
      return next;
    });
  }

  function removeColumn(key: string) {
    setColumns((current) => (current ?? []).filter((c) => c.key !== key));
  }

  function moveColumn(key: string, direction: -1 | 1) {
    setColumns((current) => {
      const next = [...(current ?? [])];
      const idx = next.findIndex((c) => c.key === key);
      const swap = idx + direction;
      if (idx < 0 || swap < 0 || swap >= next.length) return next;
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      return next;
    });
  }

  function renameColumn(key: string, label: string) {
    setColumns((current) =>
      (current ?? []).map((c) => (c.key === key ? { ...c, label } : c)),
    );
  }

  function save() {
    if (!spreadsheet.trim()) {
      toast.error("Paste a Google Sheets URL or spreadsheet ID.");
      return;
    }
    if (!columns || columns.length === 0) {
      toast.error("Select at least one spreadsheet column.");
      return;
    }
    void act("save", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/sheets/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            spreadsheet_url: spreadsheet.trim(),
            sheet_tab: tab.trim() || "Meta Leads",
            auto_sync: autoSync,
            import_existing: importExisting,
            form_ids: selectedForms ?? [],
            columns,
          }),
        }),
      )) as {
        ok: boolean;
        status: SheetsStatus;
        backfill?: { enqueued: number } | null;
        delta?: { enqueued: number } | null;
        reseeded?: number | null;
        remap?: { done: boolean; remapped: number; skipped: number } | null;
      };
      setStatus(json.status);
      prefilled.current = true;
      const parts: string[] = [];
      if (json.backfill && json.backfill.enqueued > 0) {
        parts.push(`queued ${json.backfill.enqueued} existing leads`);
      }
      if (json.delta && json.delta.enqueued > 0) {
        parts.push(`queued ${json.delta.enqueued} leads from newly selected forms`);
      }
      if (typeof json.reseeded === "number" && json.reseeded > 0) {
        parts.push(`reseeded ${json.reseeded} leads into the new spreadsheet`);
      }
      if (json.remap && !json.remap.done) {
        parts.push("column rollout continues automatically");
      } else if (json.remap && json.remap.remapped > 0) {
        parts.push(`rewrote ${json.remap.remapped} existing rows to the new columns`);
      }
      toast.success(
        parts.length > 0
          ? `Configuration saved (${parts.join("; ")}).`
          : "Configuration saved. New and updated leads will sync automatically.",
      );
      await load();
    });
  }

  function syncNow() {
    void act("retry", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/sheets/retry", { method: "POST" }),
      )) as { sent: number; failed: number };
      toast.success(`Sync pass finished: ${json.sent} sent, ${json.failed} failed.`);
      await load();
    });
  }

  function disconnect() {
    if (!window.confirm("Disconnect Google Sheets? No new leads will sync. Sheet contents stay.")) {
      return;
    }
    void act("disconnect", async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/google/disconnect", { method: "POST" }),
      );
      toast.success("Google Sheets disconnected.");
      await load();
    });
  }

  function cleanupDeselected() {
    const n = status?.cleanupPreview.deselectedMappedRows ?? 0;
    if (n === 0) {
      toast("No rows from deselected forms remain in the sheet.");
      return;
    }
    if (
      !window.confirm(
        `Delete ${n} spreadsheet row${n === 1 ? "" : "s"} belonging to deselected forms? ` +
          "Only rows WhatsApp Max previously wrote (verified by stable lead ID) are removed. " +
          "Your own content is never touched.",
      )
    ) {
      return;
    }
    void act("cleanup", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/sheets/cleanup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        }),
      )) as { ok: boolean; removed: number; skippedUnmapped: number };
      toast.success(
        `Removed ${json.removed} row${json.removed === 1 ? "" : "s"} from deselected forms.` +
          (json.skippedUnmapped > 0
            ? ` ${json.skippedUnmapped} row(s) without a verified mapping were left alone.`
            : ""),
      );
      await load();
    });
  }

  const disabled = !canEditSettings || profileLoading;
  const headers = previewHeaders(columns ?? DEFAULT_COLUMNS);
  const deselectedCount = status?.cleanupPreview.deselectedMappedRows ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Table2 className="size-4" /> Google Sheets Sync
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Sync Meta Lead Ads Workspace leads to one Google Sheet automatically. Meta-only —
          Flow Tables are never synced here. Each lead maps to one row by its stable Meta
          Lead ID (always column A, hidden unless selected); edits update the same row.
          Headers are managed by WhatsApp Max; add your own columns to the right of the
          managed range.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : !status?.configured ? (
          <p className="text-sm text-muted-foreground">
            The server is missing Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
            Ask your administrator to set them.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {status.connected ? (
                <Badge variant="secondary">
                  <CheckCircle2 className="mr-1 size-3" /> {status.email ?? "Connected"}
                </Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
              {status.needsReauth ? (
                <Badge variant="destructive">Needs reconnect</Badge>
              ) : null}
              {status.spreadsheetId ? (
                <Badge variant="outline">Sheet linked</Badge>
              ) : null}
              {status.remapPending ? (
                <Badge variant="outline">Column rollout in progress</Badge>
              ) : null}
              <span className="text-muted-foreground">
                Last success: {fmt(status.lastSuccessAt)} · Pending: {status.pending} ·
                Failed: {status.failed}
              </span>
            </div>
            {status.lastError ? (
              <p className="flex items-start gap-2 text-xs text-destructive">
                <XCircle className="mt-0.5 size-3.5 shrink-0" /> {status.lastError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {!status.connected ? (
                <Button
                  onClick={() => {
                    window.location.href = "/api/integrations/meta-lead-ads/google/connect";
                  }}
                  disabled={disabled}
                >
                  Connect Google account
                </Button>
              ) : (
                <Button variant="outline" onClick={disconnect} disabled={disabled || busy === "disconnect"}>
                  {busy === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Disconnect
                </Button>
              )}
              {status.connected && status.spreadsheetUrl ? (
                <a
                  href={status.spreadsheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted-foreground underline"
                >
                  Open spreadsheet
                </a>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="meta-sheets-url">Spreadsheet URL or ID</Label>
                <Input
                  id="meta-sheets-url"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={spreadsheet}
                  onChange={(e) => setSpreadsheet(e.target.value)}
                  disabled={disabled || !status.connected}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Your Google account needs Editor access. The sheet stays private.
                </p>
              </div>
              <div>
                <Label htmlFor="meta-sheets-tab">Worksheet tab</Label>
                <Input
                  id="meta-sheets-tab"
                  placeholder="Meta Leads"
                  value={tab}
                  onChange={(e) => setTab(e.target.value)}
                  disabled={disabled || !status.connected}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Created if missing. Selected forms sync into this one tab.
                </p>
              </div>
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <Label className="text-sm font-medium">Meta Forms to Sync</Label>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !status.connected || !fields}
                    onClick={() =>
                      setSelectedForms((fields?.forms ?? []).map((f) => f.form_id))
                    }
                  >
                    Select All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !status.connected}
                    onClick={() => setSelectedForms([])}
                  >
                    Clear All
                  </Button>
                </div>
              </div>
              {!fields ? (
                <p className="text-xs text-muted-foreground">Loading forms…</p>
              ) : fields.forms.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No Instant Forms loaded yet — enable forms in the Instant Forms section above first.
                </p>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
                  {fields.forms.map((form) => (
                    <label
                      key={form.form_id}
                      className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedSet.has(form.form_id)}
                        onChange={() => toggleForm(form.form_id)}
                        disabled={disabled || !status.connected}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {form.form_name ?? form.form_id}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {form.page_name} · {form.question_count} question
                          {form.question_count === 1 ? "" : "s"} ·{" "}
                          {form.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {selectedForms !== null && selectedForms.length === 0 ? (
                <p className="mt-1 text-xs text-destructive">
                  No forms selected — nothing will synchronize until you select at least one form.
                </p>
              ) : null}
            </div>

            <div>
              <Label className="mb-2 block text-sm font-medium">Choose Spreadsheet Columns</Label>
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Selected columns (in sheet order)
                  </p>
                  {(columns ?? []).length === 0 ? (
                    <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                      No columns selected — add columns from the available list.
                    </p>
                  ) : (
                    <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
                      {(columns ?? []).map((col, idx) => (
                        <div
                          key={col.key}
                          className="flex items-center gap-1.5 rounded bg-muted/50 px-2 py-1.5"
                        >
                          <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
                            {col.key === "meta_lead_id" ? "A" : idx + 1}
                          </span>
                          <Input
                            value={col.label}
                            onChange={(e) => renameColumn(col.key, e.target.value)}
                            disabled={disabled || !status.connected}
                            className="h-7 text-xs"
                            aria-label={`Label for ${col.key}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled || idx === 0}
                            onClick={() => moveColumn(col.key, -1)}
                            aria-label="Move up"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled || idx === (columns?.length ?? 0) - 1}
                            onClick={() => moveColumn(col.key, 1)}
                            aria-label="Move down"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            onClick={() => removeColumn(col.key)}
                            aria-label="Remove column"
                          >
                            <Minus className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Available columns</p>
                  <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-border p-2">
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        Standard lead fields
                      </p>
                      {(fields?.standard ?? DEFAULT_COLUMNS)
                        .filter((s) => !columnKeys.has(s.key))
                        .map((s) => (
                          <button
                            key={s.key}
                            type="button"
                            disabled={disabled || !status.connected}
                            onClick={() => addColumn(s)}
                            className="mr-1.5 mb-1.5 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            <Plus className="size-3" /> {s.label}
                          </button>
                        ))}
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        Form answers
                      </p>
                      {!fields || fields.dynamic.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Answer fields appear here once forms are loaded.
                        </p>
                      ) : (
                        fields.dynamic
                          .filter((d) => !columnKeys.has(d.key))
                          .map((d) => (
                            <button
                              key={d.key}
                              type="button"
                              disabled={disabled || !status.connected}
                              onClick={() => addColumn({ key: d.key, label: d.label })}
                              className="mr-1.5 mb-1.5 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                              title={d.formNames.join(", ")}
                            >
                              <Plus className="size-3" /> {d.label}
                              <span className="text-muted-foreground">({d.formNames.join(", ")})</span>
                            </button>
                          ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Header preview</p>
                <p className="mt-0.5 break-words">{headers.join(" · ")}</p>
                <p className="mt-1.5">
                  Meta Lead ID is always pinned to column A (hidden unless selected) so rows stay
                  matched even when reordered or relabeled. Saving new columns rewrites existing
                  integration-managed rows to the new layout; nothing else in the sheet is touched.
                  {deselectedCount > 0
                    ? ` ${deselectedCount} row${deselectedCount === 1 ? "" : "s"} from deselected forms remain${deselectedCount === 1 ? "s" : ""} in the sheet until explicitly cleaned up below.`
                    : " All sheet rows currently belong to the selected forms."}
                </p>
              </div>
              {deselectedCount > 0 ? (
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={cleanupDeselected}
                    disabled={disabled || busy === "cleanup" || !status.connected}
                  >
                    {busy === "cleanup" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    Remove {deselectedCount} row{deselectedCount === 1 ? "" : "s"} from deselected
                    forms
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Switch
                  checked={autoSync}
                  onCheckedChange={setAutoSync}
                  disabled={disabled || !status.connected}
                  aria-label="Enable automatic sync"
                />
                Automatic sync for new + updated leads
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={importExisting}
                  onChange={(e) => setImportExisting(e.target.checked)}
                  disabled={disabled || !status.connected}
                />
                Import existing leads on save
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={disabled || busy === "save" || !status.connected}>
                {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
                Save Configuration
              </Button>
              <Button variant="outline" onClick={syncNow} disabled={disabled || busy === "retry"}>
                {busy === "retry" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Sync now
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
