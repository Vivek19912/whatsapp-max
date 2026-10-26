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
// are never written).
//
// Durable background processing: the request classifies (bulk,
// DB-local), enqueues idempotently, persists one import job, runs
// a single bounded worker pass, and returns promptly with the job
// — it never holds the connection open for the whole import.
// Matching downstream is by stable Meta Lead ID: already-mapped
// rows refresh in place, never appended twice. Only one active
// import per table (409 with the running job otherwise). Progress
// polling (GET jobs/[jobId]) is a pure read and never restarts
// work; the cron keeps pumping active jobs in the background.
//
// Response: { ok, job: { id, status, total, processed, sent,
// failed, retrying, pending, inserted, updated, skipped,
// truncated, ... } }.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  ActiveImportJobError,
  createImportJob,
  pumpImportJob,
  serializeImportJob,
} from '@/lib/meta-lead-sheets/import-jobs';
import type { TableImportRange } from '@/lib/meta-lead-sheets/queue';
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
    // worker would only park rows, and the counts would mislead.
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

    let jobId: string;
    try {
      const job = await createImportJob(admin, {
        accountId: ctx.accountId,
        formId: table.formId,
        flowId: table.flowId,
        mode,
        range,
        createdBy: ctx.userId,
      });
      jobId = job.id;
    } catch (err) {
      if (err instanceof ActiveImportJobError) {
        return NextResponse.json(
          {
            error:
              'An import is already running for this table. Resume it below instead of starting a new one.',
            jobId: err.jobId || undefined,
          },
          { status: 409 }
        );
      }
      throw err;
    }

    // One bounded worker pass inline so the first rows land
    // without waiting for the cron; anything left stays queued
    // and completes via the cron + prompt drains.
    const { progress } = await pumpImportJob(admin, jobId);
    if (!progress) throw new Error('Import job disappeared after creation.');
    // Prompt post-response drain for anything left over; the cron
    // remains the fallback. Tracked `after()`, never detached.
    try {
      scheduleSheetsDrainSoon({ accountId: ctx.accountId });
    } catch {
      // Best-effort only.
    }
    return NextResponse.json({ ok: true, job: serializeImportJob(progress) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
