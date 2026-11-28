// GET /api/workspace/meta-export — Excel export (Meta Lead Ads ONLY).
//
// Covers the 14 required cases via a mix of mocked behavior tests
// (auth, kind gate, scoping, filters) + source guarantees (columns,
// batching, isolation, failures). Follows the repo's established
// my-tables mock pattern (hoisted state, no DB).

import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, 'utf8');

// ---------- mocked auth + supabase ----------

const h = vi.hoisted(() => ({
  authed: true,
  role: 'owner',
  accountId: 'acct-1',
  userId: 'u-owner',
  restricted: false,
  resolverThrows: false,
  flows: [] as Array<Record<string, unknown>>,
  rpcRows: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  values: [] as Array<Record<string, unknown>>,
  nodes: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
  submissions: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
}));

function statusError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => {
    if (!h.authed) throw statusError(401, 'Unauthorized');
    return {
      supabase: fakeSupabase(),
      accountId: h.accountId,
      userId: h.userId,
      role: h.role,
      account: { id: h.accountId, name: 'Test' },
    };
  },
  toErrorResponse: (err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status }
    );
  },
}));

vi.mock('@/lib/inbox/assignment-access', () => ({
  resolveWorkspaceVisibility: async () => {
    if (h.resolverThrows) throw new Error('permissions unavailable');
    return { restricted: h.restricted };
  },
}));

function matchesFilters(
  row: Record<string, unknown>,
  filters: Array<{ col: string; val: unknown }>
) {
  return filters.every((f) => {
    if (Array.isArray(f.val)) return (f.val as unknown[]).includes(row[f.col]);
    return row[f.col] === f.val;
  });
}

function fakeSupabase() {
  const apiFor = (
    table: string,
    filters: Array<{ col: string; val: unknown }>
  ) => {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push({ col, val: vals });
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => {
        const pool =
          table === 'flows'
            ? h.flows
            : table === 'meta_lead_forms'
              ? h.forms
              : [];
        const found = pool.find((r) => matchesFilters(r, filters));
        return { data: found ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        const pool =
          table === 'flows'
            ? h.flows
            : table === 'workspace_fields'
              ? h.fields
              : table === 'workspace_values'
                ? h.values
                : table === 'flow_nodes'
                  ? h.nodes
                  : table === 'meta_lead_forms'
                    ? h.forms
                    : table === 'meta_lead_submissions'
                      ? h.submissions
                      : table === 'meta_lead_header_labels'
                        ? []
                        : table === 'profiles'
                          ? h.profiles
                          : [];
        const matched = pool.filter((r) => matchesFilters(r, filters));
        return resolve({ data: matched, error: null });
      },
    };
    return api;
  };
  return {
    from: (table: string) => apiFor(table, []),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn !== 'get_all_meta_leads')
        return { data: null, error: { message: 'unknown fn' } };
      let rows = [...h.rpcRows];
      const flowId = params.p_flow_id as string | null;
      if (flowId) rows = rows.filter((r) => r.flow_id === flowId);
      // Tenant scope mirrors the real RPC (account from auth.uid):
      // rows from other accounts never surface.
      rows = rows.filter((r) => (r.account_id ?? 'acct-1') === h.accountId);
      // Honor the assignee filter the same way the real RPC does:
      // member ids match their own Assigned-To value rows,
      // 'unassigned' matches runs with no live assignment.
      const rawAssignee =
        typeof params.p_assignee === 'string' ? params.p_assignee.trim() : '';
      if (rawAssignee !== '' && rawAssignee.toLowerCase() !== 'all') {
        const assigneeIds = new Set(
          h.fields
            .filter(
              (f) =>
                String(f.name ?? '')
                  .trim()
                  .toLowerCase() === 'assigned to'
            )
            .map((f) => f.id)
        );
        if (rawAssignee.toLowerCase() === 'unassigned') {
          rows = rows.filter(
            (r) =>
              !h.values.some(
                (v) =>
                  v.flow_run_id === r.run_id &&
                  assigneeIds.has(v.field_id) &&
                  typeof v.value_text === 'string' &&
                  v.value_text.trim() !== '' &&
                  v.value_text !== 'Unassigned'
              )
          );
        } else {
          rows = rows.filter((r) =>
            h.values.some(
              (v) =>
                v.flow_run_id === r.run_id &&
                assigneeIds.has(v.field_id) &&
                v.value_text === rawAssignee
            )
          );
        }
      }
      const page = Number(params.p_page ?? 0);
      const pageSize = Number(params.p_page_size ?? 100);
      const total = rows.length;
      const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
      return { data: { total, rows: slice }, error: null };
    },
  };
}

