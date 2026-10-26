// /api/integrations/meta-lead-ads/sheets/tables/[flowId]/config
//
// Per-Workspace-table Google Sheets configuration (Meta Lead Ads
// only). The table is resolved server-side to its Meta form; every
// read and write is scoped to (account, form), so one table's
// settings can never leak into or overwrite another table's.
//
// GET (members+) — table + form identity, this table's config (or
//   null), available standard/dynamic columns, connection status,
//   and sync status. Tokens are never returned.
// PUT (owner-only) — set this table's spreadsheet/tab/columns/auto_sync,
//   validate access + the target tab server-side, reconcile this
//   table's history, roll layout changes out to this table's managed
//   rows, and optionally backfill. Never touches other tables.

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  parseFormQuestions,
  questionVarKeys,
} from '@/lib/meta-lead-ads/virtual-flow';
import {
  applyIdColumnVisibility,
  backfillFormSheets,
  drainSheetsQueue,
  enqueueFormsDelta,
  getTableSheetsStatus,
  invalidateTableRowMappings,
  remapLayoutChunk,
} from '@/lib/meta-lead-sheets/queue';
import {
  answerFieldKey,
  buildDynamicFieldOptions,
  computeManagedLayout,
  resolveEffectiveColumns,
  STANDARD_SHEETS_FIELDS,
  validateColumnConfig,
  type SheetsColumnDef,
} from '@/lib/meta-lead-sheets/columns';
import {
  getSheetsAccessToken,
  SheetsAuthError,
} from '@/lib/meta-lead-sheets/oauth';
import {
  createWorksheetTab,
  ensureSheetsHeader,
  getSheetsSpreadsheet,
  isQuotaSheetsError,
  parseSheetsSpreadsheetId,
  sheetsUserError,
} from '@/lib/meta-lead-sheets/sheets-client';
import {
  resolveTableForm,
  chooseWorksheetTab,
} from '@/lib/meta-lead-sheets/tables';
import { scheduleSheetsDrainSoon } from '@/lib/meta-lead-sheets/trigger';

export const maxDuration = 60;

function cleanTab(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tab = raw.trim().slice(0, 100);
  return tab === '' ? null : tab;
}

