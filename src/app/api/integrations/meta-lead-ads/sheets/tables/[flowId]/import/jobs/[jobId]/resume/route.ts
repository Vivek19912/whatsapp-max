// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/import/jobs/[jobId]/resume
//
// Owner-only. Runs one bounded worker pass for this table's
// import job (or revives its terminally failed rows first with
// { revive_failures: true }). Safe to call repeatedly: the drain
// matches by stable Meta Lead ID, so already-synced rows update
// in place and never duplicate. Never touches other tables.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  getTableImportJob,
  pumpImportJob,
  reviveImportJobFailures,
  serializeImportJob,
} from '@/lib/meta-lead-sheets/import-jobs';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';
import { scheduleSheetsDrainSoon } from '@/lib/meta-lead-sheets/trigger';

type Ctx = { params: Promise<{ flowId: string; jobId: string }> };

export async function POST(request: Request, { params }: Ctx) {
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

    const body = (await request.json().catch(() => null)) as {
      revive_failures?: unknown;
    } | null;

    let revived = 0;
    if (body?.revive_failures === true) {
      ({ revived } = await reviveImportJobFailures(admin, job));
    }

    const { claimed, progress } = await pumpImportJob(admin, jobId);
    if (!progress) throw new Error('Import job disappeared.');
    try {
      scheduleSheetsDrainSoon({ accountId: ctx.accountId });
    } catch {
      // Best-effort only.
    }
    return NextResponse.json({
      ok: true,
      claimed,
      revived,
      job: serializeImportJob(progress),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
