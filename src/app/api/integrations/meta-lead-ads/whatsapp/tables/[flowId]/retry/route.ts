// /api/integrations/meta-lead-ads/whatsapp/tables/[flowId]/retry
//
// POST (owner-only) — revive this table's failed auto-send rows so
// an admin fix (template approved, WhatsApp connected, unpaused)
// can actually deliver. Revived rows resume in their configured
// order; already-sent rows are never touched. Flow Tables resolve
// to 404 — their behavior is unchanged.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';
import {
  getTableWhatsappStatus,
  retryTableWhatsappQueue,
} from '@/lib/meta-lead-whatsapp/queue';
import { scheduleWhatsappDrainSoon } from '@/lib/meta-lead-whatsapp/trigger';

export const maxDuration = 60;

type Ctx = { params: Promise<{ flowId: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    const ctx = await requireRole('owner');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    // Service-role write: the queue table exposes SELECT-only
    // RLS (workers own writes). Tenant scope comes from the
    // resolved table — (account, form) only.
    const { revived } = await retryTableWhatsappQueue(
      supabaseAdmin(),
      ctx.accountId,
      table.formId
    );

    if (revived > 0) {
      try {
        scheduleWhatsappDrainSoon({ accountId: ctx.accountId });
      } catch {
        // Best-effort only; the cron covers it.
      }
    }

    const status = await getTableWhatsappStatus(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );
    return NextResponse.json({ ok: true, revived, counts: status.counts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
