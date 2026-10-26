// GET /api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]
//
// Members+: read one import job's status + progress for THIS
// table. Pure read — polling never restarts work, revives rows,
// or touches the sheet. Tenant + table scoped: the job must
// belong to this account AND this table's form (Flow Tables
// resolve to 404 upstream).

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  getImportJobProgress,
  getTableImportJob,
  serializeImportJob,
} from '@/lib/meta-lead-sheets/import-jobs';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

type Ctx = { params: Promise<{ flowId: string; jobId: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { flowId, jobId } = await params;
    const ctx = await getCurrentAccount();
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
    const progress = await getImportJobProgress(admin, job);
    return NextResponse.json({ ok: true, job: serializeImportJob(progress) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
