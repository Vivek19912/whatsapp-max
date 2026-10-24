// GET /api/integrations/meta-lead-ads/sheets/tabs?spreadsheet_id=...
//
// Members+. List the existing worksheet tabs of a spreadsheet the
// caller pastes (leftmost tab first), so the Workspace dialog can
// default to the first existing tab. Validates access server-side
// with the account's own Google connection; tokens never leave the
// server. Meta Lead Ads Sheets only — never touches Flow Tables.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  getSheetsAccessToken,
  SheetsAuthError,
} from '@/lib/meta-lead-sheets/oauth';
import {
  getSheetsSpreadsheet,
  parseSheetsSpreadsheetId,
} from '@/lib/meta-lead-sheets/sheets-client';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const raw = new URL(request.url).searchParams.get('spreadsheet_id') ?? '';
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
      throw err;
    }
    const meta = await getSheetsSpreadsheet(accessToken, spreadsheetId);
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
