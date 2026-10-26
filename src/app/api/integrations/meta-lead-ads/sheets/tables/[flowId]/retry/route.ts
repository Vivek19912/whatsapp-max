// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/retry
//
// Owner-only. Table-scoped manual sync-now: drains this Workspace table's
// due Meta Sheets queue rows (force includes auto_sync=false).
// Body optionally narrows to one submission: { submission_id } —
// verified to belong to this table's form (tenant + table scoped).
// Body optionally revives exhausted failures first:
// { revive_failed: true } resets every `failed` row of this table
// (attempts cleared, due immediately) so quota storms and other
// terminal failures can be retried safely. Rows already synced
// (`sent`) are never touched, so revival cannot duplicate
// spreadsheet rows. Google API failures stay queued with backoff —
// never silently marked successful. Meta-only: never touches
// Flow Tables.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  drainSheetsQueue,
  reviveTableFailedRows,
} from '@/lib/meta-lead-sheets/queue';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

type Ctx = { params: Promise<{ flowId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    const ctx = await requireRole('owner');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }
    const admin = supabaseAdmin();
    const body = (await request.json().catch(() => null)) as {
      submission_id?: unknown;
      revive_failed?: unknown;
    } | null;
    const submissionId =
      typeof body?.submission_id === 'string' &&
      body.submission_id.trim() !== ''
        ? body.submission_id.trim()
        : null;
    const reviveFailed = body?.revive_failed === true;

    let revived = 0;
    if (submissionId) {
      // Verify ownership AND table scope before touching the queue.
      const { data } = await admin
        .from('meta_lead_submissions')
        .select('id')
        .eq('id', submissionId)
        .eq('account_id', ctx.accountId)
        .eq('form_id', table.formId)
        .maybeSingle();
      if (!data) {
        return NextResponse.json(
          { error: 'Submission not found.' },
          { status: 404 }
        );
      }
      // Reset this row to due-now with a fresh attempt budget so an
      // exhausted failure can actually deliver on the drain below.
      // Only failed rows are reset — sent rows are never touched.
      const { data: reset } = await admin
        .from('meta_lead_sheets_queue')
        .update({
          status: 'queued',
          attempts: 0,
          last_error: null,
          next_retry_at: new Date().toISOString(),
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', ctx.accountId)
        .eq('submission_id', submissionId)
        .eq('status', 'failed')
        .select('id');
      revived = ((reset ?? []) as unknown[]).length;
    } else if (reviveFailed) {
      // Revive every failed row of THIS table only (account + form
      // scoped). Sent rows are untouched by the status filter, so
      // synced spreadsheet rows can never duplicate; rows whose
      // submission was deleted are dropped by the drain instead.
      ({ revived } = await reviveTableFailedRows(
        admin,
        ctx.accountId,
        table.formId
      ));
    }

    const result = await drainSheetsQueue(admin, {
      onlyAccountId: ctx.accountId,
      onlyFormId: table.formId,
      force: true,
      limit: 20,
    });
    return NextResponse.json({ ok: true, revived, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
