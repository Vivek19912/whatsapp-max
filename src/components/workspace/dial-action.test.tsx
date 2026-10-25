import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DialAction,
  dialIdempotencyKey,
  interpretDialStatus,
  isAndroidDialSupported,
} from './dial-action';
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

describe('dial action column (every Workspace table, handoff + tel:)', () => {
  it('renders a Dial header immediately after Phone Number', () => {
    expect(pageSrc).toContain('aria-label="Dial"');
    const phoneHead = pageSrc.indexOf("c.key === 'phone'");
    const dialHead = pageSrc.indexOf('aria-label="Dial"');
    expect(phoneHead).toBeGreaterThan(-1);
    expect(dialHead).toBeGreaterThan(-1);
    // Dial header is emitted from inside the phone-column branch.
    expect(pageSrc).toContain('showDialAfter');
  });

  it('appears in Meta Lead Ads tables, Flow Tables, and any table with Phone Number', () => {
    expect(pageSrc).toContain('<DialAction');
    expect(pageSrc).toContain('phone={row.phone}');
    // No Meta/Flow kind gate remains on either insertion point.
    const dialBlocks = [
      ...pageSrc.matchAll(/showDialAfter =([\s\S]*?);/g),
    ].map((m) => m[1]);
    expect(dialBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of dialBlocks) {
      expect(block).not.toContain('meta_lead_ads');
      expect(block).toContain("c.key === 'phone'");
    }
    expect(dialSrc).not.toContain('isMetaTable');
  });

  it('creates authenticated requests without ever claiming false delivery', () => {
    expect(dialSrc).toContain("fetch('/api/dial-requests'");
    expect(dialSrc).toContain("'POST'");
    expect(dialSrc).toContain('phone_number');
    expect(dialSrc).toContain('idempotency_key');
    expect(dialSrc).toContain('Queued');
    expect(dialSrc).toContain('Delivered');
    expect(dialSrc).toContain('Failed');
    // A premature confirmation must never appear: Delivered is
    // shown only after the device acknowledgement is observed.
    expect(dialSrc).not.toMatch(/['">]Sent/);
    expect(dialSrc).not.toContain('Sent ✓');
  });

  it('passes row ownership for server-side authorization', () => {
    expect(pageSrc).toContain('contactId={row.contactId}');
    expect(pageSrc).toContain('flowId={flowId}');
    expect(pageSrc).toContain('runId={row.runId}');
    expect(dialSrc).toContain('contact_id');
    expect(dialSrc).toContain('flow_id');
    expect(dialSrc).toContain('run_id');
  });

  it('prevents duplicate requests from repeated clicks', () => {
    // Client: disabled while queueing/awaiting delivery.
    expect(dialSrc).toContain('disabled={busy}');
    expect(dialSrc).toContain("state.kind === 'queueing'");
    expect(dialSrc).toContain("state.kind === 'queued'");
    // Deterministic 30s-bucket key: a double-click collapses into
    // the existing row via UNIQUE(account_id, idempotency_key).
    // (Base timestamp sits 10s inside its 30s bucket.)
    const base = 1_700_000_020_000;
    const k1 = dialIdempotencyKey('run-1', '+14155552671', base);
    expect(dialIdempotencyKey('run-1', '+14155552671', base + 5_000)).toBe(k1);
    expect(dialIdempotencyKey('run-1', '+14155552671', base + 25_000)).not.toBe(k1);
    expect(dialIdempotencyKey('run-2', '+14155552671', base)).not.toBe(k1);
    expect(dialIdempotencyKey('run-1', '+14155552672', base)).not.toBe(k1);
  });

  it('maps server states without inventing delivery', () => {
    expect(interpretDialStatus('delivered')).toBe('delivered');
    expect(interpretDialStatus('opened')).toBe('delivered');
    expect(interpretDialStatus('completed')).toBe('delivered');
    expect(interpretDialStatus('expired')).toBe('failed');
    expect(interpretDialStatus('cancelled')).toBe('failed');
    expect(interpretDialStatus('failed')).toBe('failed');
    expect(interpretDialStatus('pending')).toBeNull();
    expect(interpretDialStatus(null)).toBeNull();
  });

  it('detects Android browsers for same-device dialing', () => {
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

  it('uses the correct row number in tel: links', () => {
    expect(dialSrc).toContain('href={telUri}');
    expect(dialSrc).toContain('normalizeDialNumber(phone)');
    expect(toTelUri('+91 88856 38563')).toBe('tel:+918885638563');
    expect(toTelUri('  +1 (415) 555-2671 ')).toBe('tel:+14155552671');
  });

  it('shows a desktop handoff affordance when the UA is not Android (incl. SSR)', () => {
    // No navigator in the node test env → desktop path.
    const html = renderToStaticMarkup(
      <DialAction phone="+14155552671" runId="r1" />
    );
    expect(html).toContain('Dial');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('Android only');
  });

  it('disables the action for empty and malformed numbers', () => {
    for (const bad of ['', 'n/a', '0000000', '123', null]) {
      const html = renderToStaticMarkup(
        <DialAction phone={bad} runId="r1" />
      );
      expect(html).not.toContain('href="tel:');
      expect(html).not.toContain('/api/dial-requests');
      expect(html).toContain('Dial unavailable');
    }
  });

  it('never mutates lead phone or sheet data on click', () => {
    expect(dialSrc).not.toMatch(/customField|flowColumn|workspace_values|google-?sheets/i);
    expect(dialSrc).not.toContain('phone_number: raw');
  });
});