const { GET } = await import('./route');

function req(query: string) {
  return new Request(`http://localhost/api/workspace/meta-export${query}`);
}

function rpcRow(over: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-1',
    meta_lead_id: 'lead-1',
    submission_form_id: 'form-1',
    submission_form_name: 'Himachal',
    ad_id: 'ad-1',
    ad_name: 'Diwali Ad',
    campaign_name: 'Himachal Push',
    is_organic: false,
    meta_created_time: '2026-11-20T08:00:00.000Z',
    submission_answers: {},
    run_id: 'run-1',
    flow_id: 'flow-meta-1',
    flow_name: 'Meta Lead Ads · Himachal Trip Instant Form',
    meta_form_db_id: 'mdb-1',
    contact_id: 'c-1',
    contact_name: 'Aarav',
    contact_phone: '+919999999999',
    conversation_id: null,
    run_status: 'completed',
    started_at: '2026-11-25T10:00:00.000Z',
    last_advanced_at: null,
    ended_at: '2026-11-25T10:00:00.000Z',
    vars: { full_name: 'Aarav', phone_number: '+919999999999', city: 'Manali' },
    ...over,
  };
}

beforeEach(() => {
  h.authed = true;
  h.role = 'owner';
  h.accountId = 'acct-1';
  h.userId = 'u-owner';
  h.restricted = false;
  h.resolverThrows = false;
  h.flows = [
    {
      id: 'flow-meta-1',
      account_id: 'acct-1',
      kind: 'meta_lead_ads',
      name: 'Meta Lead Ads · Himachal Trip Instant Form',
      meta_form_id: 'mdb-1',
    },
    {
      id: 'flow-meta-2',
      account_id: 'acct-1',
      kind: 'meta_lead_ads',
      name: 'Meta Lead Ads · Rajasthan Instant Form',
      meta_form_id: 'mdb-2',
    },
    {
      id: 'flow-wa',
      account_id: 'acct-1',
      kind: 'whatsapp_flow',
      name: 'Chat',
    },
  ];
  h.forms = [
    {
      id: 'mdb-1',
      account_id: 'acct-1',
      form_id: 'form-1',
      form_name: 'Himachal',
      questions: [{ key: 'city', label: 'City', type: 'CUSTOM' }],
      enabled: true,
    },
    {
      id: 'mdb-2',
      account_id: 'acct-1',
      form_id: 'form-2',
      form_name: 'Rajasthan',
      questions: [],
      enabled: true,
    },
  ];
  h.fields = [
    {
      id: 'f-assigned',
      account_id: 'acct-1',
      flow_id: 'flow-meta-1',
      name: 'Assigned To',
      field_type: 'single_select',
      options: ['Unassigned'],
      default_value: null,
      position: 0,
    },
    {
      id: 'f-stage',
      account_id: 'acct-1',
      flow_id: 'flow-meta-1',
      name: 'Stage',
      field_type: 'single_select',
      options: ['New Lead'],
      default_value: 'New Lead',
      position: 1,
    },
  ];
  h.values = [];
  h.submissions = [];
  h.profiles = [];
  h.nodes = [
    {
      flow_id: 'flow-meta-1',
      node_key: 'meta_q_0_city',
      node_type: 'collect_input',
      config: {
        var_key: 'city',
        prompt_text: 'City',
        sheet_column_name: 'City',
        sheet_include: true,
      },
      created_at: '2026-01-01',
    },
  ];
  h.rpcRows = [
    rpcRow({}),
    rpcRow({
      run_id: 'run-2',
      flow_id: 'flow-meta-2',
      flow_name: 'Meta Lead Ads · Rajasthan Instant Form',
      meta_lead_id: 'lead-2',
      started_at: '2026-11-20T10:00:00.000Z',
      vars: { full_name: 'Priya', city: 'Jaipur' },
      is_organic: true,
      campaign_name: 'Other',
      ad_name: 'Other Ad',
    }),
  ];
});

