// ============================================================
// Calls stats fetch client — one GET per dashboard filter state
// (range + all Recordings-page filters + timezone). Mirrors the
// dashboard analytics-client conventions (no-store, throws on
// non-ok, AbortSignal passthrough).
// ============================================================

import type {
  SalespersonAggregate,
  TrendBucket,
  TrendGranularity,
} from './aggregate';

export type SalespersonRow = SalespersonAggregate;

export interface RecentRecordingRow {
  id: string;
  contactId: string | null;
  contactName: string | null;
  phoneNumber: string | null;
  direction: string | null;
  callType: string | null;
  durationSecs: number | null;
  recordedAt: string | null;
  createdAt: string;
  fileName: string | null;
  uploaderName: string | null;
  workspaceTable: string | null;
}

export interface RecentMissedRow {
  id: string;
  contactId: string | null;
  contactName: string | null;
  phoneNumber: string | null;
  occurredAt: string;
  workspaceTable: string | null;
  ownerName: string | null;
}

export interface CallsStatsParams {
  fromISO: string;
  toISO: string;
  /** auth user UUID (uploaded_by / events user_id). */
  user?: string | null;
  /** 'in' | 'out' or null for all directions (NULLs included). */
  direction?: string | null;
  /** IANA zone used for server-side bucketing. */
  timeZone?: string;
  /** Lead/phone search text (Recordings semantics). */
  q?: string | null;
  /** 'phone' | 'whatsapp' or null for all (Recordings merge rules). */
  callType?: string | null;
  /** Workspace table (flow) id or null for all tables. */
  workspaceTable?: string | null;
  /** 'linked' | 'unlinked' or null for all. */
  status?: string | null;
  signal?: AbortSignal;
}

export interface CallsDashboard {
  recordingCount: number;
  recordingDurationSecs: number | null;
  incomingRecordings: number;
  outgoingRecordings: number;
  unknownDirectionRecordings: number;
  phoneRecordings: number;
  whatsappRecordings: number;
  whatsappBusinessRecordings: number;
  missedRecordings: number;
  /** Preserved for backend compatibility; not rendered by the dashboard. */
  rejectedRecordings: number;
  answeredEvents: number;
  unknownEvents: number;
  totalEvents: number;
  salesperson: SalespersonRow[];
  /** In-zone hour-of-day counts, index 0–23. */
  hourly: number[];
  /** In-zone weekday counts, Monday-first. */
  weekday: number[];
  trend: {
    granularity: TrendGranularity;
    buckets: TrendBucket[];
  };
  recent: RecentRecordingRow[];
  recentMissed: RecentMissedRow[];
  truncated: boolean;
}

export type CallsStatsResult = CallsDashboard;

export async function loadCallsStats(
  params: CallsStatsParams
): Promise<CallsStatsResult> {
  const qs = new URLSearchParams({
    from: params.fromISO,
    to: params.toISO,
  });
  if (params.user) qs.set('user', params.user);
  if (params.direction) qs.set('direction', params.direction);
  if (params.timeZone) qs.set('tz', params.timeZone);
  if (params.q?.trim()) qs.set('q', params.q.trim());
  if (params.callType) qs.set('call_type', params.callType);
  if (params.workspaceTable) qs.set('workspace_table', params.workspaceTable);
  if (params.status) qs.set('status', params.status);
  const res = await fetch(`/api/calls/stats?${qs.toString()}`, {
    cache: 'no-store',
    signal: params.signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? 'Failed to load call analytics');
  }
  const json = (await res.json()) as CallsStatsResult;
  if (
    !json ||
    typeof json !== 'object' ||
    typeof json.recordingCount !== 'number' ||
    !Array.isArray((json as { trend?: { buckets?: unknown } }).trend?.buckets)
  ) {
    throw new Error('Bad call analytics response shape');
  }
  return json;
}
