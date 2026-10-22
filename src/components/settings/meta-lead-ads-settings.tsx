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
  Mail,
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
import { Textarea } from "@/components/ui/textarea";
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

interface OAuthPageOption {
  pageId: string;
  pageName: string | null;
  tasks: string[];
}

interface OAuthSessionPayload {
  active: boolean;
  expiresAt?: string;
  userName?: string | null;
  scopes?: string[];
  pages?: OAuthPageOption[];
}

interface SetupPayload {
  configured: boolean;
  connected: boolean;
  datasetId: string | null;
  hasToken: boolean;
  tokenSource: "manual" | "oauth" | "capi" | null;
  setupSource?: string | null;
  tokenAppId?: string | null;
  scopes?: string[];
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
    scopes?: string[];
    setupSource?: string | null;
    tokenAppId?: string | null;
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

interface NotifySettingsPayload {
  enabled: boolean;
  subject_template: string;
  body_template: string;
  updated_at: string | null;
  is_default: boolean;
}

interface NotifyDelivery {
  id: string;
  lead_name: string | null;
  recipient_email: string | null;
  assignee_name: string | null;
  status: string;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

const NOTIFY_PLACEHOLDERS =
  "{{lead_name}} {{lead_phone}} {{lead_email}} {{form_name}} {{campaign_name}} {{ad_name}} {{received_at}} {{lead_link}} {{assignee_name}}";

interface OAuthPageResult {
  pageId: string;
  ok: boolean;
  pageName: string | null;
  subscribed: boolean;
  webhookVerified: boolean;
  warning: string | null;
  error: string | null;
  code: string | null;
  checks: Check[];
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// A recorded lead is not a visible lead: only `processed` rows became a
// Workspace run. Never report success based on `imported` alone.
function describeImport(result: ImportResult): {
  level: "success" | "error" | "info";
  text: string;
} {
  const plural = (n: number) => (n === 1 ? "" : "s");
  if (result.failed > 0) {
    return {
      level: "error",
      text:
        `${result.failed} lead${plural(result.failed)} could not be added to the Workspace` +
        (result.processed > 0
          ? ` (${result.processed} succeeded)`
          : "") +
        `. ${result.error ?? "They stay queued for automatic retry."}`,
    };
  }
  if (result.processed > 0) {
    return {
      level: "success",
      text: `Added ${result.processed} lead${plural(result.processed)} to the Workspace.`,
    };
  }
  if (result.imported > 0) {
    return {
      level: "info",
      text: `Recorded ${result.imported} lead${plural(result.imported)}; no new Workspace rows.`,
    };
  }
  return { level: "info", text: "No new leads to import." };
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
  const [notif, setNotif] = useState<NotifySettingsPayload | null>(null);
  const [notifDeliveries, setNotifDeliveries] = useState<NotifyDelivery[]>([]);
  const [notifSubject, setNotifSubject] = useState("");
  const [notifBody, setNotifBody] = useState("");
  const notifPrefilled = useRef(false);
  const [oauthSession, setOAuthSession] = useState<OAuthSessionPayload | null>(null);
  const [selectedOAuthPages, setSelectedOAuthPages] = useState<string[]>([]);
  const prefilled = useRef(false);
  const oauthAnnounced = useRef(false);

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
      if (!oauthAnnounced.current && typeof window !== "undefined") {
        oauthAnnounced.current = true;
        const params = new URLSearchParams(window.location.search);
        const oauth = params.get("meta_oauth");
        const oauthError = params.get("meta_oauth_error");
        if (oauth === "select") {
          toast.success("Meta authorization received. Select the Pages to connect.");
        } else if (oauth === "cancelled") {
          toast("Meta authorization was cancelled. Existing connections are unchanged.");
        } else if (oauthError) {
          toast.error(`Meta authorization failed (${oauthError}). Existing connections are unchanged.`);
        }
      }
      const [s, c, o] = await Promise.all([
        readJson(
          await fetch("/api/integrations/meta-lead-ads/status", { cache: "no-store" }),
        ),
        readJson(
          await fetch("/api/integrations/meta-lead-ads/credentials", {
            cache: "no-store",
          }),
        ),
        await fetch("/api/integrations/meta-lead-ads/oauth/session", {
          cache: "no-store",
        })
          .then(async (res) => {
            if (res.status === 403 || res.status === 401) return { active: false };
            return (await res.json().catch(() => ({ active: false }))) as OAuthSessionPayload;
          })
          .catch(() => ({ active: false }) as OAuthSessionPayload),
      ]);
      const nextStatus = s as unknown as StatusPayload;
      const nextSetup = c as unknown as SetupPayload;
      const nextSession = o as OAuthSessionPayload;
      setStatus(nextStatus);
      setSetup(nextSetup);
      setOAuthSession(nextSession.active ? nextSession : null);
      if (!nextSession.active) {
        setSelectedOAuthPages([]);
      } else {
        setSelectedOAuthPages((current) =>
          current.filter((pageId) =>
            (nextSession.pages ?? []).some((page) => page.pageId === pageId),
          ),
        );
      }

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

  function loadFormsForPages(pageIds: string[]) {
    return Promise.all(
      pageIds.map(async (targetPage) => {
        await readJson(
          await fetch("/api/integrations/meta-lead-ads/forms", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page_id: targetPage }),
          }),
        );
      }),
    );
  }

