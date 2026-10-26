// Meta Sheets auth + tenant isolation — source assertions.
// Verifies every mutating route enforces the owner role (reads stay
// member-readable), scopes all queries by the caller's account,
// and never exposes tokens.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, 'utf8');

describe('meta sheets routes — authorization', () => {
  it('connect requires admin', () => {
    expect(
      src('src/app/api/integrations/meta-lead-ads/google/connect/route.ts')
    ).toContain('requireRole("admin")');
  });

  it('callback requires admin and binds state to the session account', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/google/callback/route.ts'
    );
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain('consumeSheetsOAuthState');
    expect(s).toContain('account_mismatch');
    expect(s).not.toContain('access_token');
  });

  it('table config GET is member-readable and PUT requires the owner + validates first', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/config/route.ts'
    );
    expect(s).toContain('getCurrentAccount()');
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    expect(s).toContain('getSheetsAccessToken');
    expect(s).toContain('getSheetsSpreadsheet');
    expect(s).toContain('ensureSheetsHeader');
    expect(s).not.toContain('access_token');
  });

  it('table retry requires the owner, verifies the table, and scopes the submission', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/retry/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    expect(s).toContain(".eq('form_id', table.formId)");
    expect(s).toContain('onlyFormId: table.formId');
  });

  it('table cleanup requires the owner plus explicit confirmation', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/cleanup/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    expect(s).toContain('confirmed');
  });

  it('tabs listing is account-scoped and never returns tokens', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tabs/route.ts'
    );
    expect(s).toContain('getCurrentAccount()');
    expect(s).toContain('getSheetsAccessToken(ctx.supabase, ctx.accountId)');
    expect(s).toContain('parseSheetsSpreadsheetId');
    expect(s).not.toContain('refresh_token');
  });

  it('tab creation is owner-only, table-scoped, and duplicate-safe', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tabs/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    expect(s).toContain('validateWorksheetTabName');
    expect(s).toContain('createWorksheetTab');
    expect(s).toContain('already exists');
    expect(s).not.toContain('access_token');
    expect(s).not.toContain('refresh_token');
  });

  it('tab deletion is owner-only, requires an explicit tab, and never touches configs', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tabs/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain('deleteWorksheetTab');
    expect(s).toContain('Select a worksheet tab to delete.');
    expect(s).not.toContain('meta_lead_sheets_configs');
    expect(s).not.toContain('deleteDimension');
    expect(s).not.toContain('access_token');
  });

  it('spreadsheet creation is owner-only, table-scoped, and never syncs', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/spreadsheets/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    expect(s).toContain('getSheetsAccessToken(ctx.supabase, ctx.accountId)');
    expect(s).toContain('createSheetsSpreadsheet');
    expect(s).toContain('Meta Leads -');
    expect(s).not.toContain('meta_lead_sheets_configs');
    expect(s).not.toContain('drainSheetsQueue');
    expect(s).not.toContain('backfill');
    expect(s).not.toContain('access_token');
    expect(s).not.toContain('refresh_token');
  });

  it('table import is owner-only, table-scoped, and never writes Workspace rows', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/route.ts'
    );
    expect(s).toContain("requireRole('owner')");
    expect(s).toContain(
      'resolveTableForm(ctx.supabase, ctx.accountId, flowId)'
    );
    // Durable jobs: the route only starts a job and runs a single
    // bounded worker pass — bulk Google work happens in bounded
    // drains, never inline in the request.
    expect(s).toContain('createImportJob');
    expect(s).toContain('pumpImportJob');
    expect(s).toContain('scheduleSheetsDrainSoon');
    expect(s).not.toContain('importTableLeads');
    expect(s).not.toContain('workspace_values');
    expect(s).not.toContain('access_token');
    expect(s).not.toContain('refresh_token');
  });

  it('import job routes stay table-scoped and never write Workspace rows', () => {
    for (const file of [
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/route.ts',
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/resume/route.ts',
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/cancel/route.ts',
      'src/lib/meta-lead-sheets/import-jobs.ts',
    ]) {
      const s = src(file);
      expect(s).not.toContain('workspace_values');
      expect(s).not.toContain('access_token');
      expect(s).not.toContain('refresh_token');
    }
    // Status reads are member-visible; mutations require the owner.
    expect(
      src(
        'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/route.ts'
      )
    ).toContain('getCurrentAccount');
    for (const file of [
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/resume/route.ts',
      'src/app/api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/cancel/route.ts',
    ]) {
      expect(src(file)).toContain("requireRole('owner')");
    }
  });

  it('account-wide retry requires the owner and stays account-scoped', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/sheets/retry/route.ts'
    );
    expect(s).toContain('requireRole("owner")');
    expect(s).toContain('.eq("account_id", ctx.accountId)');
  });

  it('per-table status never returns tokens', () => {
    const s = src('src/lib/meta-lead-sheets/queue.ts');
    expect(s).toContain('getTableSheetsStatus');
    const statusFn = s.slice(s.indexOf('getTableSheetsStatus'));
    expect(statusFn).not.toContain('access_token');
    expect(statusFn).not.toContain('refresh_token');
  });

  it('disconnect is admin-only and scoped', () => {
    const s = src(
      'src/app/api/integrations/meta-lead-ads/google/disconnect/route.ts'
    );
    expect(s).toContain('requireRole("admin")');
    expect(s).toContain('.eq("account_id", ctx.accountId)');
  });
});

describe('meta sheets lib — tenant isolation', () => {
  it('every queue query is account-scoped', () => {
    const s = src('src/lib/meta-lead-sheets/queue.ts');
    const scoped = (s.match(/\.eq\(['"]account_id['"], /g) ?? []).length;
    expect(scoped).toBeGreaterThan(10);
    expect(s).toContain('onlyAccountId');
  });

  it('oauth tokens are encrypted and never logged', () => {
    const s = src('src/lib/meta-lead-sheets/oauth.ts');
    expect(s).toContain('encrypt(');
    expect(s).toContain('decrypt(');
    expect(s).not.toContain('console.log');
  });

  it('sheets client sends tokens only as Bearer headers', () => {
    const s = src('src/lib/meta-lead-sheets/sheets-client.ts');
    expect(s).toContain('Authorization');
    expect(s).not.toContain('access_token=');
  });
});