describe('meta-export — scope gates (1-4)', () => {
  it('rejects whatsapp_flow with 400 (export is meta-only)', async () => {
    const res = await GET(req('?tableId=flow-wa'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /only.*Meta Lead/i
    );
  });

  it('All Meta Leads combines multiple forms into one file', async () => {
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml.sheet');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    const dispo = res.headers.get('Content-Disposition') ?? '';
    expect(dispo).toMatch(/All_Meta_Leads.*\.xlsx/);
  });

  it('individual table exports only its own leads', async () => {
    const res = await GET(req('?tableId=flow-meta-1'));
    expect(res.status).toBe(200);
    const dispo = res.headers.get('Content-Disposition') ?? '';
    expect(dispo).toMatch(/Himachal.*\.xlsx/);
  });

  it('unknown table reads as 404, never a cross-tenant oracle', async () => {
    const res = await GET(req('?tableId=00000000-0000-0000-0000-000000000000'));
    expect(res.status).toBe(404);
  });
});

describe('meta-export — filters (5-8)', () => {
  it('date filtering uses Submission Time bounds (started_at)', async () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    expect(s).toContain('p_started_from');
    expect(s).toContain('p_started_to');
    expect(s).toContain('validateWorkspaceDateRange');
    // Never Meta created time for the date window.
    expect(s).not.toMatch(/p_started_from[^;]*meta_created/i);
  });

  it('All Time (no dateFrom/dateTo) returns all matching rows', async () => {
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
  });

  it('custom date boundaries validate together', async () => {
    const res = await GET(
      req('?tableId=all-meta-leads&dateFrom=2026-11-28T00:00:00.000Z')
    );
    expect(res.status).toBe(400);
  });

  it('multiple filters combine (AND): paid + campaign', async () => {
    const res = await GET(
      req('?tableId=all-meta-leads&source=paid&campaign=Himachal%20Push')
    );
    expect(res.status).toBe(200);
    const res2 = await GET(
      req('?tableId=all-meta-leads&source=paid&campaign=Nope')
    );
    expect(res2.status).toBe(404);
  });
});

describe('meta-export — columns, batching, integrity (9-12)', () => {
  it('reuses Workspace column logic + header overrides + dynamic questions', () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    const c = src('src/lib/meta-leads-export/columns.ts');
    expect(s).toContain('buildFlowTableColumns');
    expect(s).toContain('buildAllMetaExportColumns');
    expect(s).toContain('buildSingleTableExportColumns');
    expect(c).toContain('resolveExportHeader');
    expect(c).toContain('resolveMetaHeaderDisplayLabel');
    // No second independent mapping: no hardcoded question list.
    expect(s).not.toContain('Himachal Trip Instant Form 24 NOV');
  });

  it('fetches all records server-side via paged RPC (no browser paging)', () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    expect(s).toContain('EXPORT_RPC_PAGE_SIZE');
    expect(s).toContain('for (let page = 1');
    expect(s).toContain('Math.ceil');
  });

  it('pins the 13-arg get_all_meta_leads overload (migration 180)', () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    // Both RPC calls (options scoping + page fetch) must pass the
    // follow-up bounds added in 180: with only the 11 shared keys,
    // PostgREST cannot choose between the 11-arg (179) and 13-arg
    // (180) overloads and the call fails with an ambiguity error.
    // Null = inactive, so export behavior is unchanged.
    expect(s.match(/p_next_followup_from: null/g)?.length).toBe(2);
    expect(s.match(/p_next_followup_to: null/g)?.length).toBe(2);
  });

  it('virtual union introduces no duplicates (single flow scope + RPC DISTINCT ON)', () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    expect(s).toContain('p_flow_id');
    expect(src('supabase/migrations/179_all_meta_leads.sql')).toContain(
      'DISTINCT ON (s.meta_lead_id)'
    );
  });

  it('enforces tenant isolation + agent permissions server-side', () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    expect(s).toContain('getCurrentAccount');
    expect(s).toContain('account_id');
    expect(s).toContain('resolveWorkspaceVisibility');
    expect(s).toContain('meta_lead_ads');
  });
});

