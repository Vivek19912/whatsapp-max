// ============================================================
// Recordings library page data layer — server-side filtered
// list + summary fetching. Every filter maps to a real
// GET /api/recordings param; nothing is filtered in the
// browser, so the full catalog never downloads.
// ============================================================

import type { CallRecording } from './recordings';

export interface RecordingsFilters {
  q: string;
  rangeKey: 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'custom';
  customFrom: string;
  customTo: string;
  callType: string | null;
  direction: string | null;
  uploadedBy: string | null;
  status: string | null;
}

export interface RecordingsSummary {
  total: number;
  totalDurationSecs: number;
  phone: number;
  /** Merged user-facing WhatsApp count (whatsapp + whatsapp_business). */
  whatsapp: number;
  /**
   * Legacy transport key: older RPC payloads / caches may still carry
   * the raw whatsapp_business split. Never rendered — the route folds
   * it into `whatsapp`, and the UI reads only `whatsapp`.
   */
  whatsappBusiness?: number;
  unlinked: number;
}

export interface RecordingsList {
  recordings: CallRecording[];
  total: number;
}

export interface MemberOption {
  user_id: string;
  label: string;
}

/** Query string for the list endpoint (paginated). */
export function recordingsQuery(
  filters: RecordingsFilters,
  range: { fromISO: string; toISO: string },
  limit: number,
  offset: number
): string {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (filters.q.trim()) qs.set('q', filters.q.trim());
  qs.set('from', range.fromISO);
  qs.set('to', range.toISO);
  if (filters.callType) qs.set('call_type', filters.callType);
  if (filters.direction) qs.set('direction', filters.direction);
  if (filters.uploadedBy) qs.set('uploaded_by', filters.uploadedBy);
  if (filters.status) qs.set('status', filters.status);
  return qs.toString();
}

/** Query string for the summary endpoint (unpaginated aggregate). */
export function summaryQuery(
  filters: RecordingsFilters,
  range: { fromISO: string; toISO: string }
): string {
  const qs = new URLSearchParams({ summary: '1' });
  if (filters.q.trim()) qs.set('q', filters.q.trim());
  qs.set('from', range.fromISO);
  qs.set('to', range.toISO);
  if (filters.callType) qs.set('call_type', filters.callType);
  if (filters.direction) qs.set('direction', filters.direction);
  if (filters.uploadedBy) qs.set('uploaded_by', filters.uploadedBy);
  if (filters.status) qs.set('status', filters.status);
  return qs.toString();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Request failed');
  }
  return (await res.json()) as T;
}

export function loadRecordingsList(
  query: string,
  signal?: AbortSignal
): Promise<RecordingsList> {
  return getJson<RecordingsList>(`/api/recordings?${query}`, signal).then((body) => ({
    recordings: Array.isArray(body.recordings) ? body.recordings : [],
    total: typeof body.total === 'number' ? body.total : 0,
  }));
}

export function loadRecordingsSummary(
  query: string,
  signal?: AbortSignal
): Promise<RecordingsSummary> {
  const empty: RecordingsSummary = {
    total: 0,
    totalDurationSecs: 0,
    phone: 0,
    whatsapp: 0,
    whatsappBusiness: 0,
    unlinked: 0,
  };
  return getJson<{ summary?: RecordingsSummary }>(`/api/recordings?${query}`, signal).then(
    (body) => ({ ...empty, ...body.summary })
  );
}

interface MembersResponse {
  members?: Array<{ user_id: string; full_name: string | null; email: string | null }>;
}

export async function loadMemberOptions(signal?: AbortSignal): Promise<MemberOption[]> {
  const body = await getJson<MembersResponse>('/api/account/members', signal).catch(() => null);
  return (body?.members ?? []).map((m) => ({
    user_id: m.user_id,
    label: m.full_name || m.email || 'Unknown user',
  }));
}

/** Long-form duration for the drawer ("16 seconds", "3:12"). */
export function formatDurationLong(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}
