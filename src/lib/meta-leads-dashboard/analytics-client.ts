// Single-request loader for the Meta Lead Ads dashboard.
//
// One GET /api/meta-lead-ads/dashboard per (day, year), aggregated
// inside Postgres over meta_lead_submissions. No Supabase calls
// from the browser, no message/flow/Inbox data anywhere in the
// pipeline.
//
// The loader passes server-computed totals through verbatim
// (never recomputed here). rollupTrailingKpis is the one
// exception to that rule in reverse: it is NOT used by the
// loader at all — the API ROUTE calls it server-side to derive
// the rolling Last-7/Last-30 KPIs from the RPC's own daily
// buckets (same file because the helpers are isomorphic pure
// functions; see its contract below).

import type {
  MetaLeadDay,
  MetaLeadFormSplit,
  MetaLeadMonth,
  MetaLeadsAnalytics,
} from './types'

export interface MetaLeadsAnalyticsParams {
  startISO: string
  endISO: string
  prevStartISO: string
  prevEndISO: string
  year: number
  tz: string
}

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0
}

function isFormSplit(f: unknown): f is { formName: string; leads: number } {
  if (!f || typeof f !== 'object') return false
  const r = f as Record<string, unknown>
  return typeof r.formName === 'string' && typeof r.leads === 'number'
}

function normalizeForms(input: unknown): MetaLeadFormSplit[] {
  if (!Array.isArray(input)) return []
  return (input as unknown[])
    .filter(isFormSplit)
    .map((f) => ({ formName: f.formName, leads: Math.floor(f.leads) }))
    .filter((f) => f.formName !== '' && f.leads >= 0)
}

/**
 * Normalize the RPC `daily` payload to exactly 30 trailing days.
 * Malformed days are dropped (never fabricated); short payloads
 * are front-padded with zero days so the trailing edge stays
 * aligned; long payloads keep the most recent 30.
 */
export function normalizeMetaDaily(input: unknown, dayCount: number = 30): MetaLeadDay[] {
  const days: MetaLeadDay[] = Array.isArray(input)
    ? (input as unknown[]).flatMap((d) => {
        if (!d || typeof d !== 'object') return []
        const r = d as Record<string, unknown>
        if (
          typeof r.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          typeof r.total !== 'number' ||
          !Number.isFinite(r.total) ||
          r.total < 0
        ) {
          return []
        }
        return [
          {
            date: r.date,
            total: Math.floor(r.total),
            forms: normalizeForms(r.forms),
          },
        ]
      })
    : []
  const trimmed = days.slice(-dayCount)
  while (trimmed.length < dayCount) {
    trimmed.unshift({ date: '', total: 0, forms: [] })
  }
  return trimmed
}

/**
 * Rolling-window KPIs derived from the RPC's trailing-30 daily
 * series: most-recent 7 days (today + previous 6) and all 30
 * (today + previous 29). Called SERVER-SIDE by the dashboard
 * route — never by the browser loader.
 *
 * Exactness: UNIQUE(account_id, meta_lead_id) guarantees one
 * submission row per lead, so each lead occupies exactly one
 * daily bucket and a window sum EQUALS the distinct-lead count
 * for that window. Timezone bucketing, countable statuses
 * (received/processed/failed, never ignored), the
 * COALESCE(meta_created_time, created_at) timestamp, and tenant
 * scoping all come from the server buckets unchanged; the
 * normalize step additionally drops malformed days to zero and
 * pads short series so empty periods read 0, never NaN.
 */
export function rollupTrailingKpis(input: unknown): {
  last7Leads: number;
  last30Leads: number;
} {
  const days = normalizeMetaDaily(input);
  const sum = (xs: MetaLeadDay[]) => xs.reduce((acc, d) => acc + d.total, 0);
  return { last7Leads: sum(days.slice(-7)), last30Leads: sum(days) };
}

/**
 * Normalize the RPC `monthly` payload to exactly 12 months.
 * Malformed months are dropped; missing months become explicit
 * zeros so every January–December cell renders.
 */
export function normalizeMetaMonthly(input: unknown): MetaLeadMonth[] {
  const months: MetaLeadMonth[] = Array.isArray(input)
    ? (input as unknown[]).flatMap((m) => {
        if (!m || typeof m !== 'object') return []
        const r = m as Record<string, unknown>
        if (
          typeof r.month !== 'number' ||
          !Number.isInteger(r.month) ||
          r.month < 1 ||
          r.month > 12
        ) {
          return []
        }
        return [
          {
            month: r.month,
            total: toCount(r.total),
            forms: normalizeForms(r.forms),
          },
        ]
      })
    : []
  const byMonth = new Map(months.map((m) => [m.month, m]))
  return Array.from({ length: 12 }, (_, i) => {
    const existing = byMonth.get(i + 1)
    if (existing) return existing
    return { month: i + 1, total: 0, forms: [] }
  })
}

export async function loadMetaLeadsAnalytics(
  params: MetaLeadsAnalyticsParams,
  signal?: AbortSignal,
): Promise<MetaLeadsAnalytics> {
  const qs = new URLSearchParams({
    start: params.startISO,
    end: params.endISO,
    prevStart: params.prevStartISO,
    prevEnd: params.prevEndISO,
    year: String(params.year),
    tz: params.tz,
  })
  const res = await fetch(`/api/meta-lead-ads/dashboard?${qs.toString()}`, {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Meta Lead Ads analytics failed: ${res.status}`)
  }
  const json = (await res.json()) as {
    todayLeads?: unknown
    yesterdayLeads?: unknown
    last7Leads?: unknown
    last30Leads?: unknown
    daily?: unknown
    monthly?: unknown
    year?: unknown
  }

  return {
    todayLeads: toCount(json.todayLeads),
    yesterdayLeads: toCount(json.yesterdayLeads),
    last7Leads: toCount(json.last7Leads),
    last30Leads: toCount(json.last30Leads),
    daily: normalizeMetaDaily(json.daily),
    year:
      typeof json.year === 'number' && Number.isInteger(json.year)
        ? json.year
        : params.year,
    monthly: normalizeMetaMonthly(json.monthly),
  }
}