  function toggleOAuthPage(pageId: string, checked: boolean) {
    setSelectedOAuthPages((current) =>
      checked
        ? [...new Set([...current, pageId])]
        : current.filter((id) => id !== pageId),
    );
  }

  function connectOAuthPages() {
    if (selectedOAuthPages.length === 0) {
      toast.error("Select at least one eligible Facebook Page.");
      return;
    }
    void act("oauth-pages", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/oauth/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page_ids: selectedOAuthPages }),
        }),
      )) as { ok: boolean; pages: OAuthPageResult[] };
      const pages = json.pages ?? [];
      const checks = pages.flatMap((page) =>
        page.checks.map((check) => ({
          ...check,
          name: `${page.pageName ?? page.pageId} · ${check.name}`,
        })),
      );
      if (checks.length > 0) setChecks(checks);
      const succeeded = pages.filter((page) => page.ok);
      const failed = pages.filter((page) => !page.ok);
      if (succeeded.length > 0) {
        try {
          await loadFormsForPages(succeeded.map((page) => page.pageId));
          toast.success(
            `Connected ${succeeded.length} Page${succeeded.length === 1 ? "" : "s"}. Forms were loaded; enable the forms to import.`,
          );
        } catch {
          toast.success(
            `Connected ${succeeded.length} Page${succeeded.length === 1 ? "" : "s"}. Open Instant Forms and click Load My Forms.`,
          );
        }
      }
      if (failed.length > 0) {
        toast.error(
          `${failed.length} Page${failed.length === 1 ? "" : "s"} could not be connected: ${failed
            .map((page) => page.pageName ?? page.pageId)
            .join(", ")}. Existing leads and polling are unchanged.`,
          { description: failed[0]?.error ?? undefined },
        );
      }
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
      const summary = describeImport(result);
      if (result.error) {
        toast.error(`Import paused: ${result.error}`);
      } else if (summary.level === "error") {
        toast.error(summary.text);
      } else if (summary.level === "success") {
        toast.success(summary.text);
      } else {
        toast(summary.text);
      }
      if (result.hasMore) {
        toast("The import is large — it continues in the background.");
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
        const result = json.import;
        const summary = result ? describeImport(result) : null;
        if (summary && summary.level === "success") {
          toast.success(`Form enabled. ${summary.text}`);
        } else if (summary && summary.level === "error") {
          toast.error(`Form enabled. ${summary.text}`);
        } else {
          toast.success("Form enabled.");
        }
        if (result?.hasMore) {
          toast("Existing leads are still importing in the background.");
        }
        if (result?.error) {
          toast.error(`Historical import paused: ${result.error}`);
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

  const loadNotif = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        readJson(
          await fetch("/api/integrations/meta-lead-ads/notifications/settings", {
            cache: "no-store",
          }),
        ),
        readJson(
          await fetch("/api/integrations/meta-lead-ads/notifications/deliveries?limit=8", {
            cache: "no-store",
          }),
        ),
      ]);
      const payload = s as unknown as NotifySettingsPayload;
      setNotif(payload);
      if (!notifPrefilled.current) {
        notifPrefilled.current = true;
        setNotifSubject(payload.subject_template);
        setNotifBody(payload.body_template);
      }
      setNotifDeliveries((d as unknown as { deliveries: NotifyDelivery[] }).deliveries ?? []);
    } catch {
      // Notifications are additive: a failure here must not break settings.
    }
  }, []);

  function saveNotif() {
    void act("notif-save", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/notifications/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: notif?.enabled ?? false,
            subject_template: notifSubject,
            body_template: notifBody,
          }),
        }),
      )) as { ok: boolean; enabled: boolean };
      if (json.ok) {
        toast.success(
          json.enabled
            ? "New-lead email notifications enabled."
            : "New-lead email notifications disabled.",
        );
        notifPrefilled.current = false;
        await loadNotif();
      }
    });
  }

  function sendNotifTest() {
    void act("notif-test", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-lead-ads/notifications/test", {
          method: "POST",
        }),
      )) as { ok: boolean; to: string };
      if (json.ok) {
        toast.success(`Test notification sent to ${json.to}.`);
        await loadNotif();
      }
    });
  }

  const disabled = !canEditSettings || profileLoading;
  const needsReauth =
    status?.status === "needs_reauth" || status?.status === "revoked";
  const connected = Boolean(status?.connected && !needsReauth);
  const page = setup?.page ?? status?.pages[0] ?? null;
  const canReuseToken = Boolean(
    setup?.hasToken && setup.tokenSource === "capi" && !token.trim(),
  );

  useEffect(() => {
    if (connected) void loadNotif();
  }, [connected, loadNotif]);

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
                  Meta rejected the stored token during a sync attempt. Try the existing
                  token first: leave the token field blank below and click Save &amp;
                  verify to re-check it. Only paste a new System User token if Meta
                  still rejects it. Existing leads are not affected.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {oauthSession?.active ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">Select Facebook Pages</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Choose which authorized Pages feed leads into this workspace
                  only. Authorization expires {fmt(oauthSession.expiresAt ?? null)}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(oauthSession.pages ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Meta did not return any manageable Pages for this authorization.
                    Check the Page role and permissions, then start Connect with
                    Facebook again.
                  </p>
                ) : (
                  (oauthSession.pages ?? []).map((page) => (
                    <label
                      key={page.pageId}
                      className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selectedOAuthPages.includes(page.pageId)}
                        onChange={(e) => toggleOAuthPage(page.pageId, e.target.checked)}
                        disabled={disabled || busy === "oauth-pages"}
                      />
                      <span>
                        <span className="font-medium text-foreground">
                          {page.pageName ?? page.pageId}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {page.pageId}
                          {page.tasks.length > 0 ? ` · ${page.tasks.join(", ")}` : " · no Page role returned"}
                        </span>
                      </span>
                    </label>
                  ))
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={connectOAuthPages}
                    disabled={
                      disabled ||
                      busy === "oauth-pages" ||
                      selectedOAuthPages.length === 0
                    }
                  >
                    {busy === "oauth-pages" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Connect selected Pages
                  </Button>
                </div>
              </CardContent>
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
                Manual setup
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Legacy fallback. In Meta Business Settings, create a System User,
                assign the Page and your dataset, then generate a token. Paste the
                three values below once — they are encrypted and never shown to
                the browser again. A token from another Meta app can poll/read, but
                cannot install this shared app&apos;s webhook.
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
                    <Badge variant="secondary">Real-time webhook + polling</Badge>
                  ) : page ? (
                    <Badge variant="outline">Polling active — webhook not verified</Badge>
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
                  <code>pages_read_engagement</code>,{" "}
                  <code>pages_show_list</code>, <code>pages_manage_metadata</code>{" "}
                  and <code>ads_management</code> for real-time webhook
                  installation. Without the webhook permissions, leads still
                  arrive through polling.
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
                    Polling runs on a schedule for every enabled form, so lead
                    capture keeps working even if Meta refuses the subscription.
                    Real-time delivery additionally needs app-level leadgen plus a
                    verified Page installation for each Page.
                    {(status?.pages ?? []).length > 0 &&
                    (status?.pages ?? []).every((p) => p.webhookVerified)
                      ? " All connected Pages are verified for real-time delivery."
                      : " One or more Pages are polling-only; run diagnostics for the exact Graph error."}
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

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-foreground">
                    <Mail className="size-4" /> New-lead email notifications
                  </CardTitle>
                  <CardDescription className="text-muted-foreground">
                    When a new Meta lead row is created and assigned to a
                    salesperson, one email is sent to that salesperson&apos;s
                    registered address — from the shared WhatsApp Max mailbox.
                    Unassigned leads wait until someone is assigned; clearing
                    an assignment never notifies. Each lead notifies at most
                    once.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="meta-notif-enabled" className="text-sm">
                      Email the assigned salesperson for new leads
                    </Label>
                    <Switch
                      id="meta-notif-enabled"
                      checked={notif?.enabled ?? false}
                      onCheckedChange={(v) =>
                        setNotif((current) =>
                          current ? { ...current, enabled: v } : current,
                        )
                      }
                      disabled={disabled || notif === null}
                      aria-label="Enable new-lead email notifications"
                    />
                  </div>
                  <div>
                    <Label htmlFor="meta-notif-subject">Subject template</Label>
                    <Input
                      id="meta-notif-subject"
                      value={notifSubject}
                      onChange={(e) => setNotifSubject(e.target.value)}
                      disabled={disabled || notif === null}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="meta-notif-body">Body template</Label>
                    <Textarea
                      id="meta-notif-body"
                      value={notifBody}
                      onChange={(e) => setNotifBody(e.target.value)}
                      disabled={disabled || notif === null}
                      rows={8}
                      className="mt-1 font-mono text-xs"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Placeholders: {NOTIFY_PLACEHOLDERS}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={saveNotif}
                      disabled={disabled || busy === "notif-save" || notif === null}
                    >
                      {busy === "notif-save" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      Save notification settings
                    </Button>
                    {connected ? (
                      <Button
                        variant="outline"
                        onClick={sendNotifTest}
                        disabled={disabled || busy === "notif-test"}
                      >
                        {busy === "notif-test" ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Mail className="size-4" />
                        )}
                        Send test email to me
                      </Button>
                    ) : null}
                  </div>
                  {notifDeliveries.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        Recent deliveries
                      </p>
                      {notifDeliveries.map((delivery) => (
                        <div
                          key={delivery.id}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs"
                        >
                          <Badge
                            variant={delivery.status === "sent" ? "secondary" : "outline"}
                          >
                            {delivery.status}
                          </Badge>
                          <span className="font-medium text-foreground">
                            {delivery.lead_name ?? "Lead"}
                          </span>
                          <span className="text-muted-foreground">
                            → {delivery.assignee_name ?? delivery.recipient_email ?? "—"}
                          </span>
                          <span className="text-muted-foreground">
                            {fmt(delivery.sent_at ?? delivery.created_at)}
                          </span>
                          {delivery.status === "failed" && delivery.last_error ? (
                            <span className="text-destructive">{delivery.last_error}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
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
