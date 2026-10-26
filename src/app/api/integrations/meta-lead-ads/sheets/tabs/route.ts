// /api/integrations/meta-lead-ads/sheets/tabs
//
// Per-Workspace-table worksheet-tab management (Meta Lead Ads
// Sheets only — never touches Flow Tables). Every mutating call
// is scoped through the caller's own table (`flow_id` resolves via
// resolveTableForm: same account, Meta table, same-account form),
// uses the account's own Google connection, and only ever affects
// the pasted spreadsheet — never any other table's config.
//
// GET (members+) — ?spreadsheet_id=...&flow_id=... List the existing
//   worksheet tabs (leftmost first) so the dialog can default to the
//   first existing tab. The flow_id scope is mandatory: the table
//   must resolve to the caller's own account (tenant + table guard),
//   so arbitrary spreadsheets cannot be enumerated with guessed IDs.
//   Validates access server-side; tokens never leave the server.
// POST (owner-only) — { flow_id, spreadsheet_id|spreadsheet_url, tab }.
//   Create one worksheet tab inside the given spreadsheet, then
//   return the refreshed tab list. Rejects blank/invalid names
//   (400) and duplicates, case-insensitively (409). Never creates
//   anything except the single requested tab.
// DELETE (owner-only) — ?spreadsheet_id=...&tab=...&flow_id=... Delete
//   exactly the named worksheet tab (confirmed client-side first).
//   The tab must exist (404 otherwise); the spreadsheet and all
//   other tabs are untouched, and no table configuration is
//   modified. Returns the refreshed tab list.

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  getSheetsAccessToken,
  SheetsAuthError,
} from '@/lib/meta-lead-sheets/oauth';
import {
  createWorksheetTab,
  deleteWorksheetTab,
  getSheetsSpreadsheet,
  isQuotaSheetsError,
  parseSheetsSpreadsheetId,
  sheetsUserError,
  validateWorksheetTabName,
} from '@/lib/meta-lead-sheets/sheets-client';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    // Table scope is mandatory: without the caller's own table
    // (same account, Meta table, same-account form) the endpoint
    // would let anyone enumerate arbitrary spreadsheet tabs using
    // guessed spreadsheet IDs.
    const flowId = cleanFlowId(params.get('flow_id'));
    if (!flowId) {
      return NextResponse.json(
        { error: 'A Workspace table is required.' },
        { status: 400 }
      );
    }
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }
    const raw = params.get('spreadsheet_id') ?? '';
    const spreadsheetId = parseSheetsSpreadsheetId(raw);
    if (!spreadsheetId) {
      return NextResponse.json(
        { error: 'Paste a valid Google Sheets URL or spreadsheet ID.' },
        { status: 400 }
      );
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
        const mapped = sheetsUserError(err, 'loading worksheet tabs');
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
      const mapped = sheetsUserError(err, 'loading worksheet tabs');
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }
    return NextResponse.json({
      spreadsheet_id: meta.spreadsheetId,
      title: meta.title,
      url: meta.url,
      tabs: meta.tabs,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function readSpreadsheet(
  accessToken: string,
  rawInput: unknown,
): Promise<
  | { spreadsheetId: string; title: string; tabs: string[] }
  | { error: string; status: number }
> {
  const spreadsheetId =
    typeof rawInput === 'string' ? parseSheetsSpreadsheetId(rawInput) : null;
  if (!spreadsheetId) {
    return {
      error: 'Paste a valid Google Sheets URL or spreadsheet ID.',
      status: 400,
    };
  }
  try {
    const meta = await getSheetsSpreadsheet(accessToken, spreadsheetId);
    return { spreadsheetId, title: meta.title, tabs: meta.tabs };
  } catch {
    return {
      error:
        'Could not access that spreadsheet with the connected Google account. Share it with that account (Editor) or check the URL.',
      status: 502,
    };
  }
}

function cleanFlowId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id === '' ? null : id;
}

export async function POST(request: Request) {
  try {
    // Owner-only: worksheet-tab mutations are restricted to the
    // account owner (hiding the dialog buttons alone is not enough).
    const ctx = await requireRole('owner');
    const body = (await request.json().catch(() => null)) as {
      flow_id?: unknown;
      spreadsheet_id?: unknown;
      spreadsheet_url?: unknown;
      tab?: unknown;
    } | null;

    const flowId = cleanFlowId(body?.flow_id);
    if (!flowId) {
      return NextResponse.json(
        { error: 'A Workspace table is required.' },
        { status: 400 }
      );
    }
    // Table scope first: same account, Meta table, same-account
    // form — other tables (and other accounts) can never be
    // affected by this call.
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    const name = validateWorksheetTabName(body?.tab);
    if ('error' in name) {
      return NextResponse.json({ error: name.error }, { status: 400 });
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
      throw err;
    }

    const rawInput =
      typeof body?.spreadsheet_id === 'string' &&
      body.spreadsheet_id.trim() !== ''
        ? body.spreadsheet_id
        : typeof body?.spreadsheet_url === 'string'
          ? body.spreadsheet_url
          : '';
    const sheet = await readSpreadsheet(accessToken, rawInput);
    if ('error' in sheet) {
      return NextResponse.json({ error: sheet.error }, { status: sheet.status });
    }

    // Google treats tab titles case-insensitively: creating "Leads"
    // when "leads" exists fails server-side, so reject up front
    // with a clear message instead.
    if (sheet.tabs.some((t) => t.toLowerCase() === name.tab.toLowerCase())) {
      return NextResponse.json(
        {
          error: `A worksheet tab named "${name.tab}" already exists.`,
          tabs: sheet.tabs,
        },
        { status: 409 }
      );
    }

    try {
      await createWorksheetTab(accessToken, sheet.spreadsheetId, name.tab);
    } catch (err) {
      if (isQuotaSheetsError(err)) {
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
      // Re-read: a concurrent creation (or a case-variant race)
      // surfaces as a duplicate instead of a generic failure.
      const again = await readSpreadsheet(accessToken, rawInput);
      const liveTabs = 'error' in again ? sheet.tabs : again.tabs;
      if (liveTabs.some((t) => t.toLowerCase() === name.tab.toLowerCase())) {
        return NextResponse.json(
          {
            error: `A worksheet tab named "${name.tab}" already exists.`,
            tabs: liveTabs,
          },
          { status: 409 }
        );
      }
      const mapped = sheetsUserError(err, 'worksheet tab creation');
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }

    const refreshed = await readSpreadsheet(accessToken, rawInput);
    const tabs = 'error' in refreshed ? [...sheet.tabs, name.tab] : refreshed.tabs;
    return NextResponse.json({ ok: true, tab: name.tab, tabs });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    // Owner-only: see POST above.
    const ctx = await requireRole('owner');
    const params = new URL(request.url).searchParams;
    const flowId = cleanFlowId(params.get('flow_id'));
    if (!flowId) {
      return NextResponse.json(
        { error: 'A Workspace table is required.' },
        { status: 400 }
      );
    }
    // Same table scoping as creation: this call can only ever
    // affect the pasted spreadsheet, never another table.
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    // An explicit tab is mandatory: without one there is nothing
    // to delete, and the spreadsheet itself is never a target.
    const tabParam = params.get('tab') ?? '';
    const tab = tabParam.trim();
    if (tab === '') {
      return NextResponse.json(
        { error: 'Select a worksheet tab to delete.' },
        { status: 400 }
      );
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
        const mapped = sheetsUserError(err, 'worksheet tab deletion');
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

    const sheet = await readSpreadsheet(
      accessToken,
      params.get('spreadsheet_id') ?? ''
    );
    if ('error' in sheet) {
      return NextResponse.json({ error: sheet.error }, { status: sheet.status });
    }

    if (!sheet.tabs.includes(tab)) {
      return NextResponse.json(
        {
          error: `Worksheet "${tab}" was not found — nothing was deleted.`,
          tabs: sheet.tabs,
        },
        { status: 404 }
      );
    }

    try {
      await deleteWorksheetTab(accessToken, sheet.spreadsheetId, tab);
    } catch (err) {
      const mapped = sheetsUserError(err, 'worksheet tab deletion');
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

    const refreshed = await readSpreadsheet(accessToken, sheet.spreadsheetId);
    const tabs = 'error' in refreshed
      ? sheet.tabs.filter((t) => t !== tab)
      : refreshed.tabs;
    return NextResponse.json({ ok: true, deleted: tab, tabs });
  } catch (err) {
    return toErrorResponse(err);
  }
}
