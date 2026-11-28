import { describe, expect, it } from 'vitest';

import {
  buildExportFilename,
  isAllMetaExportTarget,
  matchesSourceFilter,
  sanitizeExcelValue,
  sanitizeFilenameSegment,
} from './constants';
import { ALL_META_LEADS_ID } from '@/lib/workspace/all-meta-leads';

describe('meta-leads-export constants', () => {
  it('targets the virtual union only for ALL_META_LEADS_ID', () => {
    expect(isAllMetaExportTarget(ALL_META_LEADS_ID)).toBe(true);
    expect(isAllMetaExportTarget('some-uuid')).toBe(false);
    expect(isAllMetaExportTarget(null)).toBe(false);
    expect(isAllMetaExportTarget(undefined)).toBe(false);
  });

  it('does not treat whatsapp_flow ids as the union', () => {
    expect(isAllMetaExportTarget('whatsapp_flow')).toBe(false);
  });

  it('sanitizes filenames without empty results', () => {
    expect(
      sanitizeFilenameSegment('Himachal Trip Instant Form 24 NOV')
    ).toContain('Himachal');
    expect(sanitizeFilenameSegment('a/b\\c:d*e?f')).not.toMatch(/[/\\:]/);
    expect(sanitizeFilenameSegment('   ')).toBe('Export');
    expect(sanitizeFilenameSegment(null)).toBe('Export');
  });

  it('builds descriptive filenames', () => {
    const name = buildExportFilename(
      'Himachal Trip Instant Form',
      new Date('2026-11-28T10:00:00Z')
    );
    expect(name).toBe('Himachal_Trip_Instant_Form_2026-11-28.xlsx');
    expect(buildExportFilename(null, new Date('2026-11-28T00:00:00Z'))).toBe(
      'All_Meta_Leads_2026-11-28.xlsx'
    );
  });

  it('guards formula injection', () => {
    expect(sanitizeExcelValue('=1+1')).toBe("'=1+1");
    expect(sanitizeExcelValue('+cmd')).toBe("'+cmd");
    expect(sanitizeExcelValue('-2')).toBe("'-2");
    expect(sanitizeExcelValue('@mention')).toBe("'@mention");
    expect(sanitizeExcelValue('Normal text')).toBe('Normal text');
    expect(sanitizeExcelValue('')).toBe('');
    expect(sanitizeExcelValue(42)).toBe(42);
    expect(sanitizeExcelValue(null)).toBe(null);
  });

  it('matches source filter on real is_organic', () => {
    expect(matchesSourceFilter(true, 'all')).toBe(true);
    expect(matchesSourceFilter(null, 'all')).toBe(true);
    expect(matchesSourceFilter(true, 'organic')).toBe(true);
    expect(matchesSourceFilter(false, 'organic')).toBe(false);
    expect(matchesSourceFilter(null, 'organic')).toBe(false);
    expect(matchesSourceFilter(false, 'paid')).toBe(true);
    expect(matchesSourceFilter(true, 'paid')).toBe(false);
    expect(matchesSourceFilter(null, 'paid')).toBe(false);
  });
});
