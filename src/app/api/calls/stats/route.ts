// ============================================================
// GET /api/calls/stats — Calls dashboard analytics.
//
// The dashboard blends two exact server-side populations:
// recording metrics (KPI cards, direction, volume) from
// call_recordings, and outcome metrics (missed, answered,
// unknown) from call_events — phone call events need no
// recording, so the two populations are never added together.
// Every section below filters by the SAME resolved filter set,
// so filtered KPIs, charts, tables and lists always agree.
//
// Filters (all optional except from/to, all ANDed):
//   from, to — ISO bounds, half-open [from, to) over EFFECTIVE
//     time (recorded_at ?? created_at for recordings;
//     occurred_at for events). Max span 366 days.
//   user — auth user UUID; recordings filter uploaded_by,
//     events filter user_id.
//   direction — 'in' | 'out'. Missed/answered events are
//     inherently incoming, so 'out' yields zero outcomes.
//   call_type — 'phone' | 'whatsapp' (legacy alias
//     'whatsapp_business' folds into 'whatsapp', same as the
//     Recordings page). Events are phone-only: a non-phone
//     call-type filter matches no events.
//   q — lead/phone search, Recordings semantics: linked contacts
//     whose name matches plus digit phone match. A query with no
//     matches short-circuits to an empty result (never the
//     unfiltered list).
//   workspace_table — flow UUID: only leads holding a run in that
//     table (membership resolved via flow_runs, capped). Unlinked
//     rows can never match a specific table. A foreign or empty
//     flow matches nothing (no cross-tenant oracle).
//   status — 'linked' (contact_id NOT NULL) | 'unlinked' (IS NULL).
//   tz — IANA zone for bucketing; invalid falls back to UTC.
//     Bounds are absolute; tz only affects day/hour/weekday bins.
//
// Security: RLS-scoped SSR client (caller's JWT) + explicit
// account_id filter; account comes from the session, never from
// query params. Storage bucket/path are never selected —
// playback goes through /api/recordings/[id]/audio.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import {
  flowContactIds,
  workspaceTableNamesByContactId,
} from '@/lib/recordings/workspace-tables';
import { uploaderNamesByUserId } from '@/lib/recordings/uploaders';
import {
  bucketHourly,
  bucketTrend,
  bucketWeekday,
  latestRecordings,
  pickTrendGranularity,
  type CallsRecordingRow,
} from '@/lib/calls/aggregate';

/** Hard row cap: bounds the list-view fetch per window. */
const MAX_ROWS = 5000;
/** Page size for the chunked reads. */
const FETCH_PAGE = 1000;
/** Max selectable window, mirroring the daily-range convention. */
const MAX_SPAN_DAYS = 366;
/** Rows shown in the Recent calls table (recordings + missed). */
const RECENT_LIMIT = 8;
/** Missed events pulled for the Recent calls table. */
const RECENT_MISSED_LIMIT = 10;
/** Contact-id prefetch cap for text search (mirrors the Recordings list). */
const SEARCH_CONTACT_LIMIT = 100;
// Note: the workspace-table contact set is capped inside the shared
// flowContactIds helper (WORKSPACE_TABLE_CONTACT_LIMIT).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_TYPES = ['phone', 'whatsapp', 'whatsapp_business'] as const;

