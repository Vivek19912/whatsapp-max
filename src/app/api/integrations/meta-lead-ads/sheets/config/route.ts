// /api/integrations/meta-lead-ads/sheets/config
//
// GET — Meta Sheets sync status + config (members+). Tokens never returned.
// PUT — Admin+. Set the target spreadsheet/tab, auto_sync flag, the
//   selected Meta forms, and the visible columns; validate access +
//   selection server-side, ensure tab + header, reconcile newly
//   selected forms, roll layout changes out to managed rows, and
//   optionally backfill existing processed leads. Meta-only: never
//   touches Flow Tables.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { parseFormQuestions, questionVarKeys } from "@/lib/meta-lead-ads/virtual-flow";
import {
  backfillAccountSheets,
  drainSheetsQueue,
  enqueueFormsDelta,
  getSheetsSyncStatus,
  applyIdColumnVisibility,
  remapLayoutChunk,
} from "@/lib/meta-lead-sheets/queue";
import { META_SHEETS_DEFAULT_TAB } from "@/lib/meta-lead-sheets/constants";
import {
  STANDARD_SHEETS_FIELDS,
  answerFieldKey,
  computeManagedLayout,
  resolveEffectiveColumns,
  validateColumnConfig,
  type SheetsColumnDef,
} from "@/lib/meta-lead-sheets/columns";
import { getSheetsAccessToken, SheetsAuthError } from "@/lib/meta-lead-sheets/oauth";
import {
  ensureSheetsHeader,
  ensureSheetsTab,
  getSheetsSpreadsheet,
  parseSheetsSpreadsheetId,
} from "@/lib/meta-lead-sheets/sheets-client";
import { scheduleSheetsDrainSoon } from "@/lib/meta-lead-sheets/trigger";

