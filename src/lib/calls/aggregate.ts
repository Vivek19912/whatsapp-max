// ============================================================
// Calls recording metrics — pure reduction over an account-scoped
// recording set. Used server-side by GET /api/calls/stats and
// unit-tested here; the route only fetches, never computes.
//
// The model is RECORDINGS, not calls: every metric counts or
// sums call_recordings rows exactly as stored. Nothing is
// inferred — NULL direction/call_type/duration rows are excluded
// from their respective metrics, never guessed.
// ============================================================

export interface CallsRecordingRow {
  id: string;
  contact_id: string | null;
  direction: string | null;
  call_type: string | null;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
  /** Present on dashboard fetches; absent on legacy metric rows. */
  uploaded_by?: string | null;
  phone_number?: string | null;
  file_name?: string | null;
}

export type CallTypeBucket = 'phone' | 'whatsapp' | 'whatsapp_business' | null;

/** Exact call_type classification; anything else (incl. NULL) → null (excluded). */
export function callTypeBucket(callType: string | null | undefined): CallTypeBucket {
  if (callType === 'phone') return 'phone';
  if (callType === 'whatsapp') return 'whatsapp';
  if (callType === 'whatsapp_business') return 'whatsapp_business';
  return null;
}

/** Exact direction classification; anything else (incl. NULL) → null (excluded). */
export function recordingDirection(
  direction: string | null | undefined
): 'in' | 'out' | null {
  if (direction === 'in') return 'in';
  if (direction === 'out') return 'out';
  return null;
}

export interface RecordingMetrics {
  recordingCount: number;
  /** SUM of non-null durations; null when nothing was measured. */
  recordingDurationSecs: number | null;
  incomingRecordings: number;
  outgoingRecordings: number;
  phoneRecordings: number;
  /**
   * Stored `whatsapp` rows only — the RAW split, not the reporting
   * number. User-facing WhatsApp reporting always uses
   * [mergedWhatsappRecordings] (whatsapp + whatsapp_business = one
   * "WhatsApp" category). The stored values stay distinct.
   */
  whatsappRecordings: number;
  /**
   * Stored `whatsapp_business` rows only — RAW split, never rendered
   * as its own KPI. Retained so the underlying values stay distinct
   * (recording authorization depends on the difference) and existing
   * API payloads keep their shape.
   */
  whatsappBusinessRecordings: number;
  /** DISTINCT contact_id, NULLs never counted. */
  uniqueClients: number;
  /** Rows with contact_id IS NULL. */
  unlinkedRecordings: number;
}

export function aggregateRecordingMetrics(rows: CallsRecordingRow[]): RecordingMetrics {
  const contacts = new Set<string>();
  let recordingDurationSecs = 0;
  let measured = 0;
  let incomingRecordings = 0;
  let outgoingRecordings = 0;
  let phoneRecordings = 0;
  let whatsappRecordings = 0;
  let whatsappBusinessRecordings = 0;
  let unlinkedRecordings = 0;

  for (const row of rows) {
    if (typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)) {
      recordingDurationSecs += row.duration_seconds;
      measured += 1;
    }
    const dir = recordingDirection(row.direction);
    if (dir === 'in') incomingRecordings += 1;
    if (dir === 'out') outgoingRecordings += 1;
    const type = callTypeBucket(row.call_type);
    if (type === 'phone') phoneRecordings += 1;
    if (type === 'whatsapp') whatsappRecordings += 1;
    if (type === 'whatsapp_business') whatsappBusinessRecordings += 1;
    if (row.contact_id) contacts.add(row.contact_id);
    else unlinkedRecordings += 1;
  }

  return {
    recordingCount: rows.length,
    recordingDurationSecs: measured > 0 ? recordingDurationSecs : null,
    incomingRecordings,
    outgoingRecordings,
    phoneRecordings,
    whatsappRecordings,
    whatsappBusinessRecordings,
    uniqueClients: contacts.size,
    unlinkedRecordings,
  };
}

/**
 * User-facing WhatsApp reporting count: stored `whatsapp` +
 * `whatsapp_business` folded into ONE "WhatsApp" category.
 * Regression anchor: whatsapp = 4, whatsapp_business = 3,
 * phone = 5 → WhatsApp = 7, Phone = 5. Phone stays separate.
 */
