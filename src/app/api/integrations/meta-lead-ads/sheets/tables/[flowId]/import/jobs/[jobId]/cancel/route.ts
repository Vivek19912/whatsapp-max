// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/cancel
//
// Owner-only. Cancels a queued/running import for this table.
// Terminal jobs are left untouched. Queued rows stay queued (the
// regular drain may still sync them); the job simply stops being
// pumped. Never touches other tables.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  cancelImportJob,
  getImportJobProgress,
  getTableImportJob,
  serializeImportJob,
} from '@/lib/meta-lead-sheets/import-jobs';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

type Ctx = { params: Promise<{ flowId: string; jobId: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { flowId, jobId } = await params;
    const ctx = await requireRole('owner');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }
    const admin = supabaseAdmin();
    const job = await getTableImportJob(admin, {
      accountId: ctx.accountId,
      formId: table.formId,
      jobId,
    });
    if (!job) {
      return NextResponse.json({ error: 'Import job not found.' }, { status: 404 });
    }
    const cancelled = await cancelImportJob(admin, job);
    if (!cancelled) throw new Error('Import job disappeared.');
    const progress = await getImportJobProgress(admin, cancelled);
    return NextResponse.json({ ok: true, job: serializeImportJob(progress) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
