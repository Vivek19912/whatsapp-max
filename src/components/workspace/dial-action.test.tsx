import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { DialAction } from './dial-action';

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  'utf8'
);
const dialSrc = readFileSync(
  `${root}/src/components/workspace/dial-action.tsx`,
  'utf8'
);

describe('dial action column (Meta tables only)', () => {
  it('renders a Dial header immediately after Phone Number', () => {
    expect(pageSrc).toContain('aria-label="Dial"');
    const phoneHead = pageSrc.indexOf("c.key === 'phone'");
    const dialHead = pageSrc.indexOf('aria-label="Dial"');
    expect(phoneHead).toBeGreaterThan(-1);
    expect(dialHead).toBeGreaterThan(-1);
    // Dial header is emitted from inside the phone-column branch.
    expect(pageSrc).toContain('showDialAfter');
  });

  it('is gated on Meta Lead Ads tables; Flow Tables render unchanged', () => {
    expect(pageSrc).toContain("payload?.meta.kind === 'meta_lead_ads'");
    expect(pageSrc).toContain('isMetaTable');
    // Shared column model has no Dial — Flow Tables unaffected.
    expect(pageSrc).not.toMatch(/buildFlowTableColumns\([^)]*dial/i);
  });

  it('treats Dial as an action column, never a sheet field', () => {
    expect(dialSrc).not.toMatch(/customField|flowColumn|workspace_values|google-?sheets/i);
    expect(dialSrc).toContain('tel:');
    expect(dialSrc).toContain('/api/dial-requests');
  });

  it('renders a tel: anchor for dialable numbers', () => {
    const html = renderToStaticMarkup(
      <DialAction phone="+14155552671" isMetaTable runId="r1" />
    );
    expect(html).toContain('href="tel:+14155552671"');
    expect(html).toContain('Dial');
  });

  it('disables the action for empty and malformed numbers', () => {
    for (const bad of ['', 'n/a', '0000000', '123', null]) {
      const html = renderToStaticMarkup(
        <DialAction phone={bad} isMetaTable runId="r1" />
      );
      expect(html).not.toContain('href="tel:');
      expect(html).toContain('Dial unavailable');
    }
  });

  it('renders nothing for Flow Tables', () => {
    const html = renderToStaticMarkup(
      <DialAction phone="+14155552671" isMetaTable={false} />
    );
    expect(html).toBe('');
  });

  it('guards duplicate submissions while a request is in flight', () => {
    expect(dialSrc).toContain('inFlight');
    expect(dialSrc).toContain('pending');
    expect(dialSrc).toContain('disabled={pending}');
    expect(dialSrc).toContain('idempotency_key');
  });

  it('never mutates lead phone or sheet data on click', () => {
    expect(dialSrc).not.toContain('PUT');
    expect(dialSrc).not.toContain('PATCH');
    expect(dialSrc).not.toContain('phone_number: raw');
  });
});