export function mergedWhatsappRecordings(metrics: {
  whatsappRecordings: number;
  whatsappBusinessRecordings: number;
}): number {
  return metrics.whatsappRecordings + metrics.whatsappBusinessRecordings;
}

// ============================================================
// Dashboard aggregation — everything the redesigned /calls
// page needs in one pass over the same bounded row set.
// Same RECORDINGS model: NULLs are excluded per-metric, never
// inferred. Pure: day bucketing takes an explicit IANA time
// zone so server and tests agree with the viewer's calendar.
// ============================================================

/** Mean of finite non-null durations; null when nothing was measured. */
export function averageDurationSecs(rows: CallsRecordingRow[]): number | null {  let sum = 0;
  let measured = 0;
  for (const row of rows) {
    if (typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)) {
      sum += row.duration_seconds;
      measured += 1;
    }
  }
  return measured > 0 ? sum / measured : null;
}

/**
 * Per-direction duration sums for the KPI cards. NULL directions are
 * excluded from both (never guessed); NULL durations are ignored.
 * Each side is null when it measured nothing (UI renders "—").
 */
export function directionDurationSecs(rows: CallsRecordingRow[]): {
  incomingDurationSecs: number | null;
  outgoingDurationSecs: number | null;
} {
  let incoming = 0;
  let incomingMeasured = 0;
  let outgoing = 0;
  let outgoingMeasured = 0;
  for (const row of rows) {
    if (typeof row.duration_seconds !== 'number' || !Number.isFinite(row.duration_seconds)) {
      continue;
    }
    const dir = recordingDirection(row.direction);
    if (dir === 'in') {
      incoming += row.duration_seconds;
      incomingMeasured += 1;
    } else if (dir === 'out') {
      outgoing += row.duration_seconds;
      outgoingMeasured += 1;
    }
  }
  return {
    incomingDurationSecs: incomingMeasured > 0 ? incoming : null,
    outgoingDurationSecs: outgoingMeasured > 0 ? outgoing : null,
  };
}

/**
 * Period-over-period percent change. Null when the previous value is
 * zero/empty (division by zero) or either side is null — the UI omits
 * the comparison line instead of inventing a trend.
 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (
    typeof current !== 'number' ||
    typeof previous !== 'number' ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

export interface DayBucket {
  /** Calendar day key in the viewer's time zone (YYYY-MM-DD). */
  date: string;
  inbound: number;
  outbound: number;
  unknown: number;
  /** SUM of finite non-null durations that day (0 when none measured). */
  durationSecs: number;
}

/** Effective time of a row: recorded_at, falling back to created_at. */
export function effectiveTimeMs(row: CallsRecordingRow): number {
  const raw = row.recorded_at ?? row.created_at;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Number.NaN;
}

function dayKeyInZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function startOfDayInZone(dayKey: string, timeZone: string): number {
  // Noon UTC is always the same calendar day in every real zone
  // (±14h), so walk back hour by hour to that zone's midnight.
  const noonUtc = Date.parse(`${dayKey}T12:00:00.000Z`);
  for (let back = 0; back <= 24; back += 1) {
    const candidate = noonUtc - back * 3_600_000;
    if (dayKeyInZone(candidate, timeZone) !== dayKey) return candidate + 3_600_000;
  }
  return noonUtc - 12 * 3_600_000;
}

/**
 * Per-day inbound/outbound/unknown counts plus duration sums, zero-filled
 * across every calendar day in [fromMs, toMs). Days are calendar days in
 * [timeZone], so a recording is never filed on the wrong day by a UTC cut.
 */
