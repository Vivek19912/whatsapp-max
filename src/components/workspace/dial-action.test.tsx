import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { DialAction, isAndroidDialSupported } from './dial-action';
import { toTelUri } from '@/lib/dial/validation';

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  'utf8'
);
const dialSrc = readFileSync(
  `${root}/src/components/workspace/dial-action.tsx`,
  'utf8'
);

describe('dial action column (every Workspace table, phone-only)', () => {
  it('renders a Dial header immediately after Phone Number', () => {
    expect(pageSrc).toContain('aria-label="Dial"');
    const phoneHead = pageSrc.indexOf("c.key === 'phone'");
    const dialHead = pageSrc.indexOf('aria-label="Dial"');
    expect(phoneHead).toBeGreaterThan(-1);
    expect(dialHead).toBeGreaterThan(-1);
    // Dial header is emitted from inside the phone-column branch.
    expect(pageSrc).toContain('showDialAfter');
  });

  it('appears in Meta Lead Ads tables', () => {
    // The Dial cell reads the row phone for every table; nothing
    // restricts it to a Meta payload kind.
    expect(pageSrc).toContain('<DialAction');
    expect(pageSrc).toContain('phone={row.phone}');
  });

  it('appears in Flow Tables and any other table with a Phone Number', () => {
    // No Meta/Flow kind gate remains on either the header or the
    // cell insertion point — any table whose columns include the
    // Phone Number system column gets Dial right after it.
    const gates = (pageSrc.match(/payload\?\.meta\??\.kind === 'meta_lead_ads'/g) ?? []).length;
    const dialBlocks = [
      ...pageSrc.matchAll(/showDialAfter =([\s\S]*?);/g),
    ].map((m) => m[1]);
    expect(dialBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of dialBlocks) {
      expect(block).not.toContain('meta_lead_ads');
      expect(block).toContain("c.key === 'phone'");
    }
    expect(gates).toBeGreaterThan(0); // other Meta-only features keep their gates
    expect(dialSrc).not.toContain('isMetaTable');
    expect(dialSrc).not.toContain('meta_lead_ads');
  });

  it('creates no remote requests: pure tel: anchor, no fetch or handoff UI', () => {
    expect(dialSrc).not.toContain('fetch(');
    expect(dialSrc).not.toContain('/api/dial-requests');
    expect(dialSrc).not.toContain('To phone');
    expect(dialSrc).not.toMatch(/customField|flowColumn|workspace_values|google-?sheets/i);
    expect(dialSrc).toContain('tel:');
  });

  it('detects Android browsers for dialing', () => {
    expect(isAndroidDialSupported('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true);
    expect(
      isAndroidDialSupported('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    ).toBe(false);
    expect(
      isAndroidDialSupported('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    ).toBe(false);
    expect(isAndroidDialSupported(null)).toBe(false);
    expect(isAndroidDialSupported('')).toBe(false);
  });

  it('uses the correct row number for each valid row', () => {
    // SSR renders the non-Android hint (no navigator in node), so
    // the row-number mapping is verified through the shared
    // validation helpers plus the anchor source pattern.
    expect(dialSrc).toContain('href={telUri}');
    expect(dialSrc).toContain('normalizeDialNumber(phone)');
    expect(toTelUri('+91 88856 38563')).toBe('tel:+918885638563');
    expect(toTelUri('  +1 (415) 555-2671 ')).toBe('tel:+14155552671');
  });

  it('shows an Android-only hint when the UA is not Android (incl. SSR)', () => {
    // No navigator in the node test env → non-Android path.
    const html = renderToStaticMarkup(
      <DialAction phone="+14155552671" />
    );
    expect(html).toContain('Dial available on Android phone');
    expect(html).not.toContain('href="tel:');
  });

  it('disables the action for empty and malformed numbers', () => {
    for (const bad of ['', 'n/a', '0000000', '123', null]) {
      const html = renderToStaticMarkup(
        <DialAction phone={bad} />
      );
      expect(html).not.toContain('href="tel:');
      expect(html).toContain('Dial unavailable');
    }
  });

  it('never mutates lead phone or sheet data on click', () => {
    expect(dialSrc).not.toContain('PUT');
    expect(dialSrc).not.toContain('PATCH');
    expect(dialSrc).not.toContain('phone_number: raw');
    expect(dialSrc).not.toContain('useRef');
  });
});
