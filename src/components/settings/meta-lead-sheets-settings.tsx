"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, RefreshCw, Table2, XCircle } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

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
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * Google Sheets Sync — Meta Lead Ads ONLY. Separate Google OAuth
 * connection (`meta_lead_sheets_connections`), separate config, and
 * a single worksheet for all enabled forms. Flow Tables sheets are
 * untouched. Requires the customer to connect their own Google
 * account with write access to the spreadsheet (never public).
 */
export function MetaLeadSheetsSettings() {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [spreadsheet, setSpreadsheet] = useState("");
  const [tab, setTab] = useState("Meta Leads");
  const [autoSync, setAutoSync] = useState(true);
  const [importExisting, setImportExisting] = useState(true);
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
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/sheets/config", { cache: "no-store" }),
      )) as unknown as SheetsStatus;
      setStatus(json);
      if (!prefilled.current) {
        prefilled.current = true;
        if (json.spreadsheetUrl ?? json.spreadsheetId) {
          setSpreadsheet((json.spreadsheetUrl ?? json.spreadsheetId ?? "") as string);
        }
        if (json.sheetTab) setTab(json.sheetTab);
        setAutoSync(json.autoSync);
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

  function save() {
    if (!spreadsheet.trim()) {
      toast.error("Paste a Google Sheets URL or spreadsheet ID.");
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
          }),
        }),
      )) as { ok: boolean; status: SheetsStatus; backfill?: { enqueued: number } | null };
      setStatus(json.status);
      prefilled.current = true;
      toast.success(
        json.backfill && json.backfill.enqueued > 0
          ? `Spreadsheet linked. Queued ${json.backfill.enqueued} existing leads.`
          : "Spreadsheet linked. New leads will sync automatically.",
      );
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

  const disabled = !canEditSettings || profileLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Table2 className="size-4" /> Google Sheets Sync
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Sync Meta Lead Ads Workspace leads to one Google Sheet automatically. Meta-only —
          Flow Tables are never synced here. Each lead maps to one row by its stable Meta
          Lead ID; edits update the same row. Headers (columns A–L) are managed by WhatsApp
          Max; add your own columns to the right of L.
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
                  Created if missing. All forms sync into this one tab.
                </p>
              </div>
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
                Save &amp; enable sync
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
