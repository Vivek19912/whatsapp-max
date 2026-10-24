// /api/integrations/meta-lead-ads/sheets/config
//
// GET — Meta Sheets sync status + config (members+). Tokens never returned.
// PUT — Admin+. Set the target spreadsheet/tab + auto_sync flag, validate
//   access server-side, ensure tab + header, and optionally backfill
//   existing processed leads. Meta-only: never touches Flow Tables.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  backfillAccountSheets,
  drainSheetsQueue,
  getSheetsSyncStatus,
} from "@/lib/meta-lead-sheets/queue";
import { META_SHEETS_DEFAULT_TAB } from "@/lib/meta-lead-sheets/constants";
import { getSheetsAccessToken, SheetsAuthError } from "@/lib/meta-lead-sheets/oauth";
import {
  ensureSheetsHeader,
  ensureSheetsTab,
  getSheetsSpreadsheet,
  parseSheetsSpreadsheetId,
} from "@/lib/meta-lead-sheets/sheets-client";
import { scheduleSheetsDrainSoon } from "@/lib/meta-lead-sheets/trigger";

function cleanTab(raw: unknown): string {
  const tab = typeof raw === "string" ? raw.trim() : "";
  return tab === "" ? META_SHEETS_DEFAULT_TAB : tab.slice(0, 100);
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const status = await getSheetsSyncStatus(ctx.supabase, ctx.accountId);
    return NextResponse.json(status);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as {
      spreadsheet_url?: unknown;
      spreadsheet_id?: unknown;
      sheet_tab?: unknown;
      auto_sync?: unknown;
      import_existing?: unknown;
    } | null;

    const rawInput =
      typeof body?.spreadsheet_id === "string" && body.spreadsheet_id.trim() !== ""
        ? body.spreadsheet_id
        : typeof body?.spreadsheet_url === "string"
          ? body.spreadsheet_url
          : "";
    const spreadsheetId = parseSheetsSpreadsheetId(rawInput);
    if (!spreadsheetId) {
      return NextResponse.json(
        { error: "Paste a valid Google Sheets URL or spreadsheet ID." },
        { status: 400 },
      );
    }
    const tab = cleanTab(body?.sheet_tab);
    if (tab.length === 0) {
      return NextResponse.json({ error: "Worksheet tab is required." }, { status: 400 });
    }
    const autoSync = body?.auto_sync === undefined ? true : body.auto_sync === true;
    const importExisting = body?.import_existing === true;

    // Validate credential + spreadsheet access BEFORE persisting.
    let accessToken: string;
    try {
      accessToken = await getSheetsAccessToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      if (err instanceof SheetsAuthError) {
        return NextResponse.json(
          { error: "Connect a Google account first, then select a spreadsheet." },
          { status: 409 },
        );
      }
      throw err;
    }
    let meta;
    try {
      meta = await getSheetsSpreadsheet(accessToken, spreadsheetId);
    } catch (err) {
      return NextResponse.json(
        {
          error:
            "Could not access that spreadsheet with the connected Google account. Share it with that account (Editor) or check the URL.",
        },
        { status: 502 },
      );
    }
    try {
      await ensureSheetsTab(accessToken, spreadsheetId, tab);
      await ensureSheetsHeader(accessToken, spreadsheetId, tab);
    } catch (err) {
      return NextResponse.json(
        { error: "Spreadsheet is reachable but the worksheet could not be prepared." },
        { status: 502 },
      );
    }

    const { error: upsertErr } = await ctx.supabase
      .from("meta_lead_sheets_configs")
      .upsert(
        {
          account_id: ctx.accountId,
          spreadsheet_id: spreadsheetId,
          spreadsheet_url: meta.url ?? null,
          spreadsheet_title: meta.title ?? null,
          sheet_tab: tab,
          auto_sync: autoSync,
          last_error: null,
          historical_import_status: importExisting ? "importing" : "idle",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (upsertErr) throw upsertErr;

    let backfill: { enqueued: number; alreadyQueued: number; total: number } | null = null;
    let drain: { sent: number; failed: number } | null = null;
    if (importExisting) {
      const admin = supabaseAdmin();
      try {
        backfill = await backfillAccountSheets(admin, ctx.accountId, 500);
        // Best-effort immediate drain so the first rows appear without
        // waiting for the cron; failures stay queued for retry.
        const drained = await drainSheetsQueue(admin, {
          onlyAccountId: ctx.accountId,
          force: true,
          limit: 20,
        });
        drain = { sent: drained.sent, failed: drained.failed };
        await admin
          .from("meta_lead_sheets_configs")
          .update({
            historical_import_status: "done",
            updated_at: new Date().toISOString(),
          })
          .eq("account_id", ctx.accountId);
      } catch (err) {
        await admin
          .from("meta_lead_sheets_configs")
          .update({
            historical_import_status: "error",
            last_error: err instanceof Error ? err.message.slice(0, 500) : String(err),
            updated_at: new Date().toISOString(),
          })
          .eq("account_id", ctx.accountId);
        throw err;
      }
    }

    const status = await getSheetsSyncStatus(ctx.supabase, ctx.accountId);
    // Prompt post-response drain for anything enqueued concurrently
    // (e.g. re-enabled auto_sync with pending rows). Tracked
    // `after()`; the import path above already drained inline, and
    // claim-CAS dedupes overlap. Cron remains the fallback.
    scheduleSheetsDrainSoon({ accountId: ctx.accountId });
    return NextResponse.json({ ok: true, status, backfill, drain });
  } catch (err) {
    return toErrorResponse(err);
  }
}
