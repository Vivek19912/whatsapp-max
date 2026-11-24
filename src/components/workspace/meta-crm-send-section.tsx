"use client";

import { useCallback, useEffect, useState } from "react";

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
  // NOTE: no event_id — intentionally omitted from the Meta payload.
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
 * Meta CRM delivery status section for the lead drawer (Meta
 * tables only). Selecting a Lead Quality status in the Workspace
 * table auto-enqueues the mapped event server-side (deduped by
 * the ledger); this section REPORTS delivery — it never sends.
 *
 *   1. the backend-generated preview (same builder the send path
 *      uses) is fetched on mount and after every status save;
 *   2. delivery state (Queued / Sent / Failed) comes from the
 *      recorded ledger row, refreshed via Refresh Status;
 *   3. retries of failed rows happen in Settings → Meta → CRM
 *      Integration → Event History, never by re-saving here.
 *
 * The raw JSON payload UI is intentionally hidden (SHOW_CRM_PAYLOAD
 * = false) — the backend builder, serialization, matching, and
 * history are untouched and flipping the flag restores it.
 */
const SHOW_CRM_PAYLOAD = false;

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
  const [notice, setNotice] = useState<string | null>(null);

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

  const last = preview?.lastEvent ?? null;
  const delivery: "not_sent" | "queued" | "sent" | "failed" | "skipped" =
    !last ? "not_sent" : last.status === "pending" ? "queued"
    : last.status === "sent" ? "sent"
    : last.status === "failed" ? "failed"
    : last.status === "skipped" ? "skipped" : "not_sent";

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">Meta CRM Event</h3>
        <Badge variant={delivery === "sent" ? "default" : "secondary"}>
          {delivery === "not_sent" ? "Not sent"
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

      {SHOW_CRM_PAYLOAD && preview?.requestBody ? (
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
              disabled={loading}
              onClick={load}
            >
              Refresh Status
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex gap-2">
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
      )}
      {SHOW_CRM_PAYLOAD && preview ? (
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

      {!preview?.sendable && preview?.reason ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Sending is disabled: {preview.reason.replace(/_/g, " ")}.
        </p>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">
          Selecting a Lead Quality status sends the mapped event automatically — no separate send step.
        </p>
      )}
    </div>
  );
}
