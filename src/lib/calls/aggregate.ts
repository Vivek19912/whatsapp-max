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
export function callTypeBucket(
  callType: string | null | undefined
): CallTypeBucket {
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

export function aggregateRecordingMetrics(
  rows: CallsRecordingRow[]
): RecordingMetrics {
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
    if (
      typeof row.duration_seconds === 'number' &&
      Number.isFinite(row.duration_seconds)
    ) {
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
export function averageDurationSecs(rows: CallsRecordingRow[]): number | null {
  let sum = 0;
  let measured = 0;
  for (const row of rows) {
    if (
      typeof row.duration_seconds === 'number' &&
      Number.isFinite(row.duration_seconds)
    ) {
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
    if (
      typeof row.duration_seconds !== 'number' ||
      !Number.isFinite(row.duration_seconds)
    ) {
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

/** One salesperson's combined recording + call-event totals. */
export interface SalespersonAggregate {
  userId: string;
  name: string | null;
  recordings: number;
  durationSecs: number;
  answered: number;
  missed: number;
  /** answered / (answered + missed); null when there are no events. */
  answerRate: number | null;
}

export interface SalespersonMember {
  user_id: string;
  label: string;
}

/**
 * Merge per-salesperson RPC rows with the team roster so every
 * authorized salesperson appears — members with no activity get a
 * zero row. Sorted by recordings, then talk time, then name, so
 * zero-activity members sink to the bottom.
 */
export function mergeSalespersonRows(
  rows: SalespersonAggregate[],
  members: SalespersonMember[]
): SalespersonAggregate[] {
  const seen = new Set(rows.map((r) => r.userId));
  const zeroRows: SalespersonAggregate[] = members
    .filter((m) => !seen.has(m.user_id))
    .map((m) => ({
      userId: m.user_id,
      name: m.label,
      recordings: 0,
      durationSecs: 0,
      answered: 0,
      missed: 0,
      answerRate: null,
    }));
  return [...rows, ...zeroRows].sort((a, b) => {
    if (b.recordings !== a.recordings) return b.recordings - a.recordings;
    if (b.durationSecs !== a.durationSecs)
      return b.durationSecs - a.durationSecs;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
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
    if (dayKeyInZone(candidate, timeZone) !== dayKey)
      return candidate + 3_600_000;
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
      buckets.set(key, {
        date: key,
        inbound: 0,
        outbound: 0,
        unknown: 0,
        durationSecs: 0,
      });
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
    if (
      typeof row.duration_seconds === 'number' &&
      Number.isFinite(row.duration_seconds)
    ) {
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
  const out: DurationBuckets = {
    under30: 0,
    from30To60: 0,
    min1To5: 0,
    min5To10: 0,
    over10: 0,
  };
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
  const byContact = new Map<
    string,
    { count: number; talk: number; lastMs: number }
  >();
  for (const row of rows) {
    if (!row.contact_id) continue;
    const entry = byContact.get(row.contact_id) ?? {
      count: 0,
      talk: 0,
      lastMs: Number.NaN,
    };
    entry.count += 1;
    if (
      typeof row.duration_seconds === 'number' &&
      Number.isFinite(row.duration_seconds)
    ) {
      entry.talk += row.duration_seconds;
    }
    const t = effectiveTimeMs(row);
    if (
      Number.isFinite(t) &&
      (!Number.isFinite(entry.lastMs) || t > entry.lastMs)
    ) {
      entry.lastMs = t;
    }
    byContact.set(row.contact_id, entry);
  }
  return [...byContact.entries()]
    .map(([contactId, v]) => ({
      contactId,
      recordings: v.count,
      talkTimeSecs: v.talk,
      lastRecordedAt: Number.isFinite(v.lastMs)
        ? new Date(v.lastMs).toISOString()
        : null,
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
export function latestRecordings(
  rows: CallsRecordingRow[],
  limit: number
): RecentRecording[] {
  return [...rows]
    .sort((a, b) => {
      const dt = effectiveTimeMs(b) - effectiveTimeMs(a);
      if (dt !== 0) return dt;
      if (a.created_at !== b.created_at)
        return a.created_at < b.created_at ? 1 : -1;
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
        typeof r.duration_seconds === 'number' &&
        Number.isFinite(r.duration_seconds)
          ? r.duration_seconds
          : null,
      recordedAt: r.recorded_at,
      createdAt: r.created_at,
      fileName: r.file_name ?? null,
    }));
}

// ============================================================
// Trend + activity buckets for the redesigned dashboard. Same
// RECORDINGS model and the same in-zone day arithmetic as
// bucketDaily above: rows outside [fromMs, toMs) are ignored,
// and every bin carries inbound/outbound/unknown splits plus a
// measured-duration sum. Empty bins are zero-filled so ranges
// with no calls render honest gaps, never fabricated spikes.
// ============================================================

export interface TrendBucket {
  /** Stable key (day YYYY-MM-DD, week Monday YYYY-MM-DD, month YYYY-MM). */
  key: string;
  /** Short axis label ("Oct 17", "Nov 3", "Nov"). */
  label: string;
  inbound: number;
  outbound: number;
  unknown: number;
  /** SUM of finite non-null durations in the bin; 0 when none measured. */
  durationSecs: number;
}

export type TrendGranularity = 'day' | 'week' | 'month';

/**
 * Granularity picker: daily up to ~a month of data, weekly up to
 * ~half a year, monthly above that — so axes never overcrowd.
 * Pure (span-driven); the route passes the window it queried.
 */
export function pickTrendGranularity(
  fromMs: number,
  toMs: number
): TrendGranularity {
  const days = (toMs - fromMs) / 86_400_000;
  if (days <= 31) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function dayLabelInZone(dayKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  return `${SHORT_MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** Monday (00:00) of the week containing `ms`, in the given zone. */
function weekStartMsInZone(ms: number, timeZone: string): number {
  const dayStart = startOfDayInZone(dayKeyInZone(ms, timeZone), timeZone);
  // getUTCDay is stable here: dayStart is a real zone midnight.
  const dow = new Date(dayStart).getUTCDay();
  const backDays = (dow + 6) % 7;
  return dayStart - backDays * 86_400_000;
}

function monthKeyInZone(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return SHORT_MONTHS[Number(m[2]) - 1] ?? key;
}

/**
 * Trend buckets at the requested granularity over [fromMs, toMs),
 * zero-filled across the window. Weeks start Monday in-zone;
 * months are calendar months in-zone (month key YYYY-MM).
 */
export function bucketTrend(
  rows: CallsRecordingRow[],
  opts: {
    fromMs: number;
    toMs: number;
    timeZone: string;
    granularity: TrendGranularity;
  }
): TrendBucket[] {
  const { granularity } = opts;
  const buckets = new Map<string, TrendBucket>();
  if (granularity === 'day') {
    for (const d of bucketDaily(rows, opts)) {
      buckets.set(d.date, {
        key: d.date,
        label: dayLabelInZone(d.date),
        inbound: d.inbound,
        outbound: d.outbound,
        unknown: d.unknown,
        durationSecs: d.durationSecs,
      });
    }
    return [...buckets.values()];
  }
  if (granularity === 'week') {
    // DST-safe walk day by day (same anchor logic as bucketDaily),
    // ensuring one bucket per in-window Monday — a fixed 7-day step
    // could land on Sunday across a 25-hour day and mint a stray
    // empty bucket.
    const firstKey = dayKeyInZone(opts.fromMs, opts.timeZone);
    let cursor = startOfDayInZone(firstKey, opts.timeZone);
    for (let i = 0; i < 400 && cursor < opts.toMs; i += 1) {
      const mondayKey = dayKeyInZone(
        weekStartMsInZone(cursor, opts.timeZone),
        opts.timeZone
      );
      if (!buckets.has(mondayKey)) {
        buckets.set(mondayKey, {
          key: mondayKey,
          label: dayLabelInZone(mondayKey),
          inbound: 0,
          outbound: 0,
          unknown: 0,
          durationSecs: 0,
        });
      }
      let next =
        startOfDayInZone(dayKeyInZone(cursor, opts.timeZone), opts.timeZone) +
        86_400_000;
      if (
        dayKeyInZone(next, opts.timeZone) ===
          dayKeyInZone(cursor, opts.timeZone) ||
        next <= cursor
      ) {
        next = cursor + 86_400_000;
      }
      cursor = next;
    }
    for (const row of rows) {
      const t = effectiveTimeMs(row);
      if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
      const key = dayKeyInZone(
        weekStartMsInZone(t, opts.timeZone),
        opts.timeZone
      );
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const dir = recordingDirection(row.direction);
      if (dir === 'in') bucket.inbound += 1;
      else if (dir === 'out') bucket.outbound += 1;
      else bucket.unknown += 1;
      if (
        typeof row.duration_seconds === 'number' &&
        Number.isFinite(row.duration_seconds)
      ) {
        bucket.durationSecs += row.duration_seconds;
      }
    }
    return [...buckets.values()];
  }
  const seen = new Map<string, TrendBucket>();
  const startKey = monthKeyInZone(opts.fromMs, opts.timeZone);
  const endKey = monthKeyInZone(opts.toMs - 1, opts.timeZone);
  // Walk month starts from the window's first month through its last.
  let cursorKey = startKey;
  for (let i = 0; i < 60 && cursorKey <= endKey; i += 1) {
    if (!seen.has(cursorKey)) {
      seen.set(cursorKey, {
        key: cursorKey,
        label: monthLabel(cursorKey),
        inbound: 0,
        outbound: 0,
        unknown: 0,
        durationSecs: 0,
      });
    }
    const m = /^(\d{4})-(\d{2})$/.exec(cursorKey);
    if (!m) break;
    const nextMonth =
      Number(m[2]) === 12
        ? `${Number(m[1]) + 1}-01`
        : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}`;
    if (nextMonth <= cursorKey) break;
    cursorKey = nextMonth;
  }
  for (const row of rows) {
    const t = effectiveTimeMs(row);
    if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
    const key = monthKeyInZone(t, opts.timeZone);
    const bucket = seen.get(key);
    if (!bucket) continue;
    const dir = recordingDirection(row.direction);
    if (dir === 'in') bucket.inbound += 1;
    else if (dir === 'out') bucket.outbound += 1;
    else bucket.unknown += 1;
    if (
      typeof row.duration_seconds === 'number' &&
      Number.isFinite(row.duration_seconds)
    ) {
      bucket.durationSecs += row.duration_seconds;
    }
  }
  return [...seen.values()];
}

/** 24 hourly bins (index = in-zone hour 0–23) counting effective-time rows. */
export function bucketHourly(
  rows: CallsRecordingRow[],
  opts: { fromMs: number; toMs: number; timeZone: string }
): number[] {
  const out = new Array<number>(24).fill(0);
  for (const row of rows) {
    const t = effectiveTimeMs(row);
    if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: opts.timeZone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date(t))
    );
    const h = hour === 24 ? 0 : hour;
    if (Number.isInteger(h) && h >= 0 && h < 24) out[h] += 1;
  }
  return out;
}

export const WEEKDAY_LABELS = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

/**
 * 7 weekday bins, Monday-first, counting effective-time rows in-zone.
 * Weeks are purely calendrical — no normalization by how many of
 * each weekday fall in the window.
 */
export function bucketWeekday(
  rows: CallsRecordingRow[],
  opts: { fromMs: number; toMs: number; timeZone: string }
): number[] {
  const out = new Array<number>(7).fill(0);
  for (const row of rows) {
    const t = effectiveTimeMs(row);
    if (!Number.isFinite(t) || t < opts.fromMs || t >= opts.toMs) continue;
    // Monday-first index from the zone-local weekday.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: opts.timeZone,
      weekday: 'short',
    }).format(new Date(t));
    const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(
      parts
    );
    if (idx >= 0) out[idx] += 1;
  }
  return out;
}
