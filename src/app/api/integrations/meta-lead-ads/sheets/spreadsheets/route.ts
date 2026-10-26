// POST /api/integrations/meta-lead-ads/sheets/spreadsheets
//
// Create one Google Spreadsheet in the caller's connected Google
// account for a single Workspace table (Meta Lead Ads Sheets only
// — never touches Flow Tables or other integrations).
//
// Body: { flow_id, title? }. The table scope (`flow_id` resolves
// via resolveTableForm: same account, Meta table, same-account
// form) names the default spreadsheet and isolates the call —
// nothing is written to any table configuration, queue, or other
// spreadsheet. Sync never starts here: the dialog still requires
// an explicit Save Configuration / Sync now afterwards.
//
// Title: caller-supplied or `Meta Leads - [table name]`
// (trimmed, capped at 100 characters). The new spreadsheet starts
// with a single `Sheet1` tab carrying the managed header.
// Tokens never leave the server.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  getSheetsAccessToken,
  SheetsAuthError,
} from '@/lib/meta-lead-sheets/oauth';
import {
  createSheetsSpreadsheet,
  isQuotaSheetsError,
  sheetsUserError,
} from '@/lib/meta-lead-sheets/sheets-client';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

const INITIAL_TAB = 'Sheet1';
const MAX_TITLE_LEN = 100;

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.trim();
  if (title === '') return null;
  return title.slice(0, MAX_TITLE_LEN);
}

export async function POST(request: Request) {
  try {
    // Owner-only: spreadsheet creation is restricted to the account owner.
    const ctx = await requireRole('owner');
    const body = (await request.json().catch(() => null)) as {
      flow_id?: unknown;
      title?: unknown;
    } | null;

    const flowId =
      typeof body?.flow_id === 'string' && body.flow_id.trim() !== ''
        ? body.flow_id.trim()
        : null;
    if (!flowId) {
      return NextResponse.json(
        { error: 'A Workspace table is required.' },
        { status: 400 }
      );
    }
    // Table scope: same account, Meta table, same-account form.
    // Only used to name the spreadsheet and isolate the call.
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

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
        // Throttled token endpoint: retryable, never a reconnect.
        const mapped = sheetsUserError(err, 'spreadsheet creation');
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

    const tableName =
      (table.formName ?? '').trim() || (table.flowName ?? '').trim();
    const title =
      cleanTitle(body?.title) ??
      (tableName ? `Meta Leads - ${tableName}`.slice(0, MAX_TITLE_LEN) : 'Meta Leads');

    let created;
    try {
      created = await createSheetsSpreadsheet(
        accessToken,
        title,
        INITIAL_TAB
      );
    } catch (err) {
      // Classify instead of swallowing: revoked credentials ask
      // for a reconnect, throttling asks for a wait + retry, and
      // permission problems name the fix.
      const mapped = sheetsUserError(err, 'spreadsheet creation');
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

    return NextResponse.json({
      ok: true,
      spreadsheet_id: created.spreadsheetId,
      url: created.url,
      title: created.title,
      tabs: created.tabs,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
