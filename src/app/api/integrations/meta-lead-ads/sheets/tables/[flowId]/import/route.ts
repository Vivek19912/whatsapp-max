// POST /api/integrations/meta-lead-ads/sheets/tables/[flowId]/import
//
// Owner-only manual historical import for ONE Workspace table
// (Meta Lead Ads Sheets only — never touches Flow Tables).
//
// Body:
//   { mode: "all" } — every existing processed lead of this table.
//   { mode: "range", from: "YYYY-MM-DD", to: "YYYY-MM-DD" } — only
//     leads whose Workspace submission time falls in the inclusive
//     UTC day range.
//
// The table is resolved server-side (same account, Meta table,
// same-account form); every query below carries (account, form),
// so no other table or account can be imported. Source of truth is
// the existing Workspace lead records (read-only — Workspace rows
// are never written). Matching downstream is by stable Meta Lead
// ID: already-mapped rows are refreshed in place, never appended
// twice. This path only enqueues + drains due rows for the form —
// it never changes auto_sync or any other configuration.
//
// Response: { ok, import: { total, imported, updated, skipped,
// failed, truncated }, drain: { sent, failed } }.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  drainSheetsQueue,
  importTableLeads,
  type TableImportRange,
} from '@/lib/meta-lead-sheets/queue';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';
import { scheduleSheetsDrainSoon } from '@/lib/meta-lead-sheets/trigger';

export const maxDuration = 60;

type Ctx = { params: Promise<{ flowId: string }> };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || !DAY_RE.test(raw)) return null;
  return Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`)) ? null : raw;
}

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
      mode?: unknown;
      from?: unknown;
      to?: unknown;
    } | null;
    const mode = body?.mode === 'all' || body?.mode === 'range' ? body.mode : null;
    if (!mode) {
      return NextResponse.json(
        { error: 'Choose "all" or a date range to import.' },
        { status: 400 }
      );
    }
    let range: TableImportRange | null = null;
    if (mode === 'range') {
      const from = cleanDay(body?.from);
      const to = cleanDay(body?.to);
      if (!from || !to) {
        return NextResponse.json(
          { error: 'Select a valid start and end date (YYYY-MM-DD).' },
          { status: 400 }
        );
      }
      if (from > to) {
        return NextResponse.json(
          { error: 'The start date must be on or before the end date.' },
          { status: 400 }
        );
      }
      range = { from, to };
    }

    // The table must have a saved sheet target: without one the
    // drain would only park rows, and the counts would mislead.
    const { data: config } = await admin
      .from('meta_lead_sheets_configs')
      .select('spreadsheet_id')
      .eq('account_id', ctx.accountId)
      .eq('form_id', table.formId)
      .maybeSingle();
    if (!config) {
      return NextResponse.json(
        { error: 'Configure this table’s sheet first (Save Configuration).' },
        { status: 409 }
      );
    }

    const summary = await importTableLeads(admin, ctx.accountId, table.formId, range);
    // Best-effort immediate drain so rows land without waiting for
    // the cron; anything left stays queued for retry. Failures stay
    // visible in the returned counts — never silent.
    const drained = await drainSheetsQueue(admin, {
      onlyAccountId: ctx.accountId,
      onlyFormId: table.formId,
      force: true,
      limit: 100,
    });
    // Prompt post-response drain for anything left over; the cron
    // remains the fallback. Tracked `after()`, never detached.
    scheduleSheetsDrainSoon({ accountId: ctx.accountId });
    return NextResponse.json({
      ok: true,
      import: summary,
      drain: { sent: drained.sent, failed: drained.failed },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
