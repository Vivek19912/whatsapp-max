// Single-request loader for the Meta Lead Ads dashboard.
//
// One GET /api/meta-lead-ads/dashboard per (day, year), aggregated
// inside Postgres over meta_lead_submissions. No Supabase calls
// from the browser, no message/flow/Inbox data anywhere in the
// pipeline.

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
    daily?: unknown
    monthly?: unknown
    year?: unknown
  }

  return {
    todayLeads: toCount(json.todayLeads),
    yesterdayLeads: toCount(json.yesterdayLeads),
    daily: normalizeMetaDaily(json.daily),
    year:
      typeof json.year === 'number' && Number.isInteger(json.year)
        ? json.year
        : params.year,
    monthly: normalizeMetaMonthly(json.monthly),
  }
}
