import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DialAction,
  dialDisplayState,
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
    // Single centered header label (no duplicated aria-label text):
    // one visible "Dial" on one line with a sensible minimum width.
    expect(pageSrc).toContain('>Dial</span>');
    expect(pageSrc).toContain('text-center');
    expect(pageSrc).toContain('minWidth: 112');
    // Subtle light-gray header tint (light mode) with a theme-token
    // fallback for dark mode — header only, body cells untouched.
    expect(pageSrc).toContain('bg-[#F1F5F9]');
    expect(pageSrc).toContain('[html[data-mode=dark]_&]:bg-muted');
    const phoneHead = pageSrc.indexOf("c.key === 'phone'");
    const dialHead = pageSrc.indexOf('>Dial</span>');
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
    // No status polling: the cell stays Queued after the 201 and
    // never re-asks the server. No interval, no status GET.
    expect(dialSrc).not.toContain('setInterval');
    expect(dialSrc).not.toContain('clearInterval');
    expect(dialSrc).not.toContain('/api/dial-requests?id=');
    expect(dialSrc).not.toContain('POLL_');
    // A premature confirmation must never appear: Delivered is
    // shown only after a device acknowledgement is observed over
    // a WebSocket status event — until then the cell stays Queued.
    expect(dialSrc).not.toMatch(/['">]Sent/);
    expect(dialSrc).not.toContain('Sent ✓');
    expect(dialSrc).not.toContain('Delivered ✓');
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

  it('issues a fresh idempotency key per dial cycle after a terminal state', () => {
    const base = 1_700_000_020_000;
    const first = dialIdempotencyKey('run-1', '+14155552671', base, 0);
    // Same cycle + same bucket: stable, so cross-tab double clicks
    // still collapse into one row.
    expect(dialIdempotencyKey('run-1', '+14155552671', base + 5_000, 0)).toBe(first);
    // Next cycle (after opened/expired/failed): a brand-new key, so a
    // deliberate re-dial always creates a fresh server row.
    const second = dialIdempotencyKey('run-1', '+14155552671', base + 5_000, 1);
    expect(second).not.toBe(first);
    expect(dialIdempotencyKey('run-1', '+14155552671', base + 5_000, 2)).not.toBe(second);
  });

  it('resets to a clickable Dial on opened and never replays from duplicates', () => {
    // Opened maps through the display helper, and the component turns
    // that into an idle reset (not a stuck Opened cell).
    expect(dialDisplayState('opened', '2030-01-01T00:00:00Z', 0)).toBe('opened');
    // Every terminal path (server event or local TTL expiry) bumps
    // the dial-cycle salt so the next click mints a fresh key.
    expect(dialSrc.match(/cycleRef\.current \+= 1/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // Duplicate/foreign status frames only ever change the label for
    // their own request id; they never trigger a fetch or a dial.
    // (No fetch/POST besides the single creation call.)
    const fetches = (dialSrc.match(/fetch\('/g) ?? []).length;
    expect(fetches).toBe(1);
    expect(dialSrc).toContain("'/api/dial-requests'");
    // The subscription ignores other requests' events.
    expect(dialSrc).toContain('requestId !== update.requestId');
  });

  it('shows Dial (clickable) on a fresh mount — including after a refresh post-open', () => {
    const html = renderToStaticMarkup(
      <DialAction phone="+14155552671" runId="r1" />
    );
    // Fresh mount is idle: clickable Dial, no disabled attribute and
    // no leftover in-flight label. (The word "disabled" appears in
    // Tailwind variants; the attribute itself must be absent.)
    expect(html).toContain('>Dial</span>');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('>Queued</span>');
    expect(html).not.toContain('>Delivered</span>');
  });

  it('maps server states without inventing delivery (reserved for WS status events)', () => {
    expect(interpretDialStatus('delivered')).toBe('delivered');
    expect(interpretDialStatus('opened')).toBe('delivered');
    expect(interpretDialStatus('completed')).toBe('delivered');
    expect(interpretDialStatus('expired')).toBe('failed');
    expect(interpretDialStatus('cancelled')).toBe('failed');
    expect(interpretDialStatus('failed')).toBe('failed');
    expect(interpretDialStatus('pending')).toBeNull();
    expect(interpretDialStatus(null)).toBeNull();
  });

  it('maps persisted statuses to distinct display states (Opened is not proof of a call)', () => {
    expect(dialDisplayState('delivered', '2030-01-01T00:00:00Z', 0)).toBe('delivered');
    expect(dialDisplayState('opened', '2030-01-01T00:00:00Z', 0)).toBe('opened');
    expect(dialDisplayState('completed', '2030-01-01T00:00:00Z', 0)).toBe('opened');
    expect(dialDisplayState('expired', '2030-01-01T00:00:00Z', 0)).toBe('expired');
    expect(dialDisplayState('cancelled', '2030-01-01T00:00:00Z', 0)).toBe('failed');
    expect(dialDisplayState('failed', '2030-01-01T00:00:00Z', 0)).toBe('failed');
    expect(dialDisplayState('pending', '2030-01-01T00:00:00Z', 0)).toBeNull();
    expect(dialDisplayState(null, null, 0)).toBeNull();
    // TTL already passed: pending/delivered reads as expired without polling.
    expect(dialDisplayState('pending', '2000-01-01T00:00:00Z', 1_700_000_000_000)).toBe('expired');
    expect(dialDisplayState('delivered', '2000-01-01T00:00:00Z', 1_700_000_000_000)).toBe('expired');
    expect(dialDisplayState('pending', 'not-a-date', 1_700_000_000_000)).toBeNull();
  });

  it('subscribes to live status updates without polling', () => {
    expect(dialSrc).toContain('subscribeDialStatus');
    expect(dialSrc).toContain("'Delivered'");
    // Opened resets straight to a clickable Dial (no stuck label).
    expect(dialSrc).not.toContain("'Opened'");
    expect(dialSrc).toContain('cycleRef');
    expect(dialSrc).not.toContain('setInterval');
    expect(dialSrc).not.toContain('clearInterval');
    expect(dialSrc).not.toContain('/api/dial-requests?id=');
  });

  it('maps persisted statuses to distinct display states (Opened is not proof of a call)', () => {
    expect(dialDisplayState('delivered', '2030-01-01T00:00:00Z', 0)).toBe('delivered');
    expect(dialDisplayState('opened', '2030-01-01T00:00:00Z', 0)).toBe('opened');
    expect(dialDisplayState('completed', '2030-01-01T00:00:00Z', 0)).toBe('opened');
    expect(dialDisplayState('expired', '2030-01-01T00:00:00Z', 0)).toBe('expired');
    expect(dialDisplayState('cancelled', '2030-01-01T00:00:00Z', 0)).toBe('failed');
    expect(dialDisplayState('failed', '2030-01-01T00:00:00Z', 0)).toBe('failed');
    expect(dialDisplayState('pending', '2030-01-01T00:00:00Z', 0)).toBeNull();
    expect(dialDisplayState(null, null, 0)).toBeNull();
    expect(dialDisplayState('pending', '2000-01-01T00:00:00Z', 1_700_000_000_000)).toBe('expired');
    expect(dialDisplayState('delivered', '2000-01-01T00:00:00Z', 1_700_000_000_000)).toBe('expired');
    expect(dialDisplayState('pending', 'not-a-date', 1_700_000_000_000)).toBeNull();
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
