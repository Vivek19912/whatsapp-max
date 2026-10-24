// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/cleanup
//
// Admin+. EXPLICIT, confirmed removal of THIS Workspace table's
// managed spreadsheet rows. Only rows with a verified queue mapping
// (account + this table's form + recorded sheet_row_number) are
// ever deleted; sent rows without a recorded number and all user
// content are never touched. Remaining managed row numbers are
// repaired arithmetically and the removed queue rows are dropped so
// the leads do not re-sync. Requires { confirmed: true } —
// otherwise 400. Meta-only: never touches Flow Tables.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { metaErrorResponse } from '@/lib/meta-lead-ads/error-response';
import { cleanupTableRows } from '@/lib/meta-lead-sheets/queue';
import {
  getSheetsAccessToken,
  SheetsAuthError,
} from '@/lib/meta-lead-sheets/oauth';
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
    const body = (await request.json().catch(() => null)) as {
      confirmed?: unknown;
    } | null;
    if (body?.confirmed !== true) {
      return NextResponse.json(
        {
          error:
            'Confirm explicitly with { confirmed: true }. This deletes spreadsheet rows.',
        },
        { status: 400 }
      );
    }
    const admin = supabaseAdmin();
    let accessToken: string;
    try {
      accessToken = await getSheetsAccessToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        return NextResponse.json(
          { error: 'Connect a Google account first.' },
          { status: 409 }
        );
      }
      throw err;
    }
    const result = await cleanupTableRows(
      admin,
      accessToken,
      ctx.accountId,
      table.formId
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && /not configured/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return metaErrorResponse(err);
  }
}