function parseBound(value: string | null): number | null {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

function resolveTimeZone(raw: string | null): string {
  if (!raw) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

type RecorderQuery = {
  // Minimal structural type for the supabase query builder in use.
  eq: (col: string, v: string) => RecorderQuery;
  in: (col: string, v: string[]) => RecorderQuery;
  is: (col: string, v: null) => RecorderQuery;
  not: (col: string, op: string, v: null) => RecorderQuery;
  or: (f: string) => RecorderQuery;
  gte: (col: string, v: string) => RecorderQuery;
  lt: (col: string, v: string) => RecorderQuery;
  order: (col: string, opts?: unknown) => RecorderQuery;
  limit: (n: number) => RecorderQuery;
  then: (
    resolve: (v: { data: unknown[] | null; error: unknown }) => unknown
  ) => unknown;
  range: (
    a: number,
    b: number
  ) => Promise<{ data: unknown[] | null; error: unknown }>;
};

interface RowFilters {
  user: string | null;
  direction: string | null;
  callType: string | null;
  contactIds: string[] | null;
  phoneDigits: string | null;
  status: string | null;
}

async function fetchWindow(
  supabase: { from: (t: string) => { select: (c: string) => RecorderQuery } },
  accountId: string,
  fromISO: string,
  toISO: string,
  f: RowFilters
): Promise<{ rows: CallsRecordingRow[]; truncated: boolean }> {
  // Search/table contact constraint, computed once and shared by
  // the OR branches below. When a workspace table is selected the
  // phone-digits half is disabled (it would otherwise match
  // unlinked recordings that can never belong to a table).
  const searchParts: string[] = [];
  if (f.contactIds && f.contactIds.length > 0) {
    searchParts.push(`contact_id.in.(${f.contactIds.join(',')})`);
  }
  if (f.phoneDigits) {
    searchParts.push(`phone_number.ilike.*${f.phoneDigits}*`);
  }
  const searchOr =
    searchParts.length > 0 ? `,or(${searchParts.join(',')})` : '';
  const orFilter =
    `and(recorded_at.gte.${fromISO},recorded_at.lt.${toISO}${searchOr}),` +
    `and(recorded_at.is.null,created_at.gte.${fromISO},created_at.lt.${toISO}${searchOr})`;
  const rows: CallsRecordingRow[] = [];
  let truncated = false;
  for (let offset = 0; offset < MAX_ROWS; offset += FETCH_PAGE) {
    let query = supabase
      .from('call_recordings')
      .select(
        'id, contact_id, direction, call_type, duration_seconds, recorded_at, created_at, uploaded_by, phone_number, file_name'
      )
      .eq('account_id', accountId);
    if (f.user) query = query.eq('uploaded_by', f.user);
    if (f.direction === 'in' || f.direction === 'out')
      query = query.eq('direction', f.direction);
    if (f.direction === 'unknown') query = query.is('direction', null);
    if (f.callType === 'phone') query = query.eq('call_type', 'phone');
    if (f.callType === 'whatsapp')
      query = query.in('call_type', ['whatsapp', 'whatsapp_business']);
    if (f.contactIds && f.contactIds.length > 0)
      query = query.in('contact_id', f.contactIds);
    if (f.status === 'linked') query = query.not('contact_id', 'is', null);
    if (f.status === 'unlinked') query = query.is('contact_id', null);
    const { data, error } = await query
      .or(orFilter)
      .range(offset, offset + FETCH_PAGE - 1);
    if (error) throw error;
    const page = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      contact_id: (r.contact_id as string | null) ?? null,
      direction: (r.direction as string | null) ?? null,
      call_type: (r.call_type as string | null) ?? null,
      duration_seconds:
        typeof r.duration_seconds === 'number' ? r.duration_seconds : null,
      recorded_at: (r.recorded_at as string | null) ?? null,
      created_at: r.created_at as string,
      uploaded_by: (r.uploaded_by as string | null) ?? null,
      phone_number: (r.phone_number as string | null) ?? null,
      file_name: (r.file_name as string | null) ?? null,
    }));
    rows.push(...page);
    if (page.length < FETCH_PAGE) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

interface MissedEvent {
  id: string;
  contact_id: string | null;
  phone_number: string | null;
  user_id: string | null;
  occurred_at: string;
}

async function fetchRecentMissed(
  supabase: { from: (t: string) => { select: (c: string) => RecorderQuery } },
  accountId: string,
  fromISO: string,
  toISO: string,
  f: RowFilters
): Promise<MissedEvent[]> {
  // Missed events are inherently incoming phone calls; any
  // other direction or a non-phone call-type filter matches none.
  if (f.direction && f.direction !== 'in') return [];
  if (f.callType && f.callType !== 'phone') return [];
  let query = supabase
    .from('call_events')
    .select('id, contact_id, phone_number, user_id, occurred_at')
    .eq('account_id', accountId)
    .eq('outcome', 'missed');
  if (f.user) query = query.eq('user_id', f.user);
  if (f.contactIds && f.contactIds.length > 0)
    query = query.in('contact_id', f.contactIds);
  if (f.phoneDigits) query = query.or(`phone_number.ilike.*${f.phoneDigits}*`);
  if (f.status === 'linked') query = query.not('contact_id', 'is', null);
  if (f.status === 'unlinked') query = query.is('contact_id', null);
  const { data, error } = await query
    .gte('occurred_at', fromISO)
    .lt('occurred_at', toISO)
    .order('occurred_at', { ascending: false })
    .limit(RECENT_MISSED_LIMIT);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    contact_id: (r.contact_id as string | null) ?? null,
    phone_number: (r.phone_number as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    occurred_at: r.occurred_at as string,
  }));
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const params = new URL(request.url).searchParams;
    const from = parseBound(params.get('from'));
    const to = parseBound(params.get('to'));
    if (from === null || to === null || !(from < to)) {
      return NextResponse.json(
        {
          error:
            "'from' and 'to' must be valid ISO timestamps with 'from' before 'to'.",
        },
        { status: 400 }
      );
    }
    if ((to - from) / 86_400_000 > MAX_SPAN_DAYS) {
      return NextResponse.json(
        { error: `Date range must be ${MAX_SPAN_DAYS} days or less.` },
        { status: 400 }
      );
    }
    const user = params.get('user')?.trim() || null;
    if (user && !UUID_RE.test(user)) {
      return NextResponse.json(
        { error: "'user' must be a valid user id." },
        { status: 400 }
      );
    }
    const direction = params.get('direction')?.trim() || null;
    if (
      direction &&
      direction !== 'in' &&
      direction !== 'out' &&
      direction !== 'unknown'
    ) {
      return NextResponse.json(
        { error: "'direction' must be 'in', 'out', or 'unknown'." },
        { status: 400 }
      );
    }
    const callTypeRaw = params.get('call_type')?.trim() || null;
    if (
      callTypeRaw &&
      !(CALL_TYPES as readonly string[]).includes(callTypeRaw)
    ) {
      return NextResponse.json(
        { error: "'call_type' must be phone, whatsapp, or whatsapp_business." },
        { status: 400 }
      );
    }
    // Legacy alias folds into the merged WhatsApp reporting category.
    const callType =
      callTypeRaw === 'whatsapp_business' ? 'whatsapp' : callTypeRaw;
    const workspaceTable = params.get('workspace_table')?.trim() || null;
    if (workspaceTable && !UUID_RE.test(workspaceTable)) {
      return NextResponse.json(
        { error: "'workspace_table' must be a valid flow id." },
        { status: 400 }
      );
    }
    const status = params.get('status')?.trim() || null;
    if (status && status !== 'linked' && status !== 'unlinked') {
      return NextResponse.json(
        { error: "'status' must be linked or unlinked." },
        { status: 400 }
      );
    }
    const q = params.get('q')?.trim() || null;
    const timeZone = resolveTimeZone(params.get('tz')?.trim() || null);

    const fromISO = new Date(from).toISOString();
    const toISO = new Date(to).toISOString();

    // --- Shared filter resolution (Recordings list semantics) ---
    // Text search: linked-lead ids whose name matches, plus phone
    // digits. A query with no matches short-circuits to the empty
    // dashboard rather than the unfiltered list.
    let searchContactIds: string[] | null = null;
    let searchDigits: string | null = null;
    if (q) {
      const digits = normalizePhone(q);
      searchDigits = digits.length >= 3 ? digits : null;
      const orParts = [`name.ilike.%${q}%`];
      if (searchDigits) orParts.push(`phone_normalized.eq.${searchDigits}`);
      const { data: hits, error: hitsError } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .or(orParts.join(','))
        .limit(SEARCH_CONTACT_LIMIT);
      if (hitsError) throw hitsError;
      searchContactIds = ((hits ?? []) as Array<{ id: string }>).map(
        (h) => h.id
      );
      if (searchContactIds.length === 0 && !searchDigits) {
        return NextResponse.json(emptyDashboard());
      }
    }

    // Workspace Table filter: the flow's lead membership (foreign or
    // empty flows match nothing — no cross-tenant oracle).
    let tableContactIds: string[] | null = null;
    if (workspaceTable) {
      tableContactIds = await flowContactIds(
        supabase,
        accountId,
        workspaceTable
      );
      if (tableContactIds.length === 0) {
        return NextResponse.json(emptyDashboard());
      }
    }

    // A specific table ANDs with text search (intersection); either
    // alone passes its own set through. With a table selected the
    // phone-digits half is disabled — its only unique contribution
    // is unlinked recordings, which can never belong to a table.
    const effectiveDigits = tableContactIds ? null : searchDigits;
    let rpcContactIds: string[] | null = null;
    if (tableContactIds && searchContactIds) {
      rpcContactIds = tableContactIds.filter((id) =>
        searchContactIds.includes(id)
      );
    } else if (tableContactIds || searchContactIds) {
      rpcContactIds = (tableContactIds ?? searchContactIds) as string[];
    }
    if (
      (tableContactIds || q) &&
      (rpcContactIds?.length ?? 0) === 0 &&
      !effectiveDigits
    ) {
      return NextResponse.json(emptyDashboard());
    }

    const rowFilters = {
      user,
      direction,
      callType,
      contactIds: rpcContactIds,
      phoneDigits: effectiveDigits,
      status,
    };

    const client = supabase as unknown as {
      from: (t: string) => { select: (c: string) => RecorderQuery };
    };
    const [
      { rows, truncated },
      kpiData,
      outcomesData,
      salespersonData,
      missedRows,
    ] = await Promise.all([
      fetchWindow(client, accountId, fromISO, toISO, rowFilters),
      supabase
        .rpc('call_kpis_summary', {
          p_account_id: accountId,
          p_from: fromISO,
          p_to: toISO,
          p_uploaded_by: user,
          p_direction: direction,
          p_call_type: callType,
          p_contact_ids: rpcContactIds,
          p_phone: effectiveDigits,
          p_status: status,
        })
        .then((r) => {
          if (r.error) throw r.error;
          return r.data;
        }),
      supabase
        .rpc('call_event_outcomes_summary', {
          p_account_id: accountId,
          p_from: fromISO,
          p_to: toISO,
          p_user_id: user,
          p_direction: direction,
          p_contact_ids: rpcContactIds,
          p_phone: effectiveDigits,
          p_status: status,
          p_call_type: callType,
        })
        .then((r) => {
          if (r.error) throw r.error;
          return r.data;
        }),
      supabase
        .rpc('call_salesperson_stats', {
          p_account_id: accountId,
          p_from: fromISO,
          p_to: toISO,
          p_user_id: user,
          p_direction: direction,
          p_call_type: callType,
          p_contact_ids: rpcContactIds,
          p_phone: effectiveDigits,
          p_status: status,
        })
        .then((r) => {
          if (r.error) throw r.error;
          return r.data;
        }),
      fetchRecentMissed(client, accountId, fromISO, toISO, rowFilters),
    ]);

    const kpi = toKpis(kpiData);
    const outcomes = toOutcomes(outcomesData);

    // Contact display names/phones for the recent lists: one batched
    // account-scoped lookup, never N+1. Deleted contacts resolve to
    // null ('Unlinked').
    const contactIds = [
      ...new Set(
        [
          ...rows.map((r) => r.contact_id),
          ...missedRows.map((r) => r.contact_id),
        ].filter(Boolean) as string[]
      ),
    ];
    const contactNames = new Map<
      string,
      { name: string | null; phone: string | null }
    >();
    if (contactIds.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .in('id', contactIds);
      if (error) throw error;
      for (const c of (data ?? []) as Array<Record<string, unknown>>) {
        contactNames.set(c.id as string, {
          name: (c.name as string | null) ?? null,
          phone: (c.phone as string | null) ?? null,
        });
      }
    }

    // Workspace table names for recent rows + salesperson display
    // names: two batched account-scoped lookups, never N+1.
    const workspaceTables = await workspaceTableNamesByContactId(
      supabase,
      accountId,
      contactIds
    );
    const salespersonUserIds = [
      ...new Set(
        [
          ...rows.map((r) => r.uploaded_by).filter(Boolean),
          ...missedRows.map((r) => r.user_id).filter(Boolean),
          ...((salespersonData ?? []) as Array<{ user_id?: unknown }>).map(
            (r) => (typeof r.user_id === 'string' ? r.user_id : null)
          ),
        ].filter(Boolean) as string[]
      ),
    ];
    const salespersonNames = await uploaderNamesByUserId(
      supabase,
      salespersonUserIds
    );

    const granularity = pickTrendGranularity(from, to);
    const trendBuckets = bucketTrend(rows, {
      fromMs: from,
      toMs: to,
      timeZone,
      granularity,
    });

    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const recent = latestRecordings(rows, RECENT_LIMIT).map((r) => {
      const full = rowsById.get(r.id);
      const uploaderId = full?.uploaded_by ?? null;
      return {
        ...r,
        contactName: r.contactId
          ? (contactNames.get(r.contactId)?.name ?? null)
          : null,
        phoneNumber: r.contactId
          ? (contactNames.get(r.contactId)?.phone ?? r.phoneNumber)
          : r.phoneNumber,
        uploaderName: uploaderId
          ? (salespersonNames[uploaderId] ?? null)
          : null,
        workspaceTable: r.contactId
          ? (workspaceTables[r.contactId] ?? null)
          : null,
      };
    });

    const recentMissed = missedRows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      contactName: r.contact_id
        ? (contactNames.get(r.contact_id)?.name ?? null)
        : null,
      phoneNumber: r.contact_id
        ? (contactNames.get(r.contact_id)?.phone ?? r.phone_number)
        : r.phone_number,
      occurredAt: r.occurred_at,
      workspaceTable: r.contact_id
        ? (workspaceTables[r.contact_id] ?? null)
        : null,
      ownerName: r.user_id ? (salespersonNames[r.user_id] ?? null) : null,
    }));

    const salesperson = (
      (salespersonData ?? []) as Array<Record<string, unknown>>
    ).map((r) => {
      const recordings = typeof r.recordings === 'number' ? r.recordings : 0;
      const durationSecs =
        typeof r.duration_secs === 'number' ? r.duration_secs : 0;
      const answered = typeof r.answered === 'number' ? r.answered : 0;
      const missed = typeof r.missed === 'number' ? r.missed : 0;
      const denom = answered + missed;
      return {
        userId: r.user_id as string,
        name: salespersonNames[r.user_id as string] ?? null,
        recordings,
        durationSecs,
        answered,
        missed,
        answerRate: denom > 0 ? answered / denom : null,
      };
    });

    return NextResponse.json({
      recordingCount: kpi.total,
      recordingDurationSecs: kpi.durationSecs,
      incomingRecordings: kpi.incoming,
      outgoingRecordings: kpi.outgoing,
      unknownDirectionRecordings: kpi.total - kpi.incoming - kpi.outgoing,
      phoneRecordings: kpi.phone,
      whatsappRecordings: kpi.whatsapp,
      whatsappBusinessRecordings: kpi.whatsappBusiness,
      missedRecordings: outcomes.missed,
      rejectedRecordings: outcomes.rejected,
      answeredEvents: outcomes.answered,
      unknownEvents: outcomes.unknown,
      totalEvents: outcomes.answered + outcomes.missed + outcomes.unknown,
      salesperson,
      hourly: bucketHourly(rows, { fromMs: from, toMs: to, timeZone }),
      weekday: bucketWeekday(rows, { fromMs: from, toMs: to, timeZone }),
      trend: {
        granularity,
        buckets: trendBuckets,
      },
      recent,
      recentMissed,
      truncated,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function emptyDashboard() {
  return {
    recordingCount: 0,
    recordingDurationSecs: null,
    incomingRecordings: 0,
    outgoingRecordings: 0,
    unknownDirectionRecordings: 0,
    phoneRecordings: 0,
    whatsappRecordings: 0,
    whatsappBusinessRecordings: 0,
    missedRecordings: 0,
    rejectedRecordings: 0,
    answeredEvents: 0,
    unknownEvents: 0,
    totalEvents: 0,
    salesperson: [],
    hourly: new Array<number>(24).fill(0),
    weekday: new Array<number>(7).fill(0),
    trend: { granularity: 'day', buckets: [] },
    recent: [],
    recentMissed: [],
    truncated: false,
  };
}

/**
 * Coerce the outcomes RPC's JSONB. Never null-coerces a real
 * number to zero — counts are exact by construction; missing
 * members fall back to zero (transport-skew guard only).
 */
function toOutcomes(data: unknown): {
  missed: number;
  rejected: number;
  answered: number;
  unknown: number;
} {
  const none = { missed: 0, rejected: 0, answered: 0, unknown: 0 };
  if (!data || typeof data !== 'object') return none;
  const row = data as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    missed: count(row.missed),
    rejected: count(row.rejected),
    answered: count(row.answered),
    unknown: count(row.unknown),
  };
}

/**
 * Coerce the KPI RPC's JSONB to card values. Counts are always
 * present (COUNT never yields NULL); duration sums are NULL when
 * nothing was measured (UI renders "—"). Non-finite or missing
 * members fall back safely — the function always returns all
 * keys, so this only guards transport skew.
 */
function toKpis(data: unknown): {
  total: number;
  durationSecs: number | null;
  incoming: number;
  outgoing: number;
  phone: number;
  whatsapp: number;
  whatsappBusiness: number;
} {
  const none = {
    total: 0,
    durationSecs: null as number | null,
    incoming: 0,
    outgoing: 0,
    phone: 0,
    whatsapp: 0,
    whatsappBusiness: 0,
  };
  if (!data || typeof data !== 'object') return none;
  const row = data as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const sum = (v: unknown) =>
    v === null || v === undefined
      ? null
      : typeof v === 'number' && Number.isFinite(v)
        ? v
        : null;
  return {
    total: count(row.total),
    durationSecs: sum(row.durationSecs),
    incoming: count(row.incoming),
    outgoing: count(row.outgoing),
    phone: count(row.phone),
    whatsapp: count(row.whatsapp),
    whatsappBusiness: count(row.whatsappBusiness),
  };
}