export const maxDuration = 60;

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
      form_ids?: unknown;
      columns?: unknown;
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

    const admin = supabaseAdmin();

    // Account forms (tenant-scoped) + previous config for validation
    // and change detection.
    const [{ data: accountForms }, { data: oldConfigRow }] = await Promise.all([
      admin
        .from("meta_lead_forms")
        .select("form_id, form_name, questions")
        .eq("account_id", ctx.accountId),
      admin
        .from("meta_lead_sheets_configs")
        .select("spreadsheet_id, sheet_tab, form_ids, column_config")
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
    ]);
    const forms = ((accountForms ?? []) as Array<{
      form_id: string;
      form_name: string | null;
      questions: unknown;
    }>);
    const accountFormIds = new Set(forms.map((f) => f.form_id));
    const oldConfig = oldConfigRow as {
      spreadsheet_id: string;
      sheet_tab: string;
      form_ids?: string[] | null;
      column_config?: unknown;
    } | null;
    const oldFormIds = oldConfig && Array.isArray(oldConfig.form_ids) ? oldConfig.form_ids : null;

    // ---- Form selection (absent = keep existing) ----
    let newFormIds: string[] | undefined;
    if (body?.form_ids !== undefined) {
      if (
        !Array.isArray(body.form_ids) ||
        !(body.form_ids as unknown[]).every((v) => typeof v === "string")
      ) {
        return NextResponse.json({ error: "form_ids must be a list of form IDs." }, { status: 400 });
      }
      const unique = [...new Set((body.form_ids as string[]).map((v) => v.trim()).filter(Boolean))];
      for (const id of unique) {
        if (!accountFormIds.has(id)) {
          return NextResponse.json(
            { error: "Unknown form selected. Choose only forms from this account." },
            { status: 400 },
          );
        }
      }
      newFormIds = unique;
    }
    if (importExisting && newFormIds !== undefined && newFormIds.length === 0) {
      return NextResponse.json(
        { error: "Select at least one form before importing existing leads." },
        { status: 400 },
      );
    }
    const effectiveFormIds = newFormIds !== undefined ? newFormIds : oldFormIds;

    // ---- Allowed column keys: standard + dynamic union of the forms
    // the columns will sync (selected forms, or every account form
    // when nothing is selected yet). ----
    const formsForKeys =
      effectiveFormIds === null ? forms : forms.filter((f) => effectiveFormIds.includes(f.form_id));
    const allowedKeys = new Set<string>(STANDARD_SHEETS_FIELDS.map((f) => f.key));
    for (const f of formsForKeys) {
      const questions = parseFormQuestions(f.questions);
      for (const key of questionVarKeys(questions)) {
        allowedKeys.add(answerFieldKey(key));
      }
    }

    // ---- Column selection (absent = keep existing) ----
    let newColumns: SheetsColumnDef[] | undefined;
    if (body?.columns !== undefined) {
      const validated = validateColumnConfig(body.columns, allowedKeys);
      if ("error" in validated) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      newColumns = validated.columns;
    }
    const oldColumns = resolveEffectiveColumns(oldConfig?.column_config);
    const finalColumns = newColumns ?? oldColumns;
    // Kept columns must still exist under a changed form selection.
    if (newColumns === undefined && newFormIds !== undefined) {
      const unavailable = oldColumns.filter((c) => !allowedKeys.has(c.key));
      if (unavailable.length > 0) {
        return NextResponse.json(
          {
            error:
              `Columns ${unavailable.map((c) => `"${c.label}"`).join(", ")} belong to deselected forms. ` +
              "Remove them or re-select the forms.",
          },
          { status: 400 },
        );
      }
    }

    const targetChanged =
      !oldConfig || oldConfig.spreadsheet_id !== spreadsheetId || oldConfig.sheet_tab !== tab;
    const oldLayout = computeManagedLayout(oldColumns);
    const newLayout = computeManagedLayout(finalColumns);
    const headerChanged =
      !oldConfig ||
      oldLayout.headers.length !== newLayout.headers.length ||
      oldLayout.headers.some((h, i) => newLayout.headers[i] !== h);
    const needsRemap = !targetChanged && !!oldConfig && headerChanged;

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
          ...(newFormIds !== undefined ? { form_ids: newFormIds } : {}),
          ...(newColumns !== undefined ? { column_config: newColumns } : {}),
          ...(needsRemap ? { pending_remap: true, remap_cursor: 0 } : {}),
          last_error: null,
          historical_import_status: importExisting ? "importing" : "idle",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (upsertErr) throw upsertErr;

    let remapSummary: { done: boolean; remapped: number; skipped: number } | null = null;
    let targetReseeded = 0;
    try {
      await ensureSheetsTab(accessToken, spreadsheetId, tab);
      if (targetChanged || !oldConfig) {
        // New target (or first setup): the new sheet starts empty of
        // managed rows. Previously synced rows belong to the old sheet
        // (left untouched) and must not leak row numbers into the new
        // one — drop this account's queue and reseed selected forms
        // (stable IDs prevent duplicates on write).
        if (targetChanged && oldConfig) {
          await admin
            .from("meta_lead_sheets_queue")
            .delete()
            .eq("account_id", ctx.accountId);
          const reseedForms =
            newFormIds !== undefined ? newFormIds : (oldFormIds ?? forms.map((f) => f.form_id));
          if (reseedForms.length > 0) {
            const reseeded = await enqueueFormsDelta(admin, ctx.accountId, reseedForms, 2000);
            targetReseeded = reseeded.enqueued;
          }
        }
        await ensureSheetsHeader(accessToken, spreadsheetId, tab, newLayout.headers);
        await applyIdColumnVisibility(
          accessToken,
          spreadsheetId,
          tab,
          newLayout.idVisible,
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
            .from("meta_lead_sheets_configs")
            .select("remap_cursor")
            .eq("account_id", ctx.accountId)
            .maybeSingle();
          const chunk = await remapLayoutChunk(
            admin,
            accessToken,
            {
              account_id: ctx.accountId,
              spreadsheet_id: spreadsheetId,
              sheet_tab: tab,
              column_config: finalColumns,
            },
            (cur as { remap_cursor: number | null } | null)?.remap_cursor ?? 0,
          );
          remappedTotal += chunk.remapped;
          skippedTotal += chunk.skipped;
          done = chunk.done;
        }
        remapSummary = { done, remapped: remappedTotal, skipped: skippedTotal };
      } else {
        await ensureSheetsHeader(accessToken, spreadsheetId, tab, newLayout.headers);
      }
    } catch (err) {
      return NextResponse.json(
        {
          error:
            "Spreadsheet is reachable but the worksheet could not be prepared. Saved settings resume automatically.",
        },
        { status: 502 },
      );
    }

    // Reconcile newly selected forms (idempotent; duplicates collapse).
    // Skipped after a target switch: the reseed above already queued
    // everything selected.
    let delta: { enqueued: number; alreadyQueued: number; total: number } | null = null;
    const addedForms =
      newFormIds !== undefined && !(targetChanged && oldConfig)
        ? oldFormIds === null
          ? newFormIds
          : newFormIds.filter((id) => !oldFormIds.includes(id))
        : [];
    if (addedForms.length > 0) {
      delta = await enqueueFormsDelta(admin, ctx.accountId, addedForms);
    }

    let backfill: { enqueued: number; alreadyQueued: number; total: number } | null = null;
    let drain: { sent: number; failed: number } | null = null;
    if (importExisting) {
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
    return NextResponse.json({
      ok: true,
      status,
      backfill,
      drain,
      delta,
      ...(targetReseeded > 0 ? { reseeded: targetReseeded } : {}),
      ...(remapSummary ? { remap: remapSummary } : {}),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
