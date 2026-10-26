// ============================================================
// Meta Lead Ads → Google Sheets — quota handling + throttling.
//
// Meta-only. Nothing here is imported by Flow Tables, All Sheets,
// or the generic Google Sheets feature.
//
// Root cause this addresses: Google Sheets API quota errors
// (HTTP 429 / RESOURCE_EXHAUSTED, including 403
// rateLimitExceeded) were treated like any other transient error
// — fixed exponential backoff, no jitter, no Retry-After — while
// concurrent drains (5-minute cron, prompt post-response drains,
// manual sync-now/import/retry) stampeded the API and then
// retried in lockstep, burning all 8 attempts and parking rows
// the UI reported as permanently failed.
//
// This module provides:
//   * quota-error classification (status + Google reason codes),
//   * backoff with equal jitter that honors Retry-After,
//   * an in-process per-project token-bucket limiter so drains in
//     the same runtime coordinate instead of bursting together.
//     Cross-process coordination additionally happens through the
//     queue itself: a quota trip parks claimed rows with a future
//     next_retry_at, so every worker (cron, prompt, manual) backs
//     off together via the shared due-scan.
//
// Pure except the limiter (injectable clock/sleep for tests).
// ============================================================

/** Google reason codes that mean "slow down", never "reconnect". */
const QUOTA_REASONS = new Set([
  "rateLimitExceeded",
  "quotaExceeded",
  "userRateLimitExceeded",
  "RESOURCE_EXHAUSTED",
]);

/** True for a Google API reason string that signals quota. */
export function isQuotaReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (QUOTA_REASONS.has(reason)) return true;
  const lower = reason.toLowerCase();
  return (
    lower.includes("ratelimit") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted")
  );
}

/**
 * Parse a Retry-After header value (delta-seconds or HTTP date)
 * into milliseconds. Null when absent or unparseable. Pure.
 * Clamped to [0, 5 minutes] — a server-provided delay beyond
 * that is treated as "back off substantially", not as an order
 * to sleep for an hour inside a request.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Math.min(Number(trimmed) * 1000, 300_000));
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(at - now, 300_000));
}

/** Quota backoff base: 1m, 2m, 4m … capped at 30m. */
export function quotaBackoffBaseMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(60_000 * 2 ** step, 30 * 60_000);
}

/**
 * Quota retry delay: equal jitter over the exponential base,
 * never shorter than the server's Retry-After. Pure (randomness
 * injectable for tests).
 */
export function sheetsQuotaDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  rand: () => number = Math.random,
): number {
  const base = quotaBackoffBaseMs(attempt);
  const r = Math.max(0, Math.min(1, rand()));
  const jittered = Math.round(base / 2 + r * (base / 2));
  return Math.max(retryAfterMs ?? 0, jittered);
}

/**
 * Terminal parking delay for exhausted rows: 30 days. These rows
 * stop consuming quota entirely until a manual retry revives them
 * (the retry route resets attempts) or max_attempts is raised.
 */
export const EXHAUSTED_PARK_MS = 30 * 24 * 60 * 60_000;

/** Suffix appended to last_error when the retry budget is spent. */
export function exhaustedSuffix(attempts: number, maxAttempts: number): string {
  return ` — retry limit reached (${attempts}/${maxAttempts} attempts). Use Retry to try again after fixing the cause.`;
}

export interface RateLimiterOptions {
  /** Burst capacity (requests). */
  capacity?: number;
  /** Sustained rate (requests per second). */
  refillPerSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Token-bucket limiter with per-key serialized waiters.
 * `acquire` resolves when the caller may proceed. Pure logic
 * over an injectable clock/sleep, so tests run without waiting.
 */
export function createSheetsRateLimiter(opts: RateLimiterOptions = {}) {
  const capacity = opts.capacity ?? 8;
  const refillPerMs = (opts.refillPerSecond ?? 1) / 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  let chain = Promise.resolve();

  function take(key: string): number {
    let bucket = buckets.get(key);
    const at = now();
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: at };
      buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = at;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    const deficit = 1 - bucket.tokens;
    const waitMs = Math.ceil(deficit / refillPerMs);
    bucket.tokens = 0;
    return waitMs;
  }

  return {
    /** Wait until a request slot is available for `key`. */
    acquire(key = "global"): Promise<void> {
      const run = chain.then(async () => {
        const waitMs = take(key);
        if (waitMs > 0) await sleep(waitMs);
      });
      // A rejection must never break the chain for later callers.
      chain = run.catch(() => {});
      return run;
    },
  };
}

export type SheetsRateLimiter = ReturnType<typeof createSheetsRateLimiter>;

/**
 * Module singleton used by the drain (per Google project — quota
 * is project-wide, so one shared bucket is the correct scope).
 * Sustained 1 req/s (60/min, within the Sheets write quota)
 * with a burst of 8 for small syncs.
 */
export const globalSheetsLimiter = createSheetsRateLimiter({
  capacity: 8,
  refillPerSecond: 1,
});

/**
 * Wrap a fetch implementation so every Google call first takes a
 * rate-limit slot. In the test environment (NODE_ENV=test) the
 * limiter is bypassed so unit tests stay fast and deterministic;
 * production/dev traffic is paced.
 */
export function withSheetsThrottle(
  fetchImpl: typeof fetch,
  limiter: SheetsRateLimiter = globalSheetsLimiter,
  key = "global",
): typeof fetch {
  if (process.env.NODE_ENV === "test") return fetchImpl;
  return (async (input, init) => {
    await limiter.acquire(key);
    return fetchImpl(input, init);
  }) as typeof fetch;
}
