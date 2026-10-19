"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { SettingsPanelHead } from "./settings-panel-head";

interface StatusPayload {
  configured: boolean;
  connected: boolean;
  account: {
    userName: string | null;
    status: string;
    scopes: string[];
    tokenExpiry: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
  pages: Array<{ pageId: string; pageName: string | null }>;
  formSummary: { total: number; enabled: number };
  lastSuccessAt: string | null;
}

interface PageRow {
  pageId: string;
  pageName: string | null;
  selected: boolean;
  subscribed: boolean;
  webhookVerified: boolean;
  lastError: string | null;
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
  lastSyncedAt: string | null;
  lastError: string | null;
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

export function MetaLeadAdsSettings({
  embedded = false,
}: {
  /** When rendered inside the Meta tabbed wrapper, the wrapper owns the head. */
  embedded?: boolean;
} = {}) {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [forms, setForms] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const notified = useRef(false);

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
    setPagesError(null);
    try {
      const s = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/status", { cache: "no-store" }),
      )) as unknown as StatusPayload;
      setStatus(s);
      if (s.connected) {
        const p = (await readJson(
          await fetch("/api/integrations/meta-lead-ads/pages", { cache: "no-store" }),
        )) as { pages: PageRow[]; error: { message: string } | null };
        setPages(p.pages ?? []);
        if (p.error) setPagesError(p.error.message);
        const f = (await readJson(
          await fetch("/api/integrations/meta-lead-ads/forms", { cache: "no-store" }),
        )) as { forms: FormRow[] };
        setForms(f.forms ?? []);
      } else {
        setPages([]);
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

  // Surface the OAuth redirect result once.
  useEffect(() => {
    if (notified.current) return;
    notified.current = true;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("meta");
    if (result === "connected") toast.success("Meta account connected.");
    if (result === "error") {
      toast.error(`Meta connection failed (${params.get("reason") ?? "unknown"}).`);
    }
  }, []);

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

  function connect() {
    window.location.href = "/api/integrations/meta-lead-ads/connect";
  }

  function disconnectAccount() {
    if (!window.confirm("Disconnect Meta? Existing leads stay; no new leads will sync.")) {
      return;
    }
    void act("disconnect", async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/disconnect", { method: "POST" }),
      );
      toast.success("Meta disconnected.");
      await load();
    });
  }

  function togglePage(page: PageRow) {
    void act(`page:${page.pageId}`, async () => {
      if (page.selected) {
        await readJson(
          await fetch(
            `/api/integrations/meta-lead-ads/pages?page_id=${encodeURIComponent(page.pageId)}`,
            { method: "DELETE" },
          ),
        );
        toast.success(`${page.pageName ?? page.pageId} removed.`);
      } else {
        await readJson(
          await fetch("/api/integrations/meta-lead-ads/pages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page_id: page.pageId }),
          }),
        );
        toast.success(`${page.pageName ?? page.pageId} connected.`);
      }
      await load();
    });
  }

  function syncForms(pageId: string) {
    void act(`sync:${pageId}`, async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/forms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page_id: pageId }),
        }),
      );
      toast.success("Forms synced from Meta.");
      await load();
    });
  }

  function toggleForm(form: FormRow, enabled: boolean) {
    void act(`form:${form.formId}`, async () => {
      await readJson(
        await fetch("/api/integrations/meta-lead-ads/forms", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ form_id: form.formId, enabled }),
        }),
      );
      toast.success(enabled ? "Form enabled." : "Form disabled.");
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
  const selectedPages = pages.filter((p) => p.selected);

  return (
    <section className="space-y-5">
      {embedded ? null : (
        <SettingsPanelHead
          title="Meta Lead Ads"
          description="Connect Facebook Pages and choose which Instant Forms feed leads into your Workspace. Each enabled form appears as its own Workspace table."
          action={
            status?.connected ? (
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
      ) : !status.connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Connect Meta</CardTitle>
            <CardDescription className="text-muted-foreground">
              Authorize the app to read your Pages&apos; Instant Forms and receive
              lead notifications. You&apos;ll be redirected to Meta to grant access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={connect} disabled={disabled}>
              Connect Meta account
            </Button>
            {!canEditSettings && !profileLoading && (
              <p className="mt-2 text-xs text-muted-foreground">
                Only account admins can connect integrations.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <CheckCircle2 className="size-4 text-primary" /> Connected
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {status.account?.userName ?? "Meta user"} · status{" "}
                <Badge variant={status.account?.status === "connected" ? "secondary" : "destructive"}>
                  {status.account?.status ?? "unknown"}
                </Badge>
                {status.account?.tokenExpiry
                  ? ` · token expires ${fmt(status.account.tokenExpiry)}`
                  : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={disconnectAccount} disabled={disabled || busy === "disconnect"}>
                {busy === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                Disconnect
              </Button>
              <span className="text-xs text-muted-foreground">
                Last lead synced: {fmt(status.lastSuccessAt)} · {status.formSummary.enabled}/
                {status.formSummary.total} forms enabled
              </span>
              {status.account?.lastError ? (
                <span className="text-xs text-destructive">{status.account.lastError}</span>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Facebook Pages</CardTitle>
              <CardDescription className="text-muted-foreground">
                Select the Pages whose forms you want to capture. Selecting a Page
                subscribes the app to its lead webhook.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pagesError ? (
                <p className="text-xs text-destructive">{pagesError}</p>
              ) : null}
              {pages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Pages available.</p>
              ) : (
                pages.map((page) => (
                  <div
                    key={page.pageId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {page.pageName ?? page.pageId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {page.pageId}
                        {page.selected
                          ? page.webhookVerified
                            ? " · webhook verified"
                            : " · webhook not verified"
                          : ""}
                        {page.lastError ? ` · ${page.lastError}` : ""}
                      </p>
                    </div>
                    <Button
                      variant={page.selected ? "outline" : "default"}
                      size="sm"
                      onClick={() => togglePage(page)}
                      disabled={disabled || busy === `page:${page.pageId}`}
                    >
                      {busy === `page:${page.pageId}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {page.selected ? "Remove" : "Connect"}
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {selectedPages.map((page) => {
            const pageForms = forms.filter((f) => f.pageId === page.pageId);
            return (
              <Card key={page.pageId}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 text-foreground">
                    <span className="truncate">
                      Forms · {page.pageName ?? page.pageId}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => syncForms(page.pageId)}
                      disabled={disabled || busy === `sync:${page.pageId}`}
                    >
                      {busy === `sync:${page.pageId}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Sync
                    </Button>
                  </CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Enable a form to publish it as a Workspace table and start
                    capturing leads.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {pageForms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No forms synced yet — click Sync.
                    </p>
                  ) : (
                    pageForms.map((form) => (
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
                            {form.lastError ? ` · ${form.lastError}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
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
            );
          })}

          {checks ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">Diagnostics</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Configuration, permissions and per-Page webhook checks. This does
                  not prove a live lead was received — submit a test lead to confirm.
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
