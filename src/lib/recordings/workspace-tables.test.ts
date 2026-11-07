// ============================================================
// workspaceTableNamesByContactId — batched flow_runs → flows
// join for the Recordings Workspace Table column. Never N+1,
// never throws, account-scoped by construction.
// ============================================================

import { describe, expect, it } from 'vitest';

import { workspaceTableNamesByContactId, flowContactIds } from './workspace-tables';

// Minimal thenable stub for the exact chain the helper builds:
// from().select().eq().in().order() (runs) and
// from().select().eq().in() (flows).
function stubClient(opts: {
  runs: Array<Record<string, unknown>>;
  flows: Array<Record<string, unknown>>;
  errorAt?: 'runs' | 'flows';
  calls?: Array<{ table: string; filters: Array<[string, unknown]> }>;
}) {
  const track = { table: '', filters: [] as Array<[string, unknown]> };
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    track.filters.push([col, val]);
    return builder;
  };
  builder.in = (col: string, vals: unknown) => {
    track.filters.push([col, vals]);
    return builder;
  };
  builder.order = () => builder;
  builder.not = () => builder;
  builder.limit = () => builder;
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    const isRuns = track.table === 'flow_runs';
    opts.calls?.push({ table: track.table, filters: [...track.filters] });
    if (opts.errorAt === (isRuns ? 'runs' : 'flows')) {
      return resolve({ data: null, error: new Error('db down') });
    }
    return resolve({ data: isRuns ? opts.runs : opts.flows, error: null });
  };
  return {
    from: (table: string) => {
      track.table = table;
      track.filters = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return builder as any;
    },
  };
}

describe('workspaceTableNamesByContactId', () => {
  it('returns {} for empty contact ids without querying', async () => {
    const calls: Array<unknown> = [];
    const out = await workspaceTableNamesByContactId(
      stubClient({ runs: [], flows: [], calls: calls as never }) as never,
      'acct-1',
      []
    );
    expect(out).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('maps each contact to its most recent run’s flow name', async () => {
    const client = stubClient({
      runs: [
        { contact_id: 'c-1', flow_id: 'f-old', started_at: '2026-09-01T00:00:00.000Z' },
        { contact_id: 'c-1', flow_id: 'f-new', started_at: '2026-10-01T00:00:00.000Z' },
      ],
      flows: [
        { id: 'f-old', name: 'Meta Lead Ads' },
        { id: 'f-new', name: 'Instant Form for Couple Kashmir' },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await workspaceTableNamesByContactId(client as any, 'acct-1', ['c-1']);
    expect(out).toEqual({ 'c-1': 'Instant Form for Couple Kashmir' });
  });

  it('omits contacts with no runs, gone flows, or blank names', async () => {
    const client = stubClient({
      runs: [
        { contact_id: 'c-gone', flow_id: 'f-gone', started_at: '2026-10-01T00:00:00.000Z' },
        { contact_id: 'c-blank', flow_id: 'f-blank', started_at: '2026-10-01T00:00:00.000Z' },
      ],
      flows: [{ id: 'f-blank', name: '   ' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await workspaceTableNamesByContactId(client as any, 'acct-1', [
      'c-missing',
      'c-gone',
      'c-blank',
    ]);
    expect(out).toEqual({});
  });

  it('scopes both queries to the caller’s account', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const client = stubClient({
      runs: [{ contact_id: 'c-1', flow_id: 'f-1', started_at: '2026-10-01T00:00:00.000Z' }],
      flows: [{ id: 'f-1', name: 'Meta Lead Ads' }],
      calls,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workspaceTableNamesByContactId(client as any, 'acct-1', ['c-1']);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.filters).toContainEqual(['account_id', 'acct-1']);
    }
  });

  it('returns {} instead of throwing when the database fails', async () => {
    for (const errorAt of ['runs', 'flows'] as const) {
      const client = stubClient({
        runs: [{ contact_id: 'c-1', flow_id: 'f-1', started_at: '2026-10-01T00:00:00.000Z' }],
        flows: [{ id: 'f-1', name: 'Meta Lead Ads' }],
        errorAt,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(workspaceTableNamesByContactId(client as any, 'acct-1', ['c-1'])).resolves.toEqual({});
    }
  });
});

describe('flowContactIds', () => {
  it('returns distinct contact ids for the flow', async () => {
    const client = stubClient({
      runs: [
        { contact_id: 'c-1', flow_id: 'f-1' },
        { contact_id: 'c-1', flow_id: 'f-1' },
        { contact_id: null, flow_id: 'f-1' },
        { contact_id: 'c-2', flow_id: 'f-1' },
      ],
      flows: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(flowContactIds(client as any, 'acct-1', 'f-1')).resolves.toEqual([
      'c-1',
      'c-2',
    ]);
  });

  it('returns [] for blank account or flow ids without querying', async () => {
    const calls: Array<unknown> = [];
    const client = stubClient({ runs: [], flows: [], calls: calls as never });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(flowContactIds(client as any, '', 'f-1')).resolves.toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(flowContactIds(client as any, 'acct-1', '')).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('scopes the membership query to the caller’s account and flow', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const client = stubClient({
      runs: [{ contact_id: 'c-1', flow_id: 'f-1' }],
      flows: [],
      calls,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await flowContactIds(client as any, 'acct-1', 'f-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('flow_runs');
    expect(calls[0].filters).toContainEqual(['account_id', 'acct-1']);
    expect(calls[0].filters).toContainEqual(['flow_id', 'f-1']);
  });
});
