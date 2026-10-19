"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ACTION_SOURCES, STANDARD_EVENTS, TRIGGER_SOURCES } from "@/lib/meta-capi/catalog";
import { SettingsPanelHead } from "./settings-panel-head";

interface PublicConfig {
  hasDataset: boolean;
  datasetId: string | null;
  hasToken: boolean;
  hasAppSecret: boolean;
  status: "incomplete" | "connected" | "error";
  testEventCode: string | null;
  actionSource: string;
  setupStep: number;
  lastError: string | null;
  lastVerifiedAt: string | null;
  tokenUpdatedAt: string | null;
}

interface Mapping {
  id: string;
  name: string;
  sourceAction: string;
  sourceField: string | null;
  sourceValue: string | null;
  metaEventName: string;
  actionSource: string;
  requiresValue: boolean;
  eventValue: number | null;
  currency: string | null;
  enabled: boolean;
}

interface Delivery {
  id: string;
  eventName: string;
  eventId: string;
  sourceAction: string;
  sourceValue: string | null;
  status: string;
  attempts: number;
  isTest: boolean;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface StatusPayload {
  configured: boolean;
  config: PublicConfig;
  mappingSummary: { total: number; enabled: number };
  recentDeliveries: Delivery[];
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const EMPTY_FORM = {
  name: "",
  sourceAction: "meta_lead_received",
  sourceField: "",
  sourceValue: "",
  metaEventName: "Lead",
  actionSource: "business_messaging",
  requiresValue: false,
  eventValue: "",
  currency: "",
  enabled: true,
};

function statusBadge(status: string) {
  if (status === "sent") return <Badge variant="secondary">sent</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  if (status === "skipped") return <Badge variant="outline">skipped</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function MetaConversionsApiSettings({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const { canEditSettings, profileLoading } = useAuth();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [datasetInput, setDatasetInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [appSecretInput, setAppSecretInput] = useState("");
  const [testCodeInput, setTestCodeInput] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM });

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
      const s = (await readJson(
        await fetch("/api/integrations/meta-capi/status", { cache: "no-store" }),
      )) as unknown as StatusPayload;
      setStatus(s);
      setTestCodeInput(s.config.testEventCode ?? "");
      const m = (await readJson(
        await fetch("/api/integrations/meta-capi/mappings", { cache: "no-store" }),
      )) as { mappings: Mapping[] };
      setMappings(m.mappings ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Conversions API.");
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

  const disabled = !canEditSettings || profileLoading;
  const config = status?.config;

  function saveConfig(patch: Record<string, unknown>, key: string, okMsg: string) {
    void act(key, async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-capi/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      )) as { datasetName?: string | null };
      toast.success(
        json.datasetName ? `${okMsg} Found “${json.datasetName}”.` : okMsg,
      );
      setTokenInput("");
      setAppSecretInput("");
      await load();
    });
  }

  function sendTest() {
    void act("test", async () => {
      const json = (await readJson(
        await fetch("/api/integrations/meta-capi/test-event", { method: "POST" }),
      )) as { eventsReceived: number; note: string };
      toast.success(`Test event sent (${json.eventsReceived} received). ${json.note}`);
      await load();
    });
  }

  function disconnect() {
    if (!window.confirm("Remove the stored dataset and access token? Event mappings are kept.")) {
      return;
    }
    void act("disconnect", async () => {
      await readJson(
        await fetch("/api/integrations/meta-capi/config", { method: "DELETE" }),
      );
      toast.success("Conversions API credentials removed.");
      await load();
    });
  }

  function createMapping() {
    void act("create", async () => {
      await readJson(
        await fetch("/api/integrations/meta-capi/mappings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            source_action: form.sourceAction,
            source_field: form.sourceField || null,
            source_value: form.sourceValue || null,
            meta_event_name: form.metaEventName,
            action_source: form.actionSource,
            requires_value: form.requiresValue,
            event_value: form.eventValue === "" ? null : Number(form.eventValue),
            currency: form.currency || null,
            enabled: form.enabled,
          }),
        }),
      );
      toast.success("Event mapping created.");
      setForm({ ...EMPTY_FORM });
      await load();
    });
  }

  function toggleMapping(mapping: Mapping, enabled: boolean) {
    void act(`m:${mapping.id}`, async () => {
      await readJson(
        await fetch(`/api/integrations/meta-capi/mappings/${mapping.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        }),
      );
      await load();
    });
  }

  function deleteMapping(mapping: Mapping) {
    void act(`d:${mapping.id}`, async () => {
      await readJson(
        await fetch(`/api/integrations/meta-capi/mappings/${mapping.id}`, {
          method: "DELETE",
        }),
      );
      toast.success("Event mapping removed.");
      await load();
    });
  }

  const needsField = form.sourceAction === "workspace_field_changed";
  const needsValue =
    form.requiresValue || form.metaEventName === "Purchase";

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-5">
      {embedded ? null : (
        <SettingsPanelHead
          title="Conversions API"
          description="Send conversion events (like Lead or Purchase) from WhatsApp Max to your own Meta dataset, so Meta can optimise your ads. This is separate from lead capture — nothing here changes how leads arrive."
        />
      )}

      {!status?.configured ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <AlertCircle className="size-4 text-destructive" /> Unavailable on this server
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              The shared Meta app credentials are missing, so the Conversions API
              cannot send events. Ask your administrator to set{" "}
              <code>META_LEAD_ADS_APP_ID</code>, <code>META_LEAD_ADS_APP_SECRET</code> and{" "}
              <code>META_GRAPH_VERSION</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                {config?.status === "connected" ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <AlertCircle className="size-4 text-muted-foreground" />
                )}
                Setup
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Four steps: point at your dataset, add a Conversions API token,
                (optionally) add a test code, then choose which events to send.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={config?.hasDataset ? "secondary" : "outline"}>
                1 · Dataset
              </Badge>
              <Badge variant={config?.status === "connected" ? "secondary" : "outline"}>
                2 · Token
              </Badge>
              <Badge variant={config?.testEventCode ? "secondary" : "outline"}>
                3 · Test code
              </Badge>
              <Badge variant={(status?.mappingSummary.enabled ?? 0) > 0 ? "secondary" : "outline"}>
                4 · Events
              </Badge>
              {config?.lastError ? (
                <span className="text-destructive">{config.lastError}</span>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">1 · Dataset / Pixel ID</CardTitle>
              <CardDescription className="text-muted-foreground">
                In Meta Events Manager, open your data source and copy its numeric
                Dataset (Pixel) ID. Events are sent here.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Label htmlFor="capi-dataset">Dataset / Pixel ID</Label>
                <Input
                  id="capi-dataset"
                  inputMode="numeric"
                  placeholder={config?.datasetId ?? "e.g. 1234567890"}
                  value={datasetInput}
                  onChange={(e) => setDatasetInput(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <Button
                onClick={() => saveConfig({ dataset_id: datasetInput.trim() }, "dataset", "Dataset saved.")}
                disabled={disabled || busy === "dataset" || !datasetInput.trim()}
              >
                {busy === "dataset" ? <Loader2 className="size-4 animate-spin" /> : null}
                Save & verify
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">2 · Conversions API token</CardTitle>
              <CardDescription className="text-muted-foreground">
                Generate a System User access token in Meta Business Settings with
                access to this dataset. It is encrypted at rest and never shown again.
                If the token was issued by a different Meta app than this platform
                app, also paste that app&apos;s App Secret so we can send a valid
                appsecret_proof. Leave it blank and no proof is sent — the platform
                app&apos;s secret is never used for your token.
                {config?.hasToken ? " A token is currently stored." : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56 flex-1">
                  <Label htmlFor="capi-token">Access token</Label>
                  <Input
                    id="capi-token"
                    type="password"
                    autoComplete="off"
                    placeholder={config?.hasToken ? "•••••••• (stored)" : "Paste token"}
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <Button
                  onClick={() => saveConfig({ access_token: tokenInput.trim() }, "token", "Token saved and verified.")}
                  disabled={disabled || busy === "token" || !tokenInput.trim()}
                >
                  {busy === "token" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save & verify
                </Button>
                {config?.hasToken ? (
                  <Button variant="outline" onClick={disconnect} disabled={disabled || busy === "disconnect"}>
                    Remove
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56 flex-1">
                  <Label htmlFor="capi-appsecret">App Secret (optional)</Label>
                  <Input
                    id="capi-appsecret"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config?.hasAppSecret
                        ? "•••••••• (stored)"
                        : "Only if the token belongs to another Meta app"
                    }
                    value={appSecretInput}
                    onChange={(e) => setAppSecretInput(e.target.value)}
                    disabled={disabled}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Used only to compute appsecret_proof. Leave blank if you do not
                    know it — Meta does not require it unless your app enforces it.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() =>
                    saveConfig(
                      { app_secret: appSecretInput.trim() },
                      "appsecret",
                      "App Secret saved and verified.",
                    )
                  }
                  disabled={disabled || busy === "appsecret" || !appSecretInput.trim()}
                >
                  {busy === "appsecret" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save App Secret
                </Button>
                {config?.hasAppSecret ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      saveConfig({ app_secret: null }, "appsecret", "App Secret removed.")
                    }
                    disabled={disabled || busy === "appsecret"}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">3 · Test events (optional)</CardTitle>
              <CardDescription className="text-muted-foreground">
                Copy a Test Event Code from Events Manager → Test Events. With it,
                you can send a clearly-labelled TEST event to confirm everything is
                wired up — test events are never reported as real conversions.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Label htmlFor="capi-testcode">Test Event Code</Label>
                <Input
                  id="capi-testcode"
                  placeholder="e.g. TEST12345"
                  value={testCodeInput}
                  onChange={(e) => setTestCodeInput(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <Button
                variant="outline"
                onClick={() => saveConfig({ test_event_code: testCodeInput.trim() || null }, "testcode", "Test code saved.")}
                disabled={disabled || busy === "testcode"}
              >
                {busy === "testcode" ? <Loader2 className="size-4 animate-spin" /> : null}
                Save
              </Button>
              <Button
                onClick={sendTest}
                disabled={disabled || busy === "test" || !config?.testEventCode || !config?.hasDataset || !config?.hasToken}
              >
                {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send test event
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">4 · Events to send</CardTitle>
              <CardDescription className="text-muted-foreground">
                Choose what happens in WhatsApp Max and which Meta event it sends.
                Only the triggers that actually exist here are offered.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {mappings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events configured yet.</p>
              ) : (
                <div className="space-y-2">
                  {mappings.map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {m.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {TRIGGER_SOURCES.find((t) => t.value === m.sourceAction)?.label ??
                            m.sourceAction}
                          {m.sourceField ? ` · ${m.sourceField} = ${m.sourceValue}` : ""}
                          {` → ${m.metaEventName}`}
                          {m.eventValue != null ? ` (${m.currency} ${m.eventValue})` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {busy === `d:${m.id}` ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : null}
                        <Switch
                          checked={m.enabled}
                          onCheckedChange={(v) => toggleMapping(m, v)}
                          disabled={disabled || busy === `m:${m.id}`}
                          aria-label={`Enable ${m.name}`}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteMapping(m)}
                          disabled={disabled || busy === `d:${m.id}`}
                          aria-label={`Delete ${m.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                <p className="text-sm font-medium text-foreground">Add an event</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="capi-name">Name</Label>
                    <Input
                      id="capi-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Workshop enquiry"
                      disabled={disabled}
                    />
                  </div>
                  <div>
                    <Label>When this happens</Label>
                    <Select
                      value={form.sourceAction}
                      onValueChange={(v) => setForm({ ...form, sourceAction: v ?? "meta_lead_received" })}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRIGGER_SOURCES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {needsField ? (
                    <>
                      <div>
                        <Label htmlFor="capi-field">Workspace column</Label>
                        <Input
                          id="capi-field"
                          value={form.sourceField}
                          onChange={(e) => setForm({ ...form, sourceField: e.target.value })}
                          placeholder="e.g. Stage"
                          disabled={disabled}
                        />
                      </div>
                      <div>
                        <Label htmlFor="capi-value">Column value</Label>
                        <Input
                          id="capi-value"
                          value={form.sourceValue}
                          onChange={(e) => setForm({ ...form, sourceValue: e.target.value })}
                          placeholder="e.g. Booking Confirmed"
                          disabled={disabled}
                        />
                      </div>
                    </>
                  ) : null}

                  <div>
                    <Label>Send Meta event</Label>
                    <Select
                      value={form.metaEventName}
                      onValueChange={(v) => setForm({ ...form, metaEventName: v ?? "Lead" })}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STANDARD_EVENTS.map((e) => (
                          <SelectItem key={e.name} value={e.name}>
                            {e.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Action source</Label>
                    <Select
                      value={form.actionSource}
                      onValueChange={(v) => setForm({ ...form, actionSource: v ?? "business_messaging" })}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTION_SOURCES.map((a) => (
                          <SelectItem key={a.value} value={a.value}>
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {needsValue ? (
                    <>
                      <div>
                        <Label htmlFor="capi-amount">Value</Label>
                        <Input
                          id="capi-amount"
                          inputMode="decimal"
                          value={form.eventValue}
                          onChange={(e) => setForm({ ...form, eventValue: e.target.value })}
                          placeholder="e.g. 150"
                          disabled={disabled}
                        />
                      </div>
                      <div>
                        <Label htmlFor="capi-currency">Currency</Label>
                        <Input
                          id="capi-currency"
                          value={form.currency}
                          onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                          placeholder="USD"
                          maxLength={3}
                          disabled={disabled}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Purchase events are only sent when a real value and currency are
                  configured, and are never inferred from a qualified lead.
                </p>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                    disabled={disabled}
                    aria-label="Enable this event"
                  />
                  <span className="text-sm text-muted-foreground">
                    Enable immediately
                  </span>
                  <Button
                    className="ml-auto"
                    onClick={createMapping}
                    disabled={disabled || busy === "create" || !form.name.trim()}
                  >
                    {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Add event
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-foreground">
                <span>Recent deliveries</span>
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                The honest record of what was sent. Test events are labelled. A
                delivery is only shown as “sent” when Meta confirmed it received an
                event — this page does not itself prove attribution in Ads Manager.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(status?.recentDeliveries ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
              ) : (
                (status?.recentDeliveries ?? []).map((d) => (
                  <div key={d.id} className="flex items-start gap-2 text-sm">
                    {d.status === "sent" ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : d.status === "failed" ? (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    ) : (
                      <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">
                        {d.eventName}
                      </span>{" "}
                      {statusBadge(d.status)}{" "}
                      {d.isTest ? <Badge variant="outline">test</Badge> : null}
                      <span className="text-muted-foreground">
                        {" "}
                        · {fmt(d.createdAt)}
                        {d.attempts > 1 ? ` · ${d.attempts} attempts` : ""}
                        {d.lastError ? ` · ${d.lastError}` : ""}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
