// ============================================================
// Recordings library page data layer — server-side filtered
// list + summary fetching. Every filter maps to a real
// GET /api/recordings param; nothing is filtered in the
// browser, so the full catalog never downloads.
// ============================================================

import type { RecordingTableRow } from './recordings';

export interface RecordingsFilters {
  q: string;
  rangeKey: 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'custom';
  customFrom: string;
  customTo: string;
  callType: string | null;
  direction: string | null;
  uploadedBy: string | null;
  /** Workspace table (flow) id, or null for all tables. */
  workspaceTable: string | null;
  status: string | null;
}

/**
 * Default filter state: last-30-days window, every dropdown at
 * its "all" option, empty search. Single source for the page's
 * initial state and the toolbar's Clear filters action, so the
 * two can never disagree.
 */
export function resetRecordingsFilters(): RecordingsFilters {
  return {
    q: '',
    rangeKey: 'last30',
    customFrom: '',
    customTo: '',
    callType: null,
    direction: null,
    uploadedBy: null,
    workspaceTable: null,
    status: null,
  };
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
  /** Combined rows: audio recordings + missed-call events, newest first. */
  recordings: RecordingTableRow[];
  /** Combined count across both populations (summary KPIs stay recordings-only). */
  total: number;
  /** Missed-event rows in this response (additive; absent on older responses). */
  missedTotal?: number;
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
  if (filters.workspaceTable) qs.set('workspace_table', filters.workspaceTable);
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
  if (filters.workspaceTable) qs.set('workspace_table', filters.workspaceTable);
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

export interface WorkspaceTableOption {
  flow_id: string;
  name: string;
}

interface FlowsResponse {
  flows?: Array<{ id: string; name: string | null }>;
}

/**
 * Workspace tables available to the caller for the Workspace
 * Table filter. Reuses GET /api/flows (account-scoped via RLS —
 * the same source the Workspace selector reads), mapped to the
 * option shape. Never throws (returns [] on failure — the filter
 * degrades to All tables rather than breaking the toolbar).
 */
export async function loadWorkspaceTableOptions(
  signal?: AbortSignal
): Promise<WorkspaceTableOption[]> {
  const body = await getJson<FlowsResponse>('/api/flows', signal).catch(() => null);
  return (body?.flows ?? [])
    .filter((f) => typeof f?.id === 'string' && f.id)
    .map((f) => ({
      flow_id: f.id,
      name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'Untitled Flow',
    }));
}

const RANGE_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Compact applied-range label for the Date card
 * ("07 Nov – 15 Nov 2026"; year repeated only when the range
 * spans years). Inputs are YYYY-MM-DD calendar days parsed in
 * UTC so the label never shifts with the viewer's zone.
 * Anything unparseable (or from ≥ to) falls back to 'Custom'.
 */
export function formatCustomRangeLabel(fromInput: string, toInput: string): string {
  const parse = (input: string): { y: number; m: number; d: number } | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo - 1 ||
      dt.getUTCDate() !== d
    ) {
      return null;
    }
    return { y, m: mo, d };
  };
  const from = parse(fromInput);
  const to = parse(toInput);
  if (!from || !to) return 'Custom';
  const fromMs = Date.UTC(from.y, from.m - 1, from.d);
  const toMs = Date.UTC(to.y, to.m - 1, to.d);
  if (!(fromMs < toMs)) return 'Custom';
  const day = (p: { d: number }) => String(p.d).padStart(2, '0');
  const mon = (p: { m: number }) => RANGE_MONTHS[p.m - 1] ?? '';
  if (from.y === to.y) {
    return `${day(from)} ${mon(from)} – ${day(to)} ${mon(to)} ${to.y}`;
  }
  return `${day(from)} ${mon(from)} ${from.y} – ${day(to)} ${mon(to)} ${to.y}`;
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
