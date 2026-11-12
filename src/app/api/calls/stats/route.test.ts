import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'acct-1',
  recordings: [] as Array<Record<string, unknown>>,
  contacts: [] as Array<Record<string, unknown>>,
  flowRuns: [] as Array<Record<string, unknown>>,
  flows: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  missedEvents: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResults: {} as Record<string, unknown>,
}));

function chainable(table: string) {
  const api: Record<string, (...args: never[]) => unknown> = {};
  const rec = (op: string, args: unknown[]) => {
    h.calls.push({ table, op, args: args as unknown[] });
    return api;
  };
  api.select = () => api;
  api.eq = (...args: never[]) => rec('eq', args);
  api.or = (...args: never[]) => rec('or', args);
  api.in = (...args: never[]) => rec('in', args);
  api.is = (...args: never[]) => rec('is', args);
  api.not = (...args: never[]) => rec('not', args);
  api.gte = (...args: never[]) => rec('gte', args);
  api.lt = (...args: never[]) => rec('lt', args);
  api.order = (...args: never[]) => rec('order', args);
  api.limit = (...args: never[]) => rec('limit', args);
  api.range = async () => ({ data: h.recordings, error: null });
  api.then = (resolve: (v: unknown) => unknown) => {
    const data =
      table === 'contacts'
        ? h.contacts
        : table === 'flow_runs'
          ? h.flowRuns
          : table === 'flows'
            ? h.flows
            : table === 'profiles'
              ? h.profiles
              : table === 'call_events'
                ? h.missedEvents
                : [];
    return resolve({ data, error: null });
  };
  return api;
}

function fakeSupabase() {
  return {
    from: (table: string) => chainable(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      return { data: h.rpcResults[fn] ?? null, error: null };
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    supabase: fakeSupabase(),
    accountId: h.accountId,
    userId: 'user-1',
  }),
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status }
    );
  },
}));

const { GET } = await import('./route');

function rec(over: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    contact_id: 'c-1',
    direction: 'out',
    call_type: 'phone',
    duration_seconds: 60,
    recorded_at: '2026-10-04T12:00:00.000Z',
    created_at: '2026-10-04T12:00:00.000Z',
    uploaded_by: 'user-9',
    phone_number: '+15550001111',
    file_name: 'r-1.opus',
    ...over,
  };
}

const RANGE = 'from=2026-10-01T00:00:00.000Z&to=2026-10-06T00:00:00.000Z';

beforeEach(() => {
  h.accountId = 'acct-1';
  h.recordings = [];
  h.contacts = [];
  h.flowRuns = [];
  h.flows = [];
  h.profiles = [];
  h.missedEvents = [];
  h.calls = [];
  h.rpcCalls = [];
  h.rpcResults = {
    call_kpis_summary: {
      total: 0,
      durationSecs: null,
      incoming: 0,
      incomingDurationSecs: null,
      outgoing: 0,
      outgoingDurationSecs: null,
      phone: 0,
      whatsapp: 0,
      whatsappBusiness: 0,
    },
    call_event_outcomes_summary: {
      missed: 0,
      rejected: 0,
      answered: 0,
      unknown: 0,
    },
    call_salesperson_stats: [],
  };
});

function post(path: string) {
  return new Request(`https://app.test/api/calls/stats?${path}`, {
    method: 'GET',
  });
}

