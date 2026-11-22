"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  LEAD_QUALITY_EVENT_ID_NOTE,
  LEAD_QUALITY_EVENT_TIME_NOTE,
} from "@/lib/meta-crm/preview";

interface CrmPreviewPayload {
  event_name: string;
  event_time: number;
  action_source: string;
  user_data: { lead_id: string; em?: string[]; ph?: string[] };
  custom_data: { lead_event_source: string; event_source: string };
  event_id: string;
}

interface CrmPreview {
  sendable: boolean;
  reason: string | null;
  message: string;
  status: string;
  stored: string | null;
  eventName: string | null;
  datasetId: string | null;
  metaLeadId: string | null;
  occurrenceTimeIso: string | null;
  previewId: string | null;
  payload: CrmPreviewPayload | null;
  requestBody: { data: [CrmPreviewPayload] } | null;
  warnings: string[];
  matchInfo: { hasEmail: boolean; hasPhone: boolean };
  lastEvent: {
    id: string;
    eventName: string;
    eventTime: number | null;
    status: string;
    lastError: string | null;
    sentAt: string | null;
    createdAt: string;
  } | null;
}

function formatInstant(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString();
}

function formatEpoch(sec: number | null): string {
  if (sec === null || sec === undefined) return "—";
  return `${new Date(sec * 1000).toLocaleString()} (${sec})`;
}

/**
 * Manual "Send to Meta" section for the lead drawer (Meta tables
 * only). Saving a Lead Quality status NEVER sends — this explicit
 * button is the sole delivery path:
 *
 *   1. the backend-generated preview (same builder the send uses)
 *      is fetched on mount and after every status save;
 *   2. Send posts flow/run/preview_id; the server revalidates live
 *      state and rejects stale previews (409) or gated states;
 *   3. the button is loading-guarded so double taps collapse to
 *      one ledger row (server unique key dedups regardless).
 */
export function MetaCrmSendSection({
  flowId,
  runId,
  refreshToken,
}: {
  flowId: string;
  runId: string;
  /** Incremented after a Lead Quality save to refetch the preview. */
  refreshToken: number;
}) {
  const [preview, setPreview] = useState<CrmPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/integrations/meta-crm/preview?flow_id=${encodeURIComponent(flowId)}&run_id=${encodeURIComponent(runId)}`,
      );
      const json = (await res.json().catch(() => null)) as {
        preview?: CrmPreview;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not load the preview.");
      setPreview(json?.preview ?? null);
    } catch (err) {
      setPreview(null);
      setNotice(err instanceof Error ? err.message : "Could not load the preview.");
    } finally {
      setLoading(false);
    }
  }, [flowId, runId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function send() {
    if (!preview?.previewId || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/integrations/meta-crm/manual-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow_id: flowId,
          run_id: runId,
          preview_id: preview.previewId,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        preview?: CrmPreview;
        error?: string;
        reason?: string;
        deduplicated?: boolean;
        queued?: boolean;
      } | null;
      if (json?.preview) setPreview(json.preview);
      if (!res.ok) {
        throw new Error(json?.error ?? "Send failed.");
      }
      if (json?.deduplicated && !json?.queued) {
        setNotice("Already recorded — no duplicate event was created.");
      } else if (json?.deduplicated) {
        setNotice("Already queued — the existing delivery was kept (no duplicate).");
      } else {
        setNotice("Queued for delivery to Meta.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed.";
      setNotice(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
  }

  async function copyPayload() {
    if (!preview?.requestBody) return;
    const text = JSON.stringify(preview.requestBody, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const last = preview?.lastEvent ?? null;
  const delivery: "sending" | "not_sent" | "queued" | "sent" | "failed" | "skipped" =
    sending ? "sending" : !last ? "not_sent" : last.status === "pending" ? "queued"
    : last.status === "sent" ? "sent"
    : last.status === "failed" ? "failed"
    : last.status === "skipped" ? "skipped" : "not_sent";

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">Meta CRM Event</h3>
        <Badge variant={delivery === "sent" ? "default" : "secondary"}>
          {delivery === "sending" ? "Sending"
            : delivery === "not_sent" ? "Not sent"
            : delivery === "queued" ? "Queued"
            : delivery === "sent" ? "Sent"
            : delivery === "failed" ? "Failed" : "Skipped"}
        </Badge>
      </div>

      {loading ? (
        <p className="text-muted-foreground mt-2 text-sm">Loading preview…</p>
      ) : !preview ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {notice ?? "Preview unavailable."}
        </p>
      ) : (
        <dl className="mt-2 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Status</dt>
            <dd className="text-foreground text-right font-medium">
              {preview.status}
              {preview.stored === null ? (
                <span className="text-muted-foreground font-normal"> (table default)</span>
              ) : null}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Event</dt>
            <dd className="text-foreground text-right font-mono text-xs">
              {preview.eventName ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Dataset ID</dt>
            <dd className="text-foreground text-right font-mono text-xs break-all">
              {preview.datasetId ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Meta Lead ID</dt>
            <dd className="text-foreground text-right font-mono text-xs break-all">
              {preview.metaLeadId ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Event time</dt>
            <dd className="text-foreground max-w-[60%] text-right text-xs">
              {preview.payload ? formatEpoch(preview.payload.event_time) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Sent at</dt>
            <dd className="text-foreground max-w-[60%] text-right text-xs">
              {last?.sentAt ? formatInstant(last.sentAt) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Matching</dt>
            <dd className="text-foreground max-w-[60%] text-right text-xs">
              {preview.matchInfo.hasEmail || preview.matchInfo.hasPhone
                ? [
                    preview.matchInfo.hasEmail ? "hashed email" : null,
                    preview.matchInfo.hasPhone ? "hashed phone" : null,
                  ]
                    .filter(Boolean)
                    .join(" + ")
                : "lead ID only"}
            </dd>
          </div>
          {last ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground shrink-0">Last delivery</dt>
              <dd className="text-foreground text-right text-xs">
                {last.eventName} · {last.status}
                {last.lastError ? ` · ${last.lastError}` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
      )}

      {preview?.warnings && preview.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {preview.warnings.map((w) => (
            <li key={w} className="text-xs text-amber-600 dark:text-amber-400">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {preview?.requestBody ? (
        <>
          <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] break-all whitespace-pre-wrap">
            {JSON.stringify(preview.requestBody, null, 2)}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={copyPayload}
            >
              {copied ? "Copied" : "Copy Payload"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={loading}
              onClick={load}
            >
              Refresh Status
            </Button>
          </div>
        </>
      ) : null}
      {preview ? (
        <p className="text-muted-foreground mt-1 text-xs">
          {LEAD_QUALITY_EVENT_TIME_NOTE} {LEAD_QUALITY_EVENT_ID_NOTE}
        </p>
      ) : null}

      {notice && preview ? (
        <p className="mt-2 text-sm text-foreground">{notice}</p>
      ) : null}
      {!loading && preview && !preview.sendable ? (
        <p className="text-muted-foreground mt-2 text-sm">{preview.message}</p>
      ) : null}

      <Button
        className="mt-2 w-full"
        disabled={!preview?.sendable || sending || loading}
        onClick={send}
      >
        {sending ? "Sending…" : "Send to Meta"}
      </Button>
      {!preview?.sendable && preview?.reason ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Sending is disabled: {preview.reason.replace(/_/g, " ")}.
        </p>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">
          Saving a status never sends — only this button delivers the event.
        </p>
      )}
    </div>
  );
}
