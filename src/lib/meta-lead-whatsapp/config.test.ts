// Meta Lead Ads → WhatsApp auto-send — config validation, order,
// delay scheduling, backoff. Pure functions, no I/O.

import { describe, expect, it } from 'vitest';

import {
  MAX_AUTO_SEND_DELAY_SECONDS,
  MAX_AUTO_SEND_TEMPLATES,
  scheduledForForPosition,
  validateAutoSendConfig,
  whatsappRetryDelayMs,
} from './config';

describe('validateAutoSendConfig', () => {
  it('accepts a valid multi-template payload and assigns positions in order', () => {
    const out = validateAutoSendConfig({
      delay_seconds: 60,
      paused: false,
      templates: [
        { template_name: 'welcome', template_language: 'en_US' },
        { template_name: 'followup', template_language: 'en_US' },
      ],
    });
    expect(out.delay_seconds).toBe(60);
    expect(out.paused).toBe(false);
    expect(out.templates).toEqual([
      { template_name: 'welcome', template_language: 'en_US', position: 0 },
      { template_name: 'followup', template_language: 'en_US', position: 1 },
    ]);
  });

  it('defaults delay to 0, language to en_US, paused to false', () => {
    const out = validateAutoSendConfig({
      templates: [{ template_name: 'welcome' }],
    });
    expect(out.delay_seconds).toBe(0);
    expect(out.paused).toBe(false);
    expect(out.templates[0]).toMatchObject({
      template_language: 'en_US',
      position: 0,
    });
  });

  it('rejects out-of-range delays', () => {
    expect(() =>
      validateAutoSendConfig({ delay_seconds: -1, templates: [] })
    ).toThrow(/delay_seconds/);
    expect(() =>
      validateAutoSendConfig({
        delay_seconds: MAX_AUTO_SEND_DELAY_SECONDS + 1,
        templates: [],
      })
    ).toThrow(/delay_seconds/);
    expect(() =>
      validateAutoSendConfig({ delay_seconds: 1.5, templates: [] })
    ).toThrow(/delay_seconds/);
  });

  it('rejects duplicate templates within one table', () => {
    expect(() =>
      validateAutoSendConfig({
        templates: [
          { template_name: 'a', template_language: 'en_US' },
          { template_name: 'a', template_language: 'en_US' },
        ],
      })
    ).toThrow(/duplicate/i);
  });

  it('allows the same name in different languages', () => {
    const out = validateAutoSendConfig({
      templates: [
        { template_name: 'a', template_language: 'en_US' },
        { template_name: 'a', template_language: 'es' },
      ],
    });
    expect(out.templates).toHaveLength(2);
  });

  it('rejects invalid language codes and empty names', () => {
    expect(() =>
      validateAutoSendConfig({ templates: [{ template_name: '' }] })
    ).toThrow(/template_name/);
    expect(() =>
      validateAutoSendConfig({
        templates: [{ template_name: 'a', template_language: 'xx!' }],
      })
    ).toThrow(/language/);
  });

  it(`rejects more than ${MAX_AUTO_SEND_TEMPLATES} templates`, () => {
    const templates = Array.from(
      { length: MAX_AUTO_SEND_TEMPLATES + 1 },
      (_, i) => ({ template_name: `t${i}` })
    );
    expect(() => validateAutoSendConfig({ templates })).toThrow(/at most/);
  });
});

describe('scheduledForForPosition', () => {
  const base = '2026-05-01T10:00:00.000Z';

  it('schedules item N at base + N * delay', () => {
    expect(scheduledForForPosition(base, 0, 60)).toBe(base);
    expect(scheduledForForPosition(base, 1, 60)).toBe(
      '2026-05-01T10:01:00.000Z'
    );
    expect(scheduledForForPosition(base, 3, 60)).toBe(
      '2026-05-01T10:03:00.000Z'
    );
  });

  it('zero delay makes every item due at once (order still by position)', () => {
    for (const pos of [0, 1, 2, 3]) {
      expect(scheduledForForPosition(base, pos, 0)).toBe(base);
    }
  });
});

describe('whatsappRetryDelayMs', () => {
  it('backs off exponentially and caps at 30 minutes', () => {
    expect(whatsappRetryDelayMs(1)).toBe(60_000);
    expect(whatsappRetryDelayMs(2)).toBe(120_000);
    expect(whatsappRetryDelayMs(3)).toBe(240_000);
    expect(whatsappRetryDelayMs(10)).toBe(30 * 60_000);
  });
});