describe('GET /api/calls/stats', () => {
  it('returns recording KPIs scoped by account with the new dashboard shape', async () => {
    h.recordings = [
      rec(),
      rec({
        id: 'r-2',
        direction: 'in',
        call_type: 'whatsapp',
        contact_id: null,
      }),
    ];
    h.rpcResults['call_kpis_summary'] = {
      total: 2,
      durationSecs: 120,
      incoming: 1,
      incomingDurationSecs: 60,
      outgoing: 1,
      outgoingDurationSecs: 60,
      phone: 1,
      whatsapp: 1,
      whatsappBusiness: 0,
    };
    h.rpcResults['call_event_outcomes_summary'] = {
      missed: 5,
      rejected: 2,
      answered: 9,
      unknown: 1,
    };
    const res = await GET(post(RANGE));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      recordingCount: 2,
      recordingDurationSecs: 120,
      incomingRecordings: 1,
      outgoingRecordings: 1,
      unknownDirectionRecordings: 0,
      phoneRecordings: 1,
      whatsappRecordings: 1,
      missedRecordings: 5,
      rejectedRecordings: 2,
      answeredEvents: 9,
      unknownEvents: 1,
      totalEvents: 15,
      truncated: false,
    });
    expect(json.trend).toMatchObject({ granularity: 'day' });
    expect(Array.isArray(json.hourly)).toBe(true);
    expect((json.hourly as number[]).length).toBe(24);
    expect(Array.isArray(json.weekday)).toBe(true);
    expect((json.weekday as number[]).length).toBe(7);
    expect(json.salesperson).toEqual([]);
    expect(json.recentMissed).toEqual([]);
    const eqs = h.calls.filter(
      (c) => c.table === 'call_recordings' && c.op === 'eq'
    );
    expect(eqs).toContainEqual({
      table: 'call_recordings',
      op: 'eq',
      args: ['account_id', 'acct-1'],
    });
  });

  it('rejects missing, inverted, and oversized ranges', async () => {
    const missing = await GET(post(''));
    expect(missing.status).toBe(400);
    const bad = await GET(
      post('from=2026-10-06T00:00:00.000Z&to=2026-10-01T00:00:00.000Z')
    );
    expect(bad.status).toBe(400);
    const wide = await GET(
      post('from=2020-01-01T00:00:00.000Z&to=2026-10-06T00:00:00.000Z')
    );
    expect(wide.status).toBe(400);
  });

  it('rejects invalid filter values', async () => {
    const badUser = await GET(
      new Request(`https://app.test/api/calls/stats?${RANGE}&user=nope`)
    );
    expect(badUser.status).toBe(400);
    const badDirection = await GET(
      new Request(
        `https://app.test/api/calls/stats?${RANGE}&direction=sideways`
      )
    );
    expect(badDirection.status).toBe(400);
    const badType = await GET(
      new Request(`https://app.test/api/calls/stats?${RANGE}&call_type=voip`)
    );
    expect(badType.status).toBe(400);
    const badTable = await GET(
      new Request(
        `https://app.test/api/calls/stats?${RANGE}&workspace_table=nope`
      )
    );
    expect(badTable.status).toBe(400);
    const badStatus = await GET(
      new Request(`https://app.test/api/calls/stats?${RANGE}&status=maybe`)
    );
    expect(badStatus.status).toBe(400);
  });

  it('exposes no storage internals and no previous-period comparison', async () => {
    h.recordings = [rec()];
    const res = await GET(post(RANGE));
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      [
        'answeredEvents',
        'hourly',
        'incomingRecordings',
        'missedRecordings',
        'outgoingRecordings',
        'phoneRecordings',
        'recent',
        'recentMissed',
        'recordingCount',
        'recordingDurationSecs',
        'rejectedRecordings',
        'salesperson',
        'totalEvents',
        'trend',
        'truncated',
        'unknownDirectionRecordings',
        'unknownEvents',
        'weekday',
        'whatsappBusinessRecordings',
        'whatsappRecordings',
      ].sort()
    );
    const dumped = JSON.stringify(json);
    expect(dumped).not.toContain('storage_bucket');
    expect(dumped).not.toContain('storage_path');
    expect(dumped).not.toContain('previous');
  });

  it('keeps NULL direction/duration out of directional splits', async () => {
    h.recordings = [
      rec({ id: 'r-1', direction: 'in', duration_seconds: 60 }),
      rec({ id: 'r-2', direction: null, duration_seconds: 30 }),
      rec({ id: 'r-3', direction: 'out', duration_seconds: null }),
    ];
    h.rpcResults['call_kpis_summary'] = {
      total: 3,
      durationSecs: 90,
      incoming: 1,
      incomingDurationSecs: 60,
      outgoing: 1,
      outgoingDurationSecs: null,
      phone: 3,
      whatsapp: 0,
      whatsappBusiness: 0,
    };
    const res = await GET(post(RANGE));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      recordingCount: 3,
      incomingRecordings: 1,
      outgoingRecordings: 1,
      unknownDirectionRecordings: 1,
      phoneRecordings: 3,
    });
  });

  it('KPIs are exact past the row bound: RPC totals returned verbatim', async () => {
    h.recordings = [rec(), rec({ id: 'r-2' })];
    h.rpcResults['call_kpis_summary'] = {
      total: 6001,
      durationSecs: 360060,
      incoming: 2500,
      incomingDurationSecs: 150000,
      outgoing: 3400,
      outgoingDurationSecs: 204000,
      phone: 6001,
      whatsapp: 0,
      whatsappBusiness: 0,
    };
    const res = await GET(post(RANGE));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      recordingCount: 6001,
      recordingDurationSecs: 360060,
      incomingRecordings: 2500,
      outgoingRecordings: 3400,
      unknownDirectionRecordings: 101,
      phoneRecordings: 6001,
    });
    expect(h.rpcCalls.filter((c) => c.fn === 'call_kpis_summary')).toHaveLength(
      1
    );
    expect(
      h.rpcCalls.find((c) => c.fn === 'call_kpis_summary')?.args
    ).toMatchObject({
      p_account_id: 'acct-1',
      p_from: '2026-10-01T00:00:00.000Z',
      p_to: '2026-10-06T00:00:00.000Z',
      p_uploaded_by: null,
      p_direction: null,
      p_call_type: null,
      p_contact_ids: null,
      p_phone: null,
      p_status: null,
    });
  });

  it('returns exact answered/missed/unknown counts with the same window and filters', async () => {
    h.recordings = [rec()];
    h.rpcResults['call_event_outcomes_summary'] = {
      missed: 5,
      rejected: 2,
      answered: 9,
      unknown: 1,
    };
    const userId = '123e4567-e89b-12d3-a456-426614174000';
    const res = await GET(post(`${RANGE}&user=${userId}&direction=in`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.missedRecordings).toBe(5);
    expect(json.rejectedRecordings).toBe(2);
    expect(json.answeredEvents).toBe(9);
    expect(json.unknownEvents).toBe(1);
    expect(json.totalEvents).toBe(15);
    const calls = h.rpcCalls.filter(
      (c) => c.fn === 'call_event_outcomes_summary'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_account_id: 'acct-1',
      p_from: '2026-10-01T00:00:00.000Z',
      p_to: '2026-10-06T00:00:00.000Z',
      p_user_id: userId,
      p_direction: 'in',
      p_contact_ids: null,
      p_phone: null,
      p_status: null,
    });
  });

  it('zeroes outcomes when the aggregate is absent, keeps rejected for compatibility', async () => {
    h.recordings = [rec()];
    h.rpcResults['call_event_outcomes_summary'] = null;
    const res = await GET(post(RANGE));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.missedRecordings).toBe(0);
    expect(json.rejectedRecordings).toBe(0);
    expect(json.answeredEvents).toBe(0);
    expect(json.unknownEvents).toBe(0);
    expect(json.totalEvents).toBe(0);
  });

  it('passes user and direction filters through to the KPI RPC', async () => {
    h.recordings = [rec()];
    h.rpcResults['call_kpis_summary'] = {
      total: 1,
      durationSecs: 60,
      incoming: 1,
      incomingDurationSecs: 60,
      outgoing: 0,
      outgoingDurationSecs: null,
      phone: 1,
      whatsapp: 0,
      whatsappBusiness: 0,
    };
    const userId = '123e4567-e89b-12d3-a456-426614174000';
    const res = await GET(post(`${RANGE}&user=${userId}&direction=in`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      recordingCount: 1,
      incomingRecordings: 1,
      outgoingRecordings: 0,
      phoneRecordings: 1,
    });
    expect(
      h.rpcCalls.find((c) => c.fn === 'call_kpis_summary')?.args
    ).toMatchObject({
      p_uploaded_by: userId,
      p_direction: 'in',
    });
  });

  it('resolves text search to contact ids and phone digits for rows and RPCs', async () => {
    h.contacts = [{ id: 'c-9', phone_normalized: '919876543210' }];
    const res = await GET(post(`${RANGE}&q=9198765432`));
    expect(res.status).toBe(200);
    const kpi = h.rpcCalls.find((c) => c.fn === 'call_kpis_summary');
    expect(kpi?.args).toMatchObject({
      p_contact_ids: ['c-9'],
      p_phone: '9198765432',
    });
    const outcomes = h.rpcCalls.find(
      (c) => c.fn === 'call_event_outcomes_summary'
    );
    expect(outcomes?.args).toMatchObject({
      p_contact_ids: ['c-9'],
      p_phone: '9198765432',
    });
    const ors = h.calls.filter(
      (c) => c.table === 'call_recordings' && c.op === 'or'
    );
    expect(ors.length).toBeGreaterThan(0);
    expect(ors[0].args[0]).toContain('contact_id.in.(c-9)');
    expect(ors[0].args[0]).toContain('phone_number.ilike.*9198765432*');
  });

  it('short-circuits unmatched search instead of returning the unfiltered list', async () => {
    h.contacts = [];
    const res = await GET(post(`${RANGE}&q=zzz-no-match`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.recordingCount).toBe(0);
    expect(json.missedRecordings).toBe(0);
    expect(json.recent).toEqual([]);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('supports the shared Unknown direction without guessing', async () => {
    h.recordings = [rec({ id: 'r-1', direction: null })];
    const res = await GET(post(`${RANGE}&direction=unknown`));
    expect(res.status).toBe(200);
    const kpi = h.rpcCalls.find((c) => c.fn === 'call_kpis_summary');
    expect(kpi?.args).toMatchObject({ p_direction: 'unknown' });
    const ors = h.calls.filter(
      (c) => c.table === 'call_recordings' && c.op === 'or'
    );
    expect(ors.length).toBeGreaterThan(0);
    // Missed events always carry a direction, so Unknown matches none.
    expect(
      ((await res.json()) as { recentMissed: unknown[] }).recentMissed
    ).toEqual([]);
  });

  it("scopes rows and RPCs to the workspace table's lead set", async () => {
    const flowId = '223e4567-e89b-12d3-a456-426614174000';
    h.flowRuns = [{ contact_id: 'c-9' }, { contact_id: 'c-10' }];
    const res = await GET(post(`${RANGE}&workspace_table=${flowId}`));
    expect(res.status).toBe(200);
    const kpi = h.rpcCalls.find((c) => c.fn === 'call_kpis_summary');
    expect(kpi?.args).toMatchObject({ p_contact_ids: ['c-9', 'c-10'] });
    const ins = h.calls.filter(
      (c) => c.table === 'call_recordings' && c.op === 'in'
    );
    expect(ins).toContainEqual({
      table: 'call_recordings',
      op: 'in',
      args: ['contact_id', ['c-9', 'c-10']],
    });
  });

  it('returns an empty dashboard for foreign or empty workspace tables', async () => {
    const res = await GET(
      post(`${RANGE}&workspace_table=323e4567-e89b-12d3-a456-426614174000`)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.recordingCount).toBe(0);
    expect(json.recent).toEqual([]);
  });

  it('applies status, call type, and direction filters consistently', async () => {
    const res = await GET(
      post(`${RANGE}&status=linked&call_type=whatsapp&direction=out`)
    );
    expect(res.status).toBe(200);
    const kpi = h.rpcCalls.find((c) => c.fn === 'call_kpis_summary');
    expect(kpi?.args).toMatchObject({
      p_call_type: 'whatsapp',
      p_status: 'linked',
      p_direction: 'out',
    });
    const outcomes = h.rpcCalls.find(
      (c) => c.fn === 'call_event_outcomes_summary'
    );
    // Phone-only events can never match a WhatsApp filter.
    expect(outcomes?.args).toMatchObject({ p_call_type: 'whatsapp' });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.recentMissed).toEqual([]);
  });

  it('aggregates per-salesperson stats with names and answer rates', async () => {
    h.rpcResults['call_salesperson_stats'] = [
      {
        user_id: 'u-1',
        recordings: 7,
        duration_secs: 420,
        answered: 6,
        missed: 1,
      },
      {
        user_id: 'u-2',
        recordings: 0,
        duration_secs: 0,
        answered: 0,
        missed: 0,
      },
    ];
    h.profiles = [{ user_id: 'u-1', full_name: 'Sagar', email: null }];
    const res = await GET(post(RANGE));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      salesperson: Array<Record<string, unknown>>;
    };
    expect(json.salesperson).toEqual([
      {
        userId: 'u-1',
        name: 'Sagar',
        recordings: 7,
        durationSecs: 420,
        answered: 6,
        missed: 1,
        answerRate: 6 / 7,
      },
      {
        userId: 'u-2',
        name: null,
        recordings: 0,
        durationSecs: 0,
        answered: 0,
        missed: 0,
        answerRate: null,
      },
    ]);
    expect(
      h.rpcCalls.find((c) => c.fn === 'call_salesperson_stats')?.args
    ).toMatchObject({
      p_account_id: 'acct-1',
      p_user_id: null,
      p_direction: null,
    });
  });

  it('includes missed events with contact, table, and owner enrichment', async () => {
    h.missedEvents = [
      {
        id: 'e-1',
        contact_id: 'c-9',
        phone_number: '+919876543210',
        user_id: 'u-1',
        occurred_at: '2026-10-05T10:00:00.000Z',
      },
    ];
    h.contacts = [{ id: 'c-9', name: 'Priya', phone: '+919876543210' }];
    h.flowRuns = [
      {
        contact_id: 'c-9',
        flow_id: 'f-1',
        started_at: '2026-10-05T10:00:00.000Z',
      },
    ];
    h.flows = [{ id: 'f-1', name: 'Leads Oct' }];
    h.profiles = [{ user_id: 'u-1', full_name: 'Sagar', email: null }];
    const res = await GET(post(RANGE));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recentMissed: Array<Record<string, unknown>>;
    };
    expect(json.recentMissed).toEqual([
      {
        id: 'e-1',
        contactId: 'c-9',
        contactName: 'Priya',
        phoneNumber: '+919876543210',
        occurredAt: '2026-10-05T10:00:00.000Z',
        workspaceTable: 'Leads Oct',
        ownerName: 'Sagar',
      },
    ]);
  });

  it('buckets trend rows by week for long ranges and by month for year ranges', async () => {
    h.recordings = [
      rec({
        recorded_at: '2026-01-05T12:00:00.000Z',
        created_at: '2026-01-05T12:00:00.000Z',
      }),
    ];
    const year = await GET(
      post('from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z')
    );
    expect(year.status).toBe(200);
    const yearJson = (await year.json()) as {
      trend: { granularity: string; buckets: unknown[] };
    };
    expect(yearJson.trend.granularity).toBe('month');
    expect(yearJson.trend.buckets.length).toBe(12);
    const quarter = await GET(
      post('from=2026-01-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z')
    );
    const quarterJson = (await quarter.json()) as {
      trend: { granularity: string };
    };
    expect(quarterJson.trend.granularity).toBe('week');
  });

  it('never exposes storage internals', async () => {
    h.recordings = [rec()];
    const res = await GET(post(RANGE));
    const dumped = JSON.stringify(await res.json());
    expect(dumped).not.toContain('storage_bucket');
    expect(dumped).not.toContain('storage_path');
  });
});
