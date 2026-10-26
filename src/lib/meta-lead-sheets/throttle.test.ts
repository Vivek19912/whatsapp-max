// Meta Sheets throttling — Retry-After parsing, quota detection,
// jittered backoff, and the in-process rate limiter. Pure logic
// over injectable clocks; no Google calls, no waiting.

import { describe, expect, it } from 'vitest';

import {
  createSheetsRateLimiter,
  exhaustedSuffix,
  isQuotaReason,
  parseRetryAfterMs,
  quotaBackoffBaseMs,
  sheetsQuotaDelayMs,
  withSheetsThrottle,
} from './throttle';

describe('isQuotaReason', () => {
  it('matches Google quota codes and free-text variants', () => {
    expect(isQuotaReason('rateLimitExceeded')).toBe(true);
    expect(isQuotaReason('quotaExceeded')).toBe(true);
    expect(isQuotaReason('userRateLimitExceeded')).toBe(true);
    expect(isQuotaReason('RESOURCE_EXHAUSTED')).toBe(true);
    expect(isQuotaReason('Quota exceeded for quota group')).toBe(true);
    expect(isQuotaReason('invalid credentials')).toBe(false);
    expect(isQuotaReason(null)).toBe(false);
    expect(isQuotaReason(undefined)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and clamps to 5 minutes', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('  3 ')).toBe(3_000);
    expect(parseRetryAfterMs('3600')).toBe(300_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });
  it('parses HTTP dates relative to now', () => {
    const now = Date.parse('2026-05-01T10:00:00.000Z');
    const future = new Date(now + 45_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(45_000);
    expect(parseRetryAfterMs(new Date(now - 1_000).toUTCString(), now)).toBe(0);
  });
  it('returns null for absent or garbage values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});

describe('sheetsQuotaDelayMs', () => {
  it('backs off exponentially with jitter (attempt 1: 30–60s)', () => {
    expect(sheetsQuotaDelayMs(1, null, () => 0)).toBe(30_000);
    expect(sheetsQuotaDelayMs(1, null, () => 1)).toBe(60_000);
    expect(sheetsQuotaDelayMs(2, null, () => 0)).toBe(60_000);
    expect(sheetsQuotaDelayMs(2, null, () => 1)).toBe(120_000);
  });
  it('caps at 30 minutes', () => {
    expect(sheetsQuotaDelayMs(99, null, () => 1)).toBe(30 * 60_000);
  });
  it('never goes below a server Retry-After', () => {
    expect(sheetsQuotaDelayMs(1, 120_000, () => 0)).toBe(120_000);
    expect(sheetsQuotaDelayMs(5, 10_000, () => 1)).toBeGreaterThanOrEqual(
      10_000
    );
  });
  it('quotaBackoffBaseMs doubles then caps', () => {
    expect(quotaBackoffBaseMs(1)).toBe(60_000);
    expect(quotaBackoffBaseMs(3)).toBe(240_000);
    expect(quotaBackoffBaseMs(10)).toBe(30 * 60_000);
  });
});

describe('exhaustedSuffix', () => {
  it('names the spent budget and the manual path', () => {
    const suffix = exhaustedSuffix(8, 8);
    expect(suffix).toContain('8/8');
    expect(suffix).toContain('Retry');
  });
});

describe('createSheetsRateLimiter', () => {
  it('allows bursts then paces with the fake clock (no real waiting)', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = createSheetsRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);
    await limiter.acquire();
    // Third acquire waits ~1s for the next token.
    expect(sleeps).toEqual([1000]);
    expect(now).toBe(1000);
  });

  it('serializes concurrent acquirers in order', async () => {
    let now = 0;
    const order: string[] = [];
    const limiter = createSheetsRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        limiter.acquire().then(() => {
          order.push(name);
        })
      )
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('withSheetsThrottle', () => {
  it('passes fetch through untouched in the test env', async () => {
    const fetchImpl = (async () => new Response('ok')) as typeof fetch;
    expect(withSheetsThrottle(fetchImpl)).toBe(fetchImpl);
  });
});
