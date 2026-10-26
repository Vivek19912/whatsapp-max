// Meta Sheets scope protection — pins the "Meta-only, additive"
// contract with source assertions (mirrors the workspace
// meta-lead-ads-columns.test.ts pattern):
//   * ingestion/assignment/workspace/cron hooks are additive and
//     Meta-gated; existing polling/assignment/email/CAPI behavior
//     is untouched;
//   * Flow Tables code never imports the Meta Sheets stack;
//   * the new migration only adds meta_lead_sheets_* tables.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, 'utf8');

describe('meta sheets — additive ingestion hook', () => {
  it('queues Sheets sync after the Workspace write without touching lead logic', () => {
    const s = src('src/lib/meta-lead-ads/process-lead.ts');
    expect(s).toContain('maybeEnqueueSheetsSync');
    // Existing behavior preserved.
    expect(s).toContain('onMetaLeadReceived');
    expect(s).toContain('maybeAutoAssignLead');
    expect(s).toContain('maybeEnqueueLeadNotification');
    expect(s).toContain('MAX_LEAD_ATTEMPTS');
    // Never synchronous: only an outbox enqueue, no direct Sheets fetch.
    expect(s).not.toContain('appendSheetsRows');
    expect(s).not.toContain('updateSheetsRow');
  });
});

describe('meta sheets — assignment hooks stay Meta-only', () => {
  it('auto + manual assignment enqueue best-effort without overwriting owners', () => {
    const s = src('src/lib/lead-assignment/service.ts');
    expect(s).toContain('maybeEnqueueSheetsSync');
    expect(s).toContain('already-owned');
    expect(s).toContain('never overwrite');
  });

  it('workspace cell edits gate on kind === meta_lead_ads', () => {
    const s = src('src/app/api/flows/[id]/workspace-values/route.ts');
    expect(s).toContain('enqueueSheetsSyncForRun');
    expect(s).toContain('meta_lead_ads');
    // Conversions API hook preserved.
    expect(s).toContain('recordWorkspaceStatusChanged');
  });

  it('workspace cell edits enqueue through the service role (agent RLS cannot starve sync)', () => {
    const s = src('src/app/api/flows/[id]/workspace-values/route.ts');
    // The queue's RLS policy only allows admin inserts: a
    // user-scoped agent client would be denied and the UI would
    // falsely look synced. Both the clear and the save paths must
    // use the service-role client after the server-side
    // (account, run) authorization above.
    expect(
      s.match(/enqueueSheetsSyncForRun\(supabaseAdmin\(\)/g) ?? []
    ).toHaveLength(2);
    expect(s).not.toContain('enqueueSheetsSyncForRun(supabase,');
    // The enqueue outcome is reported, never faked as success.
    expect(s).toContain('sheetsSync');
  });
});

describe('meta sheets — cron stays additive', () => {
  it('drains Sheets in the same sweep without changing polling cadence', () => {
    const s = src('src/app/api/integrations/meta-lead-ads/cron/route.ts');
    expect(s).toContain('runDueRetries');
    expect(s).toContain('runLeadPolls');
    expect(s).toContain('drainMetaLeadNotifications');
    expect(s).toContain('drainSheetsQueue');
    expect(s).toContain('POLL_DEFAULT_LIMIT');
  });
});

describe('flow tables — no regression', () => {
  const flowFiles = [
    'src/lib/flows/sheet-sync.ts',
    'src/lib/flows/sheet-layout.ts',
    'src/lib/flows/sheet-columns.ts',
    'src/lib/google/sheets.ts',
    'src/lib/google/oauth.ts',
    'src/app/api/google-sheets/[flowId]/import/route.ts',
    'src/app/api/flows/[id]/sheet/route.ts',
    'src/app/api/flows/[id]/sheet/backfill/route.ts',
  ];

  for (const file of flowFiles) {
    it(`${file} never imports the Meta Sheets stack`, () => {
      const s = src(file);
      expect(s).not.toContain('meta-lead-sheets');
      expect(s).not.toContain('meta_lead_sheets');
      expect(s).not.toContain('META_SHEETS');
    });
  }

  it('flow sheet sync writer is untouched', () => {
    const s = src('src/lib/flows/sheet-sync.ts');
    expect(s).toContain('resolveFlowSheetColumns');
    expect(s).not.toContain('findSheetsRowsByLeadId');
  });

  it('meta sheets client does not import flow sheets helpers', () => {
    const s = src('src/lib/meta-lead-sheets/sheets-client.ts');
    // Import statements only — the header comment names the modules
    // it deliberately avoids, so match the @/ import prefix.
    expect(s).not.toContain('@/lib/google/sheets"');
    expect(s).not.toContain('@/lib/google/tabs');
    expect(s).not.toContain('flow_sheet_configs');
  });

  it('the whole meta sheets stack is independent of flow sheets modules', () => {
    const mapping = src('src/lib/meta-lead-sheets/mapping.ts');
    const queue = src('src/lib/meta-lead-sheets/queue.ts');
    const oauth = src('src/lib/meta-lead-sheets/oauth.ts');
    const columns = src('src/lib/meta-lead-sheets/columns.ts');
    const trigger = src('src/lib/meta-lead-sheets/trigger.ts');
    const tables = src('src/lib/meta-lead-sheets/tables.ts');
    const stack = [
      ['mapping', mapping],
      ['queue', queue],
      ['oauth', oauth],
      ['columns', columns],
      ['trigger', trigger],
      ['tables', tables],
    ] as const;
    for (const [name, s] of stack) {
      expect(s, name).not.toContain('@/lib/google/sheets');
      expect(s, name).not.toContain('@/lib/google/tabs');
      expect(s, name).not.toContain('@/lib/flows/sheet-');
    }
    // columns.ts maps via the Meta virtual-flow derivation only.
    expect(columns).not.toContain('@/lib/flows/');
    // tables.ts resolves Workspace tables via flows + Meta forms only.
    expect(tables).not.toContain('google');
    // The workspace dialog never touches Flow Table helpers.
    const dialog = src('src/components/workspace/meta-table-sheets-dialog.tsx');
    expect(dialog).not.toContain('flow_sheet_configs');
    expect(dialog).not.toContain('@/lib/flows/sheet-');
  });
});

describe('migration scope', () => {
  it('only adds meta_lead_sheets_* tables', () => {
    const s = src('supabase/migrations/129_meta_lead_google_sheets.sql');
    expect(s).toContain('meta_lead_sheets_connections');
    expect(s).toContain('meta_lead_sheets_configs');
    expect(s).toContain('meta_lead_sheets_queue');
    // No DDL against existing tables — only the new
    // meta_lead_sheets_* tables get ALTERs (RLS + triggers). The
    // header comment names the tables it deliberately avoids, so
    // match ALTERs on other tables explicitly.
    expect(s).not.toContain('ALTER TABLE public.flows');
    expect(s).not.toContain('ALTER TABLE public.flow_runs');
    expect(s).not.toContain('ALTER TABLE public.workspace');
    expect(s).not.toContain('ALTER TABLE public.google_connections');
    expect(s).not.toContain('ALTER TABLE public.flow_sheet_configs');
    expect(s).not.toContain('ALTER TABLE public.meta_lead_connections');
    expect(s).not.toContain('ALTER TABLE public.meta_lead_pages');
    expect(s).not.toContain('ALTER TABLE public.meta_lead_forms');
    expect(s).not.toContain('ALTER TABLE public.meta_lead_submissions');
  });

  it('migration 130 only extends the sheets config table', () => {
    const s = src('supabase/migrations/130_meta_lead_sheets_columns.sql');
    expect(s).toContain('form_ids');
    expect(s).toContain('column_config');
    expect(s).toContain('pending_remap');
    // Only the meta_lead_sheets_configs table is altered.
    const alters = s.match(/^ALTER TABLE .*$/gm) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const stmt of alters) {
      expect(stmt).toContain('meta_lead_sheets_configs');
    }
    expect(s).not.toContain('CREATE TABLE');
  });

  it('migration 137 only retains oauth states without touching other tables', () => {
    const s = src('supabase/migrations/137_meta_lead_sheets_retention.sql');
    expect(s).toContain('meta_lead_sheets_oauth_states');
    expect(s).toContain('meta_lead_sheets_import_jobs');
    expect(s).not.toContain('ALTER TABLE public.flows');
    expect(s).not.toContain('ALTER TABLE public.flow_runs');
    expect(s).not.toContain('ALTER TABLE public.workspace');
    expect(s).not.toContain('DROP TABLE');
    expect(s).not.toContain('DELETE FROM public.meta_lead_sheets_queue');
    // Terminal import jobs are retained as the audit trail.
    expect(s).not.toContain('DELETE FROM public.meta_lead_sheets_import_jobs');
  });

  it('migration 131 moves configs to per-table rows without touching other tables', () => {
    const s = src('supabase/migrations/131_meta_lead_sheets_per_table.sql');
    expect(s).toContain('form_id');
    expect(s).toContain('meta_lead_forms');
    // Only the sheets config table is altered.
    const alters = s.match(/^ALTER TABLE .*$/gm) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const stmt of alters) {
      expect(stmt).toContain('meta_lead_sheets_configs');
    }
    expect(s).not.toContain('CREATE TABLE');
    expect(s).not.toContain('DROP TABLE');
    // Legacy rows are migrated, never silently dropped without a target.
    expect(s).toContain('pending_remap');
  });
});

