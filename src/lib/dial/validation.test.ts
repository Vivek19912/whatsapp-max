import { describe, expect, it } from 'vitest';

import {
  isDialablePhoneNumber,
  isPlaceholderPhone,
  normalizeDialNumber,
  toTelUri,
} from '@/lib/dial/validation';

describe('dial validation', () => {
  it('normalizes separators but preserves international +', () => {
    expect(normalizeDialNumber('+91 88856 38563')).toBe('+918885638563');
    expect(normalizeDialNumber('(415) 555-2671')).toBe('4155552671');
    // No country code is invented for ambiguous numbers.
    expect(normalizeDialNumber('8885638563')).toBe('8885638563');
  });

  it('builds tel: URIs for same-device dialing', () => {
    expect(toTelUri('+918885638563')).toBe('tel:+918885638563');
    expect(toTelUri('  +1 (415) 555-2671 ')).toBe('tel:+14155552671');
  });

  it('rejects empty, placeholder, and malformed numbers', () => {
    for (const bad of ['', '   ', null, undefined, 'n/a', 'NA', '-', 'test', 'unknown', '0000000', '1111111111', '123', 'abc-def-ghij', '+']) {
      expect(isDialablePhoneNumber(bad as string)).toBe(false);
      expect(toTelUri(bad as string)).toBeNull();
    }
    expect(isPlaceholderPhone('n/a')).toBe(true);
  });

  it('accepts valid international numbers across digit lengths', () => {
    expect(isDialablePhoneNumber('+918885638563')).toBe(true);
    expect(isDialablePhoneNumber('+14155552671')).toBe(true);
    expect(isDialablePhoneNumber('9876543210')).toBe(true);
  });
});