describe('meta-export — auth + failures (13-14)', () => {
  it('unauthorized requests cannot export (401)', async () => {
    h.authed = false;
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(401);
  });

  it('failures return useful errors, never silent truncation', async () => {
    const s = src('src/app/api/workspace/meta-export/route.ts');
    expect(s).toContain('EXCEL_MAX_ROWS');
    expect(s).toContain('1,048,575');
    expect(s).toContain('Narrow the filters');
    expect(s).toContain('toErrorResponse');
  });
});

describe('meta-export — options authorization', () => {
  function seedOptionsScenario() {
    h.role = 'agent';
    h.userId = 'u-a';
    h.restricted = true;
    h.resolverThrows = false;
    h.flows = [
      {
        id: 'flow-meta-1',
        account_id: 'acct-1',
        kind: 'meta_lead_ads',
        name: 'Meta Lead Ads · Form 1',
        meta_form_id: 'mdb-1',
      },
      {
        id: 'flow-meta-2',
        account_id: 'acct-1',
        kind: 'meta_lead_ads',
        name: 'Meta Lead Ads · Form 2',
        meta_form_id: 'mdb-2',
      },
      {
        id: 'flow-meta-3',
        account_id: 'acct-1',
        kind: 'meta_lead_ads',
        name: 'Meta Lead Ads · Form 3',
        meta_form_id: 'mdb-3',
      },
      {
        id: 'flow-wa',
        account_id: 'acct-1',
        kind: 'whatsapp_flow',
        name: 'Chat',
      },
    ];
    h.forms = [
      {
        id: 'mdb-1',
        account_id: 'acct-1',
        form_id: 'form-1',
        form_name: 'Form 1',
        questions: [],
        enabled: true,
      },
      {
        id: 'mdb-2',
        account_id: 'acct-1',
        form_id: 'form-2',
        form_name: 'Form 2',
        questions: [],
        enabled: true,
      },
      {
        id: 'mdb-3',
        account_id: 'acct-1',
        form_id: 'form-3',
        form_name: 'Form 3',
        questions: [],
        enabled: true,
      },
    ];
    h.fields = [
      {
        id: 'f1a',
        account_id: 'acct-1',
        flow_id: 'flow-meta-1',
        name: 'Assigned To',
      },
      {
        id: 'f2a',
        account_id: 'acct-1',
        flow_id: 'flow-meta-2',
        name: 'Assigned To',
      },
      {
        id: 'f3a',
        account_id: 'acct-1',
        flow_id: 'flow-meta-3',
        name: 'Assigned To',
      },
    ];
    h.values = [
      {
        account_id: 'acct-1',
        field_id: 'f1a',
        flow_run_id: 'run-a1',
        value_text: 'u-a',
      },
      {
        account_id: 'acct-1',
        field_id: 'f2a',
        flow_run_id: 'run-a2',
        value_text: 'u-a',
      },
      {
        account_id: 'acct-1',
        field_id: 'f1a',
        flow_run_id: 'run-b1',
        value_text: 'u-b',
      },
      {
        account_id: 'acct-1',
        field_id: 'f3a',
        flow_run_id: 'run-b3',
        value_text: 'u-b',
      },
    ];
    h.rpcRows = [
      rpcRow({
        run_id: 'run-a1',
        flow_id: 'flow-meta-1',
        flow_name: 'Meta Lead Ads · Form 1',
        meta_lead_id: 'lead-a1',
        campaign_name: 'C1',
        ad_name: 'A1',
        is_organic: false,
      }),
      rpcRow({
        run_id: 'run-a2',
        flow_id: 'flow-meta-2',
        flow_name: 'Meta Lead Ads · Form 2',
        meta_lead_id: 'lead-a2',
        campaign_name: 'C2',
        ad_name: 'A2',
        is_organic: true,
      }),
      rpcRow({
        run_id: 'run-b1',
        flow_id: 'flow-meta-1',
        flow_name: 'Meta Lead Ads · Form 1',
        meta_lead_id: 'lead-b1',
        campaign_name: 'C1B',
        ad_name: 'A1B',
        is_organic: false,
      }),
      rpcRow({
        run_id: 'run-b3',
        flow_id: 'flow-meta-3',
        flow_name: 'Meta Lead Ads · Form 3',
        meta_lead_id: 'lead-b3',
        campaign_name: 'C3',
        ad_name: 'A3',
        is_organic: false,
      }),
      rpcRow({
        run_id: 'run-u1',
        flow_id: 'flow-meta-1',
        flow_name: 'Meta Lead Ads · Form 1',
        meta_lead_id: 'lead-u1',
        campaign_name: 'CU',
        ad_name: 'AU',
        is_organic: null,
      }),
    ];
    h.submissions = [
      { account_id: 'acct-1', campaign_name: 'C1', ad_name: 'A1' },
      { account_id: 'acct-1', campaign_name: 'C2', ad_name: 'A2' },
      { account_id: 'acct-1', campaign_name: 'C1B', ad_name: 'A1B' },
      { account_id: 'acct-1', campaign_name: 'C3', ad_name: 'A3' },
      { account_id: 'acct-1', campaign_name: 'CU', ad_name: 'AU' },
    ];
  }

  it('owner All options contain every form + account-wide campaigns/ads', async () => {
    seedOptionsScenario();
    h.role = 'owner';
    h.userId = 'u-owner';
    h.restricted = false;
    const res = await GET(req('?tableId=all-meta-leads&options=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms: Array<{ flowId: string }>;
      campaigns: string[];
      ads: string[];
    };
    expect(body.forms.map((f) => f.flowId).sort()).toEqual([
      'flow-meta-1',
      'flow-meta-2',
      'flow-meta-3',
    ]);
    expect(body.campaigns).toEqual(
      expect.arrayContaining(['C1', 'C2', 'C1B', 'C3', 'CU'])
    );
    expect(body.ads).toEqual(
      expect.arrayContaining(['A1', 'A2', 'A1B', 'A3', 'AU'])
    );
  });

  it('admin and viewer keep account-wide options', async () => {
    seedOptionsScenario();
    for (const role of ['admin', 'viewer']) {
      h.role = role;
      h.userId = `u-${role}`;
      h.restricted = false;
      const res = await GET(req('?tableId=all-meta-leads&options=1'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        forms: Array<{ flowId: string }>;
        campaigns: string[];
      };
      expect(body.forms).toHaveLength(3);
      expect(body.campaigns).toEqual(
        expect.arrayContaining(['C1', 'C3', 'CU'])
      );
    }
  });

  it('restricted agent All options show only own forms + own campaigns/ads', async () => {
    seedOptionsScenario();
    const res = await GET(req('?tableId=all-meta-leads&options=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms: Array<{ flowId: string; tableName: string }>;
      campaigns: string[];
      ads: string[];
    };
    expect(body.forms.map((f) => f.flowId).sort()).toEqual([
      'flow-meta-1',
      'flow-meta-2',
    ]);
    expect(JSON.stringify(body.forms)).not.toContain('Form 3');
    expect(body.campaigns.sort()).toEqual(['C1', 'C2']);
    expect(body.ads.sort()).toEqual(['A1', 'A2']);
    // Other-agent + unassigned metadata never leaks.
    expect(body.campaigns).not.toContain('C1B');
    expect(body.campaigns).not.toContain('C3');
    expect(body.campaigns).not.toContain('CU');
    expect(body.ads).not.toContain('AU');
  });

  it('restricted agent single-table options stay inside that form', async () => {
    seedOptionsScenario();
    const res = await GET(req('?tableId=flow-meta-1&options=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms: Array<{ flowId: string }>;
      campaigns: string[];
      ads: string[];
    };
    expect(body.forms.map((f) => f.flowId)).toEqual(['flow-meta-1']);
    expect(body.campaigns).toEqual(['C1']);
    expect(body.ads).toEqual(['A1']);
  });

  it("requesting another agent's table returns 404 without revealing its name", async () => {
    seedOptionsScenario();
    const res = await GET(req('?tableId=flow-meta-3&options=1'));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('Form 3');
    expect(text).not.toContain('C3');
  });

  it('whatsapp_flow never exposes options, even to agents', async () => {
    seedOptionsScenario();
    const res = await GET(req('?tableId=flow-wa&options=1'));
    expect(res.status).toBe(400);
  });

  it('assignee/formId manipulation cannot widen restricted options', async () => {
    seedOptionsScenario();
    const res = await GET(
      req('?tableId=all-meta-leads&options=1&assignee=u-b&formId=flow-meta-3')
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms: Array<{ flowId: string }>;
      campaigns: string[];
    };
    expect(body.forms.map((f) => f.flowId).sort()).toEqual([
      'flow-meta-1',
      'flow-meta-2',
    ]);
    expect(body.campaigns).not.toContain('C3');
  });

  it('visibility resolver failure fails closed, never account-wide', async () => {
    seedOptionsScenario();
    h.resolverThrows = true;
    const res = await GET(req('?tableId=all-meta-leads&options=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forms: Array<{ flowId: string }>;
      campaigns: string[];
    };
    // Fail-closed restricted scope (own tables only), not all 3.
    expect(body.forms.map((f) => f.flowId).sort()).toEqual([
      'flow-meta-1',
      'flow-meta-2',
    ]);
    expect(body.campaigns).not.toContain('C3');
  });

  it('options still enforce tenant isolation for restricted agents', async () => {
    seedOptionsScenario();
    h.accountId = 'acct-OTHER';
    const res = await GET(req('?tableId=all-meta-leads&options=1'));
    // Foreign-tenant flows never match this account: 404 before any
    // options are built, so no forms, names, or campaigns leak.
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('Form 1');
    expect(text).not.toContain('C1');
  });
});

describe('meta-export — UI gates', () => {
  it('export button appears only for meta tables (never whatsapp_flow)', () => {
    const page = src('src/app/(dashboard)/workspace/page.tsx');
    expect(page).toContain('MetaExportButton');
    expect(page).toContain('isMetaTable && !isAllMetaLeads');
    const view = src('src/components/workspace/all-meta-leads-view.tsx');
    expect(view).toContain('MetaExportButton');
  });
});

describe('meta-export — Assigned To shows names, never UUIDs', () => {
  const AGENT_ID = 'b33ae622-7ec6-460a-8a6e-1644cfe96399';
  const GONE_ID = 'c44bf733-8fd7-571b-9b7f-2755d0a074aa';
  const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

  function seedAssignment(valueText: string | null) {
    h.role = 'owner';
    h.userId = 'u-owner';
    h.restricted = false;
    h.resolverThrows = false;
    h.values =
      valueText === null
        ? []
        : [
            {
              account_id: 'acct-1',
              field_id: 'f-assigned',
              flow_run_id: 'run-1',
              value_text: valueText,
            },
          ];
  }

  function seedProfiles(
    rows: Array<{
      user_id: string;
      full_name: string | null;
      account_id?: string;
    }>
  ) {
    h.profiles = rows.map((r) => ({
      user_id: r.user_id,
      full_name: r.full_name,
      account_id: r.account_id ?? 'acct-1',
    }));
  }

  async function assignedToColumn(res: Response): Promise<(string | null)[]> {
    const buf = await res.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Leads');
    expect(ws).toBeDefined();
    const header = ws!.getRow(1).values as unknown[];
    const idx = (header as unknown[]).findIndex((v) => v === 'Assigned To');
    expect(idx).toBeGreaterThan(0);
    const out: (string | null)[] = [];
    for (let r = 2; r <= ws!.rowCount; r++) {
      const v = ws!.getRow(r).getCell(idx).value;
      if (v === null || v === undefined) {
        out.push(null);
        continue;
      }
      out.push(
        typeof v === 'object'
          ? String((v as { text?: unknown }).text ?? '')
          : String(v)
      );
    }
    return out;
  }

  it('All export shows the agent name, not the UUID', async () => {
    seedAssignment(AGENT_ID);
    seedProfiles([{ user_id: AGENT_ID, full_name: 'Anita Agent' }]);
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    const col = await assignedToColumn(res);
    // run-1 (flow-meta-1) is assigned; run-2 (flow-meta-2, no
    // Assigned-To field) is unassigned.
    expect(col).toEqual(['Anita Agent', 'Unassigned']);
    for (const v of col) {
      if (v !== null) expect(v).not.toMatch(UUID_LIKE);
    }
    expect(res.headers.get('X-Export-Unresolved-Assignees')).toBeNull();
  });

  it('single-table export shows the agent name in its Assigned To column', async () => {
    seedAssignment(AGENT_ID);
    seedProfiles([{ user_id: AGENT_ID, full_name: 'Anita Agent' }]);
    const res = await GET(req('?tableId=flow-meta-1'));
    expect(res.status).toBe(200);
    expect(await assignedToColumn(res)).toEqual(['Anita Agent']);
  });

  it('unresolvable UUIDs render as Unknown and are reported, never leaked', async () => {
    seedAssignment(GONE_ID);
    seedProfiles([]);
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    const col = await assignedToColumn(res);
    expect(col[0]).toBe('Unknown');
    for (const v of col) {
      if (v !== null) expect(v).not.toMatch(UUID_LIKE);
    }
    expect(col.join('|')).not.toContain(GONE_ID);
    expect(res.headers.get('X-Export-Unresolved-Assignees')).toBe('1');
  });

  it('legacy non-UUID display strings are preserved like the UI', async () => {
    seedAssignment('Anita (old)');
    seedProfiles([]);
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    expect(await assignedToColumn(res)).toEqual(['Anita (old)', 'Unassigned']);
    expect(res.headers.get('X-Export-Unresolved-Assignees')).toBeNull();
  });

  it('foreign-account profiles never resolve assignees', async () => {
    seedAssignment(AGENT_ID);
    seedProfiles([
      {
        user_id: AGENT_ID,
        full_name: 'Foreign Fiona',
        account_id: 'acct-OTHER',
      },
    ]);
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    const col = await assignedToColumn(res);
    expect(col[0]).toBe('Unknown');
    expect(col.join('|')).not.toContain('Foreign Fiona');
    expect(res.headers.get('X-Export-Unresolved-Assignees')).toBe('1');
  });
});

describe('meta-export — presentation: dates, removed columns, phone dedupe', () => {
  async function loadSheet(res: Response) {
    const buf = await res.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Leads');
    expect(ws).toBeDefined();
    const header = ws!.getRow(1).values as unknown[];
    const headers = (header as unknown[]).slice(1).map(String);
    const idxOf = (h: string) =>
      (header as unknown[]).findIndex((v) => v === h);
    return { ws: ws!, headers, idxOf };
  }

  const normPhone = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '');

  it('All export omits provenance columns and formats Submission Time', async () => {
    const res = await GET(req('?tableId=all-meta-leads'));
    expect(res.status).toBe(200);
    const { ws, headers, idxOf } = await loadSheet(res);
    for (const removed of [
      'Ad Name',
      'Campaign Name',
      'Lead Source',
      'Meta Created Time',
      'Meta Lead ID',
    ]) {
      expect(headers).not.toContain(removed);
    }
    // Column D remains the system Phone Number.
    expect(headers.slice(0, 4)).toEqual([
      'No.',
      'Submission Time',
      'Name',
      'Phone Number',
    ]);
    // Exactly one phone-number column (case-insensitive).
    expect(headers.filter((hh) => normPhone(hh) === 'phonenumber')).toEqual([
      'Phone Number',
    ]);
    // Submission Time is a real date with 12-hour AM/PM formatting.
    const cell = ws.getRow(2).getCell(idxOf('Submission Time'));
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toBe('dd-mm-yyyy hh:mm AM/PM');
    void ws;
  });

  it('single-table export drops the duplicate phone question column', async () => {
    h.nodes.push({
      flow_id: 'flow-meta-1',
      node_key: 'meta_q_1_phone',
      node_type: 'collect_input',
      config: {
        var_key: 'phone_number',
        prompt_text: 'Phone number',
        sheet_column_name: 'Phone number',
        sheet_include: true,
      },
      created_at: '2026-01-03',
    });
    const res = await GET(req('?tableId=flow-meta-1'));
    expect(res.status).toBe(200);
    const { headers } = await loadSheet(res);
    expect(headers.slice(0, 4)).toEqual([
      'No.',
      'Submission Time',
      'Name',
      'Phone Number',
    ]);
    expect(headers.filter((hh) => normPhone(hh) === 'phonenumber')).toEqual([
      'Phone Number',
    ]);
    for (const removed of [
      'Ad Name',
      'Campaign Name',
      'Lead Source',
      'Meta Created Time',
      'Meta Lead ID',
    ]) {
      expect(headers).not.toContain(removed);
    }
    // Other dynamic question columns survive.
    expect(headers).toContain('City');
  });

  it('Last Contact Date renders date-only while other dates keep time', async () => {
    h.fields.push({
      id: 'f-lcd',
      account_id: 'acct-1',
      flow_id: 'flow-meta-1',
      name: 'Last Contact Date',
      field_type: 'text',
      options: null,
      default_value: null,
      position: 2,
    });
    h.values.push({
      account_id: 'acct-1',
      field_id: 'f-lcd',
      flow_run_id: 'run-1',
      value_text: '2026-11-27',
    });
    const res = await GET(req('?tableId=flow-meta-1'));
    expect(res.status).toBe(200);
    const { ws, idxOf } = await loadSheet(res);
    const lcdIdx = idxOf('Last Contact Date');
    expect(lcdIdx).toBeGreaterThan(0);
    const lcdCell = ws.getRow(2).getCell(lcdIdx);
    expect(lcdCell.value).toBeInstanceOf(Date);
    expect(lcdCell.numFmt).toBe('dd-mm-yyyy');
    // Empty dates stay empty.
    h.values = h.values.filter(
      (v) => !(v.field_id === 'f-lcd' && v.flow_run_id === 'run-1')
    );
    const res2 = await GET(req('?tableId=flow-meta-1'));
    expect(res2.status).toBe(200);
    const second = await loadSheet(res2);
    expect(
      second.ws.getRow(2).getCell(second.idxOf('Last Contact Date')).value
    ).toBeNull();
  });
});
