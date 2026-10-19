"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";

interface PageInfo {
  pageId: string;
  pageName: string | null;
  subscribed: boolean;
  webhookVerified: boolean;
  lastError: string | null;
  lastSyncedAt: string | null;
  lastPolledAt: string | null;
}

interface SetupPayload {
  configured: boolean;
  connected: boolean;
  datasetId: string | null;
  hasToken: boolean;
  tokenSource: "manual" | "capi" | null;
  status: string | null;
  lastError: string | null;
  updatedAt: string | null;
  page: PageInfo | null;
  pages: PageInfo[];
  capi: { datasetId: string | null; hasToken: boolean };
}

interface StatusPayload {
  configured: boolean;
  connected: boolean;
  status: string | null;
  account: {
    userName: string | null;
    status: string;
    datasetId: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
  pages: PageInfo[];
  formSummary: {
    total: number;
    enabled: number;
    importing: number;
    imported: number;
  };
  lastSuccessAt: string | null;
  capi: { datasetId: string | null; hasToken: boolean };
}

interface FormRow {
  id: string;
  pageId: string;
  formId: string;
  formName: string | null;
  status: string | null;
  locale: string | null;
  enabled: boolean;
  questionCount: number;
  importStatus: string;
  importedCount: number;
  lastSyncedAt: string | null;
  lastPolledAt: string | null;
  lastLeadAt: string | null;
  lastError: string | null;
}

interface ImportResult {
  imported: number;
  processed: number;
  failed: number;
  hasMore: boolean;
  error: string | null;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function importLabel(form: FormRow): string {
  if (form.importStatus === "importing") {
    return `Importing… ${form.importedCount} saved`;
  }
  if (form.importStatus === "error") {
    return form.lastError ? `Import paused · ${form.lastError}` : "Import paused";
  }
  if (form.importedCount > 0) {
    return `Imported ${form.importedCount} existing lead${
      form.importedCount === 1 ? "" : "s"
    }`;
  }
  return "No leads imported yet";
}

function pageLabel(page: PageInfo): string {
  return page.pageName ?? page.pageId;
}

export function MetaLeadAdsSettings({
  embedded = false,
}: {
  /** When rendered inside the Meta tabbed wrapper, the wrapper owns the head. */
  embedded?: boolean;
} = {}) {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [forms, setForms] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const [datasetId, setDatasetId] = useState("");
  const [pageId, setPageId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
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
      const [s, c] = await Promise.all([
        readJson(
          await fetch("/api/integrations/meta-lead-ads/status", { cache: "no-store" }),
        ),
        readJson(
          await fetch("/api/integrations/meta-lead-ads/credentials", {
            cache: "no-store",
          }),
        ),
      ]);
      const nextStatus = s as unknown as StatusPayload;
      const nextSetup = c as unknown as SetupPayload;
      setStatus(nextStatus);
      setSetup(nextSetup);

      if (!prefilled.current) {
        prefilled.current = true;
        setDatasetId(nextSetup.datasetId ?? "");
        setPageId(nextSetup.page?.pageId ?? "");
      }

      if (nextStatus.connected) {
        const f = (await readJson(
          await fetch("/api/integrations/meta-lead-ads/forms", { cache: "no-store" }),
        )) as { forms: FormRow[] };
        setForms(f.forms ?? []);
      } else {
        setForms([]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Meta Lead Ads.");
    } finally {
      setLoading(false);
    }
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

  function saveSetup() {
    void act("save", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dataset_id: datasetId.trim(),
            page_id: pageId.trim(),
            ...(token.trim() !== "" ? { access_token: token.trim() } : {}),
          }),
        }),
      )) as {
        ok?: boolean;
        checks?: Check[];
        page?: { warning?: string | null };
        tokenSource?: string;
      };
      if (json.checks) setChecks(json.checks);
      const failed = (json.checks ?? []).filter((c) => !c.ok);
      if (failed.length > 0) {
        toast.error(
          `Saved, but ${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed
            .map((c) => c.name)
            .join(", ")}.`,
          { description: failed[0]?.detail },
        );
      } else {
        toast.success("Meta setup saved and verified.");
      }
      if (json.page?.warning) {
        toast("Meta was saved, but the webhook could not be subscribed. Polling will still import new leads.", {
          description: json.page.warning,
        });
      }
      setToken("");
      setShowToken(false);
      await load();
    });
  }

  function loadForms() {
    const targetPage = setup?.page?.pageId ?? pageId.trim();
    if (!targetPage) {
      toast.error("Save a Page ID first.");
      return;
    }
    void act("load-forms", async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/forms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page_id: targetPage }),
        }),
      );
      toast.success("Forms loaded from Meta.");
      await load();
    });
  }

  function importLeads(form: FormRow) {
    void act(`import:${form.formId}`, async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/forms/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ form_id: form.formId }),
        }),
      )) as { import: ImportResult };
      const result = json.import;
      if (result.error) {
        toast.error(`Import paused: ${result.error}`);
      } else {
        toast.success(
          result.imported > 0
            ? `Imported ${result.imported} existing lead${result.imported === 1 ? "" : "s"}.`
            : "No new leads to import.",
        );
        if (result.hasMore) {
          toast("The import is large — it continues in the background.");
        }
      }
      await load();
    });
  }

  function toggleForm(form: FormRow, enabled: boolean) {
    void act(`form:${form.formId}`, async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/forms", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ form_id: form.formId, enabled }),
        }),
      )) as { import?: ImportResult | null };
      if (!enabled) {
        toast.success("Form disabled.");
      } else {
        const imported = json.import?.imported ?? 0;
        toast.success(
          imported > 0
            ? `Form enabled. Imported ${imported} existing lead${imported === 1 ? "" : "s"}.`
            : "Form enabled.",
        );
        if (json.import?.hasMore) {
          toast("Existing leads are still importing in the background.");
        }
        if (json.import?.error) {
          toast.error(`Historical import paused: ${json.import.error}`);
        }
      }
      await load();
    });
  }

  function disconnect() {
    if (
      !window.confirm(
        "Disconnect Meta? Existing leads stay; no new leads will sync.",
      )
    ) {
      return;
    }
    void act("disconnect", async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/disconnect", { method: "POST" }),
      );
      toast.success("Meta disconnected.");
      setToken("");
      await load();
    });
  }

  function runTest() {
    void act("test", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/test", { method: "POST" }),
      )) as { checks: Check[] };
      setChecks(json.checks ?? []);
    });
  }

  const disabled = !canEditSettings || profileLoading;
  const connected = Boolean(status?.connected && status.status !== "needs_reauth");
  const needsReauth = status?.status === "needs_reauth";
  const page = setup?.page ?? status?.pages[0] ?? null;
  const canReuseToken = Boolean(
    setup?.hasToken && setup.tokenSource === "capi" && !token.trim(),
  );

  return (
    <section className="space-y-5">
      {embedded ? null : (
        <SettingsPanelHead
          title="Meta Lead Ads"
          description="Connect a Facebook Page and choose which Instant Forms feed leads into your Workspace. Each enabled form appears as its own Workspace table."
          action={
            connected ? (
              <Button variant="outline" onClick={runTest} disabled={busy === "test"}>
                {busy === "test" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Run diagnostics
              </Button>
            ) : undefined
          }
        />
      )}

      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </CardContent>
        </Card>
      ) : !status?.configured ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <AlertCircle className="size-4 text-destructive" /> Not configured
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              This server is missing the Meta Lead Ads environment variables. Ask
              your administrator to set them (see <code>docs/meta-lead-ads.md</code>).
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {needsReauth ? (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-foreground">
                  <AlertCircle className="size-4 text-destructive" /> Token needs attention
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  Meta rejected the stored token. Paste a new System User token below to
                  resume syncing. Existing leads are not affected.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                {connected ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <KeyRound className="size-4 text-muted-foreground" />
                )}
                Meta setup
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                No Facebook login needed. In Meta Business Settings, create a System
                User, assign the Page and your dataset, then generate a token. Paste
                the three values below once — they are encrypted and never shown to
                the browser again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {connected ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">Connected</Badge>
                  {page ? (
                    <Badge variant="outline">
                      {page.pageName ?? page.pageId}
                    </Badge>
                  ) : null}
                  {page?.webhookVerified ? (
                    <Badge variant="secondary">Webhook subscribed</Badge>
                  ) : page ? (
                    <Badge variant="outline">Polling fallback</Badge>
                  ) : null}
                  <span className="text-muted-foreground">
                    Last lead: {fmt(status?.lastSuccessAt ?? null)}
                  </span>
                  {status?.account?.lastError ? (
                    <span className="text-destructive">{status.account.lastError}</span>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="meta-dataset">Dataset / Pixel ID</Label>
                  <Input
                    id="meta-dataset"
                    inputMode="numeric"
                    placeholder="e.g. 1234567890"
                    value={datasetId}
                    onChange={(e) => setDatasetId(e.target.value)}
                    disabled={disabled}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Events Manager → Data sources → your dataset.
                  </p>
                </div>
                <div>
                  <Label htmlFor="meta-page">Facebook Page ID</Label>
                  <Input
                    id="meta-page"
                    inputMode="numeric"
                    placeholder="e.g. 1029384756"
                    value={pageId}
                    onChange={(e) => setPageId(e.target.value)}
                    disabled={disabled}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    The numeric Page ID, not the Page username.
                  </p>
                </div>
              </div>

              <div>
                <Label htmlFor="meta-token">System User access token</Label>
                <div className="relative">
                  <Input
                    id="meta-token"
                    type={showToken ? "text" : "password"}
                    autoComplete="off"
                    className="pr-10"
                    placeholder={
                      canReuseToken
                        ? "Using the token saved in Conversions API"
                        : setup?.hasToken
                          ? "•••••••• (stored — leave blank to keep)"
                          : "Paste the long-lived token"
                    }
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={disabled}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowToken((v) => !v)}
                    aria-label={showToken ? "Hide token" : "Show token"}
                    disabled={disabled}
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Needs <code>leads_retrieval</code>,{" "}
                  <code>pages_read_engagement</code> and{" "}
                  <code>pages_manage_metadata</code> (for the webhook). Without the
                  webhook permission, leads still arrive through polling.
                  {setup?.capi.hasToken && !setup.hasToken ? (
                    <> A token saved in Conversions API can be reused by leaving this blank.</>
                  ) : null}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={saveSetup}
                  disabled={
                    disabled ||
                    busy === "save" ||
                    datasetId.trim() === "" ||
                    pageId.trim() === ""
                  }
                >
                  {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save &amp; verify
                </Button>
                {connected ? (
                  <Button
                    variant="outline"
                    onClick={disconnect}
                    disabled={disabled || busy === "disconnect"}
                  >
                    {busy === "disconnect" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <XCircle className="size-4" />
                    )}
                    Disconnect
                  </Button>
                ) : null}
                {connected ? (
                  <Button variant="outline" onClick={runTest} disabled={disabled || busy === "test"}>
                    {busy === "test" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Run diagnostics
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {connected ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-foreground">
                    <span>Instant Forms</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadForms}
                      disabled={disabled || busy === "load-forms"}
                    >
                      {busy === "load-forms" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      Load My Forms
                    </Button>
                  </CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Load the forms for{" "}
                    {page ? pageLabel(page) : "your Page"}. Enabling a form publishes
                    it as a Workspace table and imports the leads Meta already has.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {forms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No forms loaded yet — click Load My Forms.
                    </p>
                  ) : (
                    forms.map((form) => (
                      <div
                        key={form.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {form.formName ?? form.formId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {form.questionCount} question
                            {form.questionCount === 1 ? "" : "s"}
                            {form.status ? ` · ${form.status}` : ""}
                            {` · ${importLabel(form)}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Last lead: {fmt(form.lastLeadAt)} · Last checked:{" "}
                            {fmt(form.lastPolledAt)}
                          </p>
                          {form.lastError ? (
                            <p className="text-xs text-destructive">{form.lastError}</p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {form.enabled ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => importLeads(form)}
                              disabled={
                                disabled || busy === `import:${form.formId}`
                              }
                            >
                              {busy === `import:${form.formId}` ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Download className="size-4" />
                              )}
                              Import leads
                            </Button>
                          ) : null}
                          {busy === `form:${form.formId}` ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          ) : null}
                          <Switch
                            checked={form.enabled}
                            onCheckedChange={(v) => toggleForm(form, v)}
                            disabled={disabled || busy === `form:${form.formId}`}
                            aria-label={`Enable ${form.formName ?? form.formId}`}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-foreground">Sync</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    New leads arrive through the Page webhook when it is subscribed.
                    The cron also polls enabled forms every few minutes, so lead
                    capture keeps working even if Meta refuses the subscription.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>
                    {status?.formSummary.enabled ?? 0}/{status?.formSummary.total ?? 0}{" "}
                    forms enabled
                  </span>
                  <span>
                    {status?.formSummary.importing ?? 0} importing ·{" "}
                    {status?.formSummary.imported ?? 0} historical leads
                  </span>
                  <span>
                    Page last checked: {fmt(page?.lastPolledAt ?? null)}
                  </span>
                </CardContent>
              </Card>
            </>
          ) : null}

          {checks ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">Diagnostics</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Configuration, token, Page access and webhook checks. This does not
                  prove a live lead was received — submit a test lead to confirm.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {checks.map((c) => (
                  <div key={c.name} className="flex items-start gap-2 text-sm">
                    {c.ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <div>
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span className="text-muted-foreground"> — {c.detail}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </section>
  );
}
