import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecentCallsTable } from './recent-calls';
import type {
  RecentMissedRow,
  RecentRecordingRow,
} from '@/lib/calls/client';

const root = process.cwd();

// ---------------------------------------------------------------------------
// RecentCallsTable — SSR covers static markup (headers, order,
// links, labels); playback stays owned by RecordingPlayerPopover,
// pagination/filters by the calls page wiring.
// ---------------------------------------------------------------------------

function recording(over: Partial<RecentRecordingRow> = {}): RecentRecordingRow {
  return {
    id: 'r-1',
    contactId: 'c-1',
    contactName: 'Akash',
    phoneNumber: '+918953065369',
    direction: 'out',
    callType: 'phone',
    durationSecs: 84,
    recordedAt: new Date(2026, 9, 6, 19, 25).toISOString(),
    createdAt: new Date(2026, 9, 6, 19, 25).toISOString(),
    fileName: '20261006_out.ogg',
    uploaderName: 'Vikas',
    workspaceTable: 'Meta Lead Ads',
    ...over,
  };
}

function missed(over: Partial<RecentMissedRow> = {}): RecentMissedRow {
  return {
    id: 'e-1',
    contactId: 'c-2',
    contactName: 'Sagar',
    phoneNumber: '+911234567890',
    occurredAt: new Date(2026, 9, 6, 23, 25).toISOString(),
    workspaceTable: 'Leads',
    ownerName: 'Vikas',
    ...over,
  };
}

function html(
  recent: RecentRecordingRow[] | null = [recording()],
  missedRows: RecentMissedRow[] | null = []
) {
  return renderToStaticMarkup(
    <RecentCallsTable recent={recent} missed={missedRows} loading={false} />
  );
}

function headerCells(markup: string): string[] {
  const thead = markup.slice(markup.indexOf('<thead'), markup.indexOf('</thead>'));
  return [...thead.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, '').trim()
  );
}

describe('RecentCallsTable columns', () => {
  it('orders headers Time | Lead Name | Workspace Table | Call | Salesperson | Recording', () => {
    expect(headerCells(html())).toEqual([
      'Time',
      'Lead Name',
      'Workspace Table',
      'Call',
      'Salesperson',
      'Recording',
    ]);
  });

  it('uses the Workspace tinted header treatment, never a plain row', () => {
    const out = html();
    expect(out).toContain('[&amp;_th]:bg-[#f1f5f9]');
    expect(out).toContain('dark:[&amp;_th]:bg-muted');
    expect(out).toContain('text-[15px] font-bold');
    expect(out).toContain('hover:bg-transparent');
  });

  it('has no separate Type or Duration columns', () => {
    const headers = headerCells(html());
    expect(headers).not.toContain('Type');
    expect(headers).not.toContain('Duration');
    expect(html()).not.toContain('text-right');
  });

  it('divides body cells like Workspace rows', () => {
    const out = html();
    expect(out).toContain('border-r border-border');
    expect(out).toContain('hover:bg-muted/50');
  });
});

describe('RecentCallsTable lead navigation (shared deep link)', () => {
  it('links linked lead names to the exact Workspace lead in a new tab', () => {
    const out = html();
    expect(out).toContain('href="/workspace?contact=c-1');
    expect(out).toContain('sidebar=collapsed');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain('title="Akash"');
  });

  it('never navigates unlinked rows by name or phone', () => {
    const out = html(
      [recording({ contactId: null, contactName: null, phoneNumber: '+911234567890' })],
      []
    );
    expect(out).not.toContain('/workspace?contact=');
    expect(out).toContain('+911234567890');
  });

  it('links missed rows only when a real contact association exists', () => {
    const linked = html([], [missed()]);
    expect(linked).toContain('href="/workspace?contact=c-2');
    expect(linked).toContain('sidebar=collapsed');
    expect(linked).toContain('Missed');

    const unlinked = html(
      [],
      [missed({ contactId: null, contactName: null, phoneNumber: null })]
    );
    expect(unlinked).not.toContain('/workspace?contact=');
  });

  it('renders one shared link implementation with the Recordings table', () => {
    const src = readFileSync(
      `${root}/src/components/calls/dashboard/recent-calls.tsx`,
      'utf8'
    );
    expect(src).toContain('WorkspaceLeadLink');
    expect(src).toContain('contactId={r.contactId}');
    const recordingsSrc = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      'utf8'
    );
    expect(recordingsSrc).toContain('WorkspaceLeadLink');
  });

  it('shows the workspace table with a tooltip, em dash when missing', () => {
    const out = html();
    expect(out).toContain('title="Meta Lead Ads"');
    const missing = html([recording({ workspaceTable: null })], []);
    expect(missing).toContain('>—<');
  });
});

describe('RecentCallsTable cells', () => {
  it('merges icon and direction into one Call cell like the Recordings table', () => {
    const out = html(
      [
        recording({ id: 'r-1', direction: 'out', callType: 'phone' }),
        recording({ id: 'r-2', direction: 'in', callType: 'phone' }),
        recording({ id: 'r-3', direction: null, callType: null, contactId: 'c-3' }),
      ],
      [missed({ id: 'e-9' })]
    );
    expect(out).toContain('Outgoing');
    expect(out).toContain('Incoming');
    expect(out).toContain('Missed');
    expect(out).toContain('Unknown');
    // One Call cell holds both the type icon and the direction text.
    const idx = out.indexOf('Outgoing');
    const tdStart = out.lastIndexOf('<td', idx);
    const cell = out.slice(tdStart, out.indexOf('</td>', tdStart));
    expect(cell).toContain('data-icon="phone-handset"');
    expect(out).toContain('text-blue-700');
    expect(out).toContain('text-emerald-700');
    expect(out).toContain('text-rose-600');
  });

  it('shows only the WhatsApp icon for WhatsApp calls, regardless of direction', () => {
    for (const callType of ['whatsapp', 'whatsapp_business'] as const) {
      for (const direction of ['in', 'out', null] as const) {
        const out = html(
          [recording({ id: 'r-1', callType, direction })],
          []
        );
        expect(out).toContain('data-icon="whatsapp-brand"');
        const idx = out.indexOf('data-icon="whatsapp-brand"');
        const tdStart = out.lastIndexOf('<td', idx);
        const cell = out.slice(tdStart, out.indexOf('</td>', tdStart));
        expect(cell).not.toContain('Incoming');
        expect(cell).not.toContain('Outgoing');
        expect(cell).not.toContain('Unknown');
      }
    }
  });

  it('formats durations like the Recordings table, No recording for missed rows', () => {
    const out = html([recording({ durationSecs: 84 })], [missed()]);
    expect(out).toContain('1:24');
    expect(out).toContain('No recording');
    // Missed rows have no duration: never a fabricated 0:00.
    expect(out).not.toContain('0:00');
  });

  it('shows salesperson or an em dash, never blank', () => {
    const out = html([recording({ uploaderName: null })], []);
    expect(out).toContain('>—<');
  });

  it('reuses the shared player or shows No recording', () => {
    const out = html([recording()], [missed()]);
    expect(out).toContain('No recording');
    expect(out).toContain('aria-label="Play recording of Akash"');
  });

  it('keeps an accessible name on the new-tab link', () => {
    const out = html();
    expect(out).toContain('title="Akash"');
  });
});