export function bucketDaily(
  rows: CallsRecordingRow[],
  opts: { fromMs: number; toMs: number; timeZone: string }
): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  const firstKey = dayKeyInZone(opts.fromMs, opts.timeZone);
  let cursor = startOfDayInZone(firstKey, opts.timeZone);
  // One bucket per calendar day; the step re-anchors to midnight so
  // 23/25h DST days neither duplicate nor skip a bucket. Strictly
  // increasing, so a corrupt zone still terminates (API caps at 366d).
  for (let i = 0; i < 400 && cursor < opts.toMs; i += 1) {
    const key = dayKeyInZone(cursor, opts.timeZone);
    if (!buckets.has(key)) {
      buckets.set(key, { date: key, inbound: 0, outbound: 0, unknown: 0, durationSecs: 0 });
    }
    let next = startOfDayInZone(key, opts.timeZone) + 86_400_000;
    if (dayKeyInZone(next, opts.timeZone) === key || next <= cursor) {
      next = cursor + 86_400_000;
    }
    cursor = next;
  }

  for (const row of rows) {
    const t = effectiveTimeMs(row);
    if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
    const key = dayKeyInZone(t, opts.timeZone);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const dir = recordingDirection(row.direction);
    if (dir === 'in') bucket.inbound += 1;
    else if (dir === 'out') bucket.outbound += 1;
    else bucket.unknown += 1;
    if (typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)) {
      bucket.durationSecs += row.duration_seconds;
    }
  }
  return [...buckets.values()];
}

export interface DurationBuckets {
  under30: number;
  from30To60: number;
  min1To5: number;
  min5To10: number;
  over10: number;
}

/** Histogram over finite non-null durations only; NULL durations excluded. */
export function bucketDurations(rows: CallsRecordingRow[]): DurationBuckets {
  const out: DurationBuckets = { under30: 0, from30To60: 0, min1To5: 0, min5To10: 0, over10: 0 };
  for (const row of rows) {
    const d = row.duration_seconds;
    if (typeof d !== 'number' || !Number.isFinite(d)) continue;
    if (d < 30) out.under30 += 1;
    else if (d < 60) out.from30To60 += 1;
    else if (d < 300) out.min1To5 += 1;
    else if (d < 600) out.min5To10 += 1;
    else out.over10 += 1;
  }
  return out;
}

export interface TopClient {
  contactId: string;
  recordings: number;
  talkTimeSecs: number;
  lastRecordedAt: string | null;
}

/** Top linked contacts by recording count (ties: talk time, then recency). */
export function topClientsByRecordings(
  rows: CallsRecordingRow[],
  limit: number
): TopClient[] {
  const byContact = new Map<string, { count: number; talk: number; lastMs: number }>();
  for (const row of rows) {
    if (!row.contact_id) continue;
    const entry =
      byContact.get(row.contact_id) ?? { count: 0, talk: 0, lastMs: Number.NaN };
    entry.count += 1;
    if (typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)) {
      entry.talk += row.duration_seconds;
    }
    const t = effectiveTimeMs(row);
    if (Number.isFinite(t) && (!Number.isFinite(entry.lastMs) || t > entry.lastMs)) {
      entry.lastMs = t;
    }
    byContact.set(row.contact_id, entry);
  }
  return [...byContact.entries()]
    .map(([contactId, v]) => ({
      contactId,
      recordings: v.count,
      talkTimeSecs: v.talk,
      lastRecordedAt: Number.isFinite(v.lastMs) ? new Date(v.lastMs).toISOString() : null,
    }))
    .sort(
      (a, b) =>
        b.recordings - a.recordings ||
        b.talkTimeSecs - a.talkTimeSecs ||
        (b.lastRecordedAt ?? '').localeCompare(a.lastRecordedAt ?? '')
    )
    .slice(0, Math.max(0, limit));
}

export interface RecentRecording {
  id: string;
  contactId: string | null;
  phoneNumber: string | null;
  direction: string | null;
  callType: string | null;
  durationSecs: number | null;
  recordedAt: string | null;
  createdAt: string;
  fileName: string | null;
}

/** Latest rows by effective time (recorded_at ?? created_at), ties by id. */
export function latestRecordings(rows: CallsRecordingRow[], limit: number): RecentRecording[] {
  return [...rows]
    .sort((a, b) => {
      const dt = effectiveTimeMs(b) - effectiveTimeMs(a);
      if (dt !== 0) return dt;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    })
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      phoneNumber: r.phone_number ?? null,
      direction: r.direction,
      callType: r.call_type,
      durationSecs:
        typeof r.duration_seconds === 'number' && Number.isFinite(r.duration_seconds)
          ? r.duration_seconds
          : null,
      recordedAt: r.recorded_at,
      createdAt: r.created_at,
      fileName: r.file_name ?? null,
    }));
}
