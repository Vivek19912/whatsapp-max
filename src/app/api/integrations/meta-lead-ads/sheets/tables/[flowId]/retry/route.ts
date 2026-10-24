// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/retry
//
// Admin+. Table-scoped manual sync-now: drains this Workspace table's
// due Meta Sheets queue rows (force includes auto_sync=false).
// Body optionally narrows to one submission: { submission_id } —
// verified to belong to this table's form (tenant + table scoped).
// Google API failures stay queued with backoff — never silently
// marked successful. Meta-only: never touches Flow Tables.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { drainSheetsQueue } from '@/lib/meta-lead-sheets/queue';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

type Ctx = { params: Promise<{ flowId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    const ctx = await requireRole('admin');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }
    const admin = supabaseAdmin();
    const body = (await request.json().catch(() => null)) as {
      submission_id?: unknown;
    } | null;
    const submissionId =
      typeof body?.submission_id === 'string' &&
      body.submission_id.trim() !== ''
        ? body.submission_id.trim()
        : null;

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
      // Reset this row to due-now so the drain picks it up immediately.
      await admin
        .from('meta_lead_sheets_queue')
        .update({
          status: 'queued',
          next_retry_at: new Date().toISOString(),
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', ctx.accountId)
        .eq('submission_id', submissionId);
    }

    const result = await drainSheetsQueue(admin, {
      onlyAccountId: ctx.accountId,
      onlyFormId: table.formId,
      force: true,
      limit: 20,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