type Ctx = { params: Promise<{ flowId: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    const ctx = await getCurrentAccount();
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    const { data: formRow } = await ctx.supabase
      .from('meta_lead_forms')
      .select('questions')
      .eq('id', table.formDbId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const questions = parseFormQuestions(
      (formRow as { questions?: unknown } | null)?.questions
    );
    const keys = questionVarKeys(questions);

    const status = await getTableSheetsStatus(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );
    // Whether the table has an explicitly saved column selection.
    // Legacy rows predate column selection (column_config NULL and
    // resolve to the ID-first default for sync); they count as
    // "no selection" so the dialog applies its ID-last default
    // instead of freezing the ID first. Explicit selections —
    // including ID-first ones the user chose — are preserved.
    const { data: rawConfig } = await ctx.supabase
      .from('meta_lead_sheets_configs')
      .select('column_config')
      .eq('account_id', ctx.accountId)
      .eq('form_id', table.formId)
      .maybeSingle();
    const rawColumns = (rawConfig as { column_config?: unknown } | null)
      ?.column_config;
    const hasCustomColumns =
      Array.isArray(rawColumns) && rawColumns.length > 0;
    return NextResponse.json({
      flow: { id: table.flowId, name: table.flowName },
      form: {
        id: table.formDbId,
        form_id: table.formId,
        form_name: table.formName,
        enabled: table.formEnabled,
        question_count: questions.length,
        questions: questions.map((q, index) => ({
          key: keys[index] ?? `question_${index}`,
          label:
            (q.label ?? '').trim() ||
            (q.key ?? '').trim() ||
            `Question ${index + 1}`,
        })),
      },
      connection: {
        connected: status.connected,
        email: status.email,
        needsReauth: status.needsReauth,
      },
      configured: !!status.spreadsheetId,
      standard: STANDARD_SHEETS_FIELDS.map((f) => ({ ...f })),
      dynamic: buildDynamicFieldOptions([
        {
          form_name: table.formName,
          questions: questions.map((q) => ({ ...q })),
        },
      ]),
      // The saved column selection, or null when this table was
      // never configured. The dialog applies its all-headers
      // (ID-last) default unless `hasCustomColumns` is true — an
      // explicit selection is always loaded verbatim so
      // customizations are preserved.
      selectedColumns: status.columns ?? null,
      hasCustomColumns,
      status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    // Owner-only: configuring a table's spreadsheet, tab, columns,
    // and sync behavior is restricted to the account owner.
    const ctx = await requireRole('owner');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }
    const admin = supabaseAdmin();

    const body = (await request.json().catch(() => null)) as {
      spreadsheet_url?: unknown;
      spreadsheet_id?: unknown;
      sheet_tab?: unknown;
      create_tab?: unknown;
      auto_sync?: unknown;
      import_existing?: unknown;
      columns?: unknown;
      expected_updated_at?: unknown;
    } | null;

    const rawInput =
      typeof body?.spreadsheet_id === 'string' &&
      body.spreadsheet_id.trim() !== ''
        ? body.spreadsheet_id
        : typeof body?.spreadsheet_url === 'string'
          ? body.spreadsheet_url
          : '';
    const spreadsheetId = parseSheetsSpreadsheetId(rawInput);
    if (!spreadsheetId) {
      return NextResponse.json(
        { error: 'Paste a valid Google Sheets URL or spreadsheet ID.' },
        { status: 400 }
      );
    }
    const autoSync =
      body?.auto_sync === undefined ? true : body.auto_sync === true;
    const createTab = body?.create_tab === true;

    // Validate credential + spreadsheet access BEFORE persisting.
    let accessToken: string;
    try {
      accessToken = await getSheetsAccessToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        return NextResponse.json(
          { error: 'Connect a Google account first (Settings → Meta).' },
          { status: 409 }
        );
      }
      if (isQuotaSheetsError(err)) {
        const mapped = sheetsUserError(err, 'spreadsheet validation');
        return NextResponse.json(
          { error: mapped.error },
          {
            status: mapped.status,
            ...(mapped.retryAfterMs !== null
              ? {
                  headers: {
                    'retry-after': String(
                      Math.max(1, Math.round(mapped.retryAfterMs / 1000))
                    ),
                  },
                }
              : {}),
          }
        );
      }
      throw err;
    }
    let meta;
    try {
      meta = await getSheetsSpreadsheet(accessToken, spreadsheetId);
    } catch (err) {
      // Classify instead of a single generic message: revoked
      // credentials ask for a reconnect, throttling asks for a
      // wait + retry, and permission problems name the fix.
      const mapped = sheetsUserError(err, 'spreadsheet validation');
      return NextResponse.json(
        { error: mapped.error },
        {
          status: mapped.status,
          ...(mapped.retryAfterMs !== null
            ? {
                headers: {
                  'retry-after': String(
                    Math.max(1, Math.round(mapped.retryAfterMs / 1000))
                  ),
                },
              }
            : {}),
        }
      );
    }

    // Target worksheet: explicit choice wins, then the saved tab, then
    // the spreadsheet's first (leftmost) existing tab. Never silently
    // write elsewhere: a missing tab errors (with the available tabs)
    // unless creation was explicitly requested.
    const { data: oldConfig } = await admin
      .from('meta_lead_sheets_configs')
      .select(
        'spreadsheet_id, sheet_tab, column_config, auto_sync, pending_remap, remap_cursor, updated_at'
      )
      .eq('account_id', ctx.accountId)
      .eq('form_id', table.formId)
      .maybeSingle();
    const old = oldConfig as {
      spreadsheet_id: string;
      sheet_tab: string;
      column_config?: unknown;
      auto_sync?: boolean;
      pending_remap?: boolean | null;
      remap_cursor?: number | null;
      updated_at?: string | null;
    } | null;

    // Optimistic concurrency: when the dialog sends the
    // `updated_at` it rendered from, a mismatch means another
    // save landed first — fail loudly instead of silently
    // last-write-wins overwriting the other save's target or
    // columns. Absent when the dialog predates the guard.
    const expectedUpdatedAt =
      typeof body?.expected_updated_at === 'string' &&
      body.expected_updated_at.trim() !== ''
        ? body.expected_updated_at.trim()
        : null;
    if (expectedUpdatedAt && old?.updated_at && old.updated_at !== expectedUpdatedAt) {
      return NextResponse.json(
        {
          error:
            'This table’s sheet settings changed in another tab. Reload and save again.',
        },
        { status: 409 }
      );
    }

    const requestedTab = cleanTab(body?.sheet_tab);
    const choice = chooseWorksheetTab({
      requestedTab,
      savedTab: old?.sheet_tab ?? null,
      availableTabs: meta.tabs,
      createTab,
    });
    if (!choice.ok) {
      return NextResponse.json(
        { error: choice.error, availableTabs: choice.availableTabs },
        { status: 400 }
      );
    }
    const tab = choice.tab;
    if (choice.needsCreate) {
      try {
        await createWorksheetTab(accessToken, spreadsheetId, tab);
      } catch (err) {
        const mapped = sheetsUserError(err, 'worksheet tab creation');
        return NextResponse.json(
          { error: mapped.error },
          {
            status: mapped.status,
            ...(mapped.retryAfterMs !== null
              ? {
                  headers: {
                    'retry-after': String(
                      Math.max(1, Math.round(mapped.retryAfterMs / 1000))
                    ),
                  },
                }
              : {}),
          }
        );
      }
    }

    // ---- Allowed column keys: standard + THIS form's dynamic union. ----
    const { data: formRow } = await admin
      .from('meta_lead_forms')
      .select('questions')
      .eq('id', table.formDbId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const questions = parseFormQuestions(
      (formRow as { questions?: unknown } | null)?.questions
    );
    const allowedKeys = new Set<string>(
      STANDARD_SHEETS_FIELDS.map((f) => f.key)
    );
    for (const key of questionVarKeys(questions)) {
      allowedKeys.add(answerFieldKey(key));
    }

    let newColumns: SheetsColumnDef[] | undefined;
    if (body?.columns !== undefined) {
      const validated = validateColumnConfig(body.columns, allowedKeys);
      if ('error' in validated) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      newColumns = validated.columns;
    }
    const oldColumns = resolveEffectiveColumns(old?.column_config);
    const finalColumns = newColumns ?? oldColumns;

    const targetChanged =
      !old || old.spreadsheet_id !== spreadsheetId || old.sheet_tab !== tab;
    const oldLayout = computeManagedLayout(oldColumns);
    const newLayout = computeManagedLayout(finalColumns);
    const headerChanged =
      !old ||
      oldLayout.headers.length !== newLayout.headers.length ||
      oldLayout.headers.some((h, i) => newLayout.headers[i] !== h);
    const needsRemap = !targetChanged && !!old && headerChanged;

    // Existing leads import automatically exactly once: on the
    // first-ever configuration of this table (!old). The backfill
    // is idempotent (unique queue key + match-by-ID updates), so a
    // retry can never duplicate rows — and subsequent saves never
    // trigger another full import. (A legacy `import_existing`
    // body flag, if sent, is intentionally ignored.)
    const importExisting = !old;

    const { error: upsertErr } = await admin
      .from('meta_lead_sheets_configs')
      .upsert(
        {
          account_id: ctx.accountId,
          form_id: table.formId,
          spreadsheet_id: spreadsheetId,
          spreadsheet_url: meta.url ?? null,
          spreadsheet_title: meta.title ?? null,
          sheet_tab: tab,
          auto_sync: autoSync,
          ...(newColumns !== undefined ? { column_config: newColumns } : {}),
          ...(needsRemap ? { pending_remap: true, remap_cursor: 0 } : {}),
          last_error: null,
          historical_import_status: importExisting ? 'importing' : 'idle',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,form_id' }
      );
    if (upsertErr) throw upsertErr;

    let remapSummary: {
      done: boolean;
      remapped: number;
      skipped: number;
    } | null = null;
    let reseeded = 0;
    let invalidated = 0;
    try {
      if (targetChanged || !old) {
        // New target (or first setup): the new sheet starts empty of
        // managed rows. Previously synced rows belong to the old sheet
        // (left untouched — never cleared). Stale row numbers from the
        // old sheet are INVALIDATED (not deleted): the drain
        // reconciles by stable Meta Lead ID against the new sheet
        // (update in place when found, append when genuinely
        // missing), so old positions can never become wrong PUT
        // targets. Invalidation is scoped to this table's queue rows
        // (account + form) — other tables' mappings, lead identity,
        // and successful history are preserved. Both steps page
        // through the full history (no 2,000/5,000 caps) and are
        // idempotent, so an interrupted target change resumes safely
        // by re-saving.
        if (targetChanged && old) {
          ({ invalidated } = await invalidateTableRowMappings(
            admin,
            ctx.accountId,
            table.formId
          ));
        }
        const delta = await enqueueFormsDelta(admin, ctx.accountId, [table.formId]);
        reseeded = delta.enqueued;
        await ensureSheetsHeader(
          accessToken,
          spreadsheetId,
          tab,
          newLayout.headers
        );
        await applyIdColumnVisibility(
          accessToken,
          spreadsheetId,
          tab,
          newLayout.idVisible,
          fetch,
          newLayout.idColumnIndex
        );
      } else if (needsRemap) {
        // Roll the layout out to managed rows first (header last, in
        // the final chunk), bounded inline; the drain resumes the rest.
        let done = false;
        let guard = 0;
        let remappedTotal = 0;
        let skippedTotal = 0;
        while (!done && guard < 20) {
          guard += 1;
          const { data: cur } = await admin
            .from('meta_lead_sheets_configs')
            .select('remap_cursor')
            .eq('account_id', ctx.accountId)
            .eq('form_id', table.formId)
            .maybeSingle();
          const chunk = await remapLayoutChunk(
            admin,
            accessToken,
            {
              account_id: ctx.accountId,
              form_id: table.formId,
              spreadsheet_id: spreadsheetId,
              sheet_tab: tab,
              column_config: finalColumns,
            },
            (cur as { remap_cursor: number | null } | null)?.remap_cursor ?? 0
          );
          remappedTotal += chunk.remapped;
          skippedTotal += chunk.skipped;
          done = chunk.done;
        }
        remapSummary = { done, remapped: remappedTotal, skipped: skippedTotal };
      } else {
        await ensureSheetsHeader(
          accessToken,
          spreadsheetId,
          tab,
          newLayout.headers
        );
      }
    } catch (err) {
      const mapped = sheetsUserError(err, 'worksheet preparation');
      return NextResponse.json(
        { error: mapped.error },
        {
          status: mapped.status,
          ...(mapped.retryAfterMs !== null
            ? {
                headers: {
                  'retry-after': String(
                    Math.max(1, Math.round(mapped.retryAfterMs / 1000))
                  ),
                },
              }
            : {}),
        }
      );
    }

    let backfill: {
      enqueued: number;
      alreadyQueued: number;
      total: number;
    } | null = null;
    let drain: { sent: number; failed: number } | null = null;
    if (importExisting) {
      try {
        backfill = await backfillFormSheets(
          admin,
          ctx.accountId,
          table.formId,
          500
        );
        // Best-effort immediate drain so the first rows appear without
        // waiting for the cron; failures stay queued for retry.
        const drained = await drainSheetsQueue(admin, {
          onlyAccountId: ctx.accountId,
          onlyFormId: table.formId,
          force: true,
          limit: 20,
        });
        drain = { sent: drained.sent, failed: drained.failed };
        await admin
          .from('meta_lead_sheets_configs')
          .update({
            historical_import_status: 'done',
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', ctx.accountId)
          .eq('form_id', table.formId);
      } catch (err) {
        await admin
          .from('meta_lead_sheets_configs')
          .update({
            historical_import_status: 'error',
            last_error:
              err instanceof Error ? err.message.slice(0, 500) : String(err),
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', ctx.accountId)
          .eq('form_id', table.formId);
        throw err;
      }
    }

    const status = await getTableSheetsStatus(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );
    // Prompt post-response drain for anything enqueued concurrently.
    // Tracked `after()`; the import path above already drained inline,
    // and claim-CAS dedupes overlap. Cron remains the fallback.
    scheduleSheetsDrainSoon({ accountId: ctx.accountId });
    return NextResponse.json({
      ok: true,
      status,
      backfill,
      drain,
      ...(reseeded > 0 ? { reseeded } : {}),
      ...(invalidated > 0 ? { invalidated } : {}),
      ...(remapSummary ? { remap: remapSummary } : {}),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