describe('settings UI separation', () => {
  it('adds Sheets as a separate card without replacing CAPI/email sections', () => {
    const settings = src('src/components/settings/meta-lead-ads-settings.tsx');
    expect(settings).toContain('MetaLeadSheetsSettings');
    expect(settings).toContain('New-lead email notifications');
    expect(settings).toContain('Conversions API');
  });

  it('settings card is connection-only (per-table config lives in Workspace)', () => {
    const card = src('src/components/settings/meta-lead-sheets-settings.tsx');
    expect(card).toContain('Meta-only');
    expect(card).toContain('Flow Tables');
    expect(card).toContain('/api/integrations/meta-lead-ads/google/status');
    expect(card).not.toContain('google_connections');
    // No per-table controls in Settings anymore.
    expect(card).not.toContain('sheets/config');
    expect(card).not.toContain('Meta Forms to Sync');
    expect(card).not.toContain('form_ids');
  });

  it('workspace dialog is Meta-table-only and owner-gated', () => {
    const page = src('src/app/(dashboard)/workspace/page.tsx');
    expect(page).toContain('MetaTableSheetsDialog');
    // Only rendered for Meta Lead Ads tables with the owner behind
    // the wheel — admins, agents, and viewers see no sheet actions.
    // (The toolbar is owner-gated per table; Meta tables get the
    // sheet actions in their action set.)
    expect(page).toContain('isOwner && flowId');
    // Flow Table rendering paths are untouched.
    expect(page).toContain('{isMetaTable ? null : (');
  });
});
