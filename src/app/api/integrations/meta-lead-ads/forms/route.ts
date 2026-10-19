// /api/integrations/meta-lead-ads/forms
//
// GET   — the Instant Forms loaded for this account (stored).
// POST  — "Load My Forms": list the Page's forms from Meta and upsert.
// PATCH — enable or disable a form. Enabling refreshes its questions,
//         materializes the virtual Workspace flow, and starts a
//         bounded historical import of leads Meta already holds.
//
// Historical imports are continued by the cron until the cursor is
// exhausted; see `sync.ts`.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole } from "@/lib/auth/account";
import { resolveAuditUserId } from "@/lib/api/v1/contacts";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { getForm, listForms } from "@/lib/meta-lead-ads/graph-client";
import type { MetaFormQuestion } from "@/lib/meta-lead-ads/graph-client";
import { getPageToken } from "@/lib/meta-lead-ads/store";
import {
  getFormForImport,
  importFormLeads,
  type ImportResult,
} from "@/lib/meta-lead-ads/sync";
import { ensureVirtualFlow } from "@/lib/meta-lead-ads/virtual-flow";

interface FormRow {
  id: string;
  page_id: string;
  form_id: string;
  form_name: string | null;
  status: string | null;
  locale: string | null;
  questions: unknown;
  enabled: boolean;
  import_status: string;
  import_cursor: string | null;
  imported_count: number;
  last_synced_at: string | null;
  last_polled_at: string | null;
  last_lead_at: string | null;
  last_error: string | null;
}

const FORM_COLUMNS =
  "id, page_id, form_id, form_name, status, locale, questions, enabled, import_status, import_cursor, imported_count, last_synced_at, last_polled_at, last_lead_at, last_error";

function questionList(raw: MetaFormQuestion[] | undefined): Array<{
  key: string | null;
  label: string | null;
  type: string | null;
}> {
  return (raw ?? []).map((q) => ({
    key: q.key ?? null,
    label: q.label ?? null,
    type: q.type ?? null,
  }));
}

function serializeForms(rows: FormRow[]) {
  return rows.map((f) => ({
    id: f.id,
    pageId: f.page_id,
    formId: f.form_id,
    formName: f.form_name,
    status: f.status,
    locale: f.locale,
    enabled: f.enabled,
    questionCount: Array.isArray(f.questions) ? f.questions.length : 0,
    importStatus: f.import_status,
    importedCount: f.imported_count,
    lastSyncedAt: f.last_synced_at,
    lastPolledAt: f.last_polled_at,
    lastLeadAt: f.last_lead_at,
    lastError: f.last_error,
  }));
}

function importErrorMessage(err: unknown): string {
  return err instanceof MetaLeadAdsError
    ? err.message
    : "The historical import could not reach Meta.";
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const pageId = new URL(request.url).searchParams.get("page_id");

    let query = ctx.supabase
      .from("meta_lead_forms")
      .select(FORM_COLUMNS)
      .eq("account_id", ctx.accountId)
      .order("form_name", { ascending: true });
    if (pageId) query = query.eq("page_id", pageId);

    const { data } = await query;
    return NextResponse.json({
      configured: metaLeadAdsConfig() !== null,
      forms: serializeForms((data ?? []) as FormRow[]),
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { page_id?: string }
      | null;
    const pageId = body?.page_id?.trim();
    if (!pageId || !/^\d{5,32}$/.test(pageId)) {
      return NextResponse.json(
        { error: "Enter the numeric Facebook Page ID." },
        { status: 400 },
      );
    }

    // `getPageToken` refuses a Page this account has not connected, so
    // Load My Forms can never pull another tenant's Page/forms.
    const pageToken = await getPageToken(ctx.supabase, ctx.accountId, pageId);
    const metaForms = await listForms(config, pageToken, pageId);
    const now = new Date().toISOString();
    const admin = supabaseAdmin();

    for (const mf of metaForms) {
      const { data: existing } = await admin
        .from("meta_lead_forms")
        .select("id, enabled")
        .eq("account_id", ctx.accountId)
        .eq("form_id", mf.id)
        .maybeSingle();
      const row = existing as { id: string; enabled: boolean } | null;
      if (row) {
        const { error: updateErr } = await admin
          .from("meta_lead_forms")
          .update({
            page_id: pageId,
            form_name: mf.name ?? null,
            status: mf.status ?? null,
            locale: mf.locale ?? null,
            last_synced_at: now,
            last_error: null,
          })
          .eq("id", row.id);
        if (updateErr) throw updateErr;
      } else {
        const { error: insertErr } = await admin.from("meta_lead_forms").insert({
          account_id: ctx.accountId,
          page_id: pageId,
          form_id: mf.id,
          form_name: mf.name ?? null,
          status: mf.status ?? null,
          locale: mf.locale ?? null,
          questions: [],
          enabled: false,
          last_synced_at: now,
        });
        // Concurrent sync — another request already inserted this form.
        if (insertErr && !isUniqueViolation(insertErr)) throw insertErr;
      }
    }

    await admin
      .from("meta_lead_pages")
      .update({ last_synced_at: now, updated_at: now })
      .eq("account_id", ctx.accountId)
      .eq("page_id", pageId);

    const { data: refreshed } = await ctx.supabase
      .from("meta_lead_forms")
      .select(FORM_COLUMNS)
      .eq("account_id", ctx.accountId)
      .eq("page_id", pageId)
      .order("form_name", { ascending: true });

    return NextResponse.json({
      ok: true,
      forms: serializeForms((refreshed ?? []) as FormRow[]),
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { form_id?: string; enabled?: boolean }
      | null;
    const formId = body?.form_id?.trim();
    const enabled = body?.enabled === true;
    if (!formId) {
      return NextResponse.json({ error: "form_id is required." }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: formRow } = await admin
      .from("meta_lead_forms")
      .select("*")
      .eq("account_id", ctx.accountId)
      .eq("form_id", formId)
      .maybeSingle();
    const form = formRow as FormRow | null;
    if (!form) {
      return NextResponse.json({ error: "Form not found." }, { status: 404 });
    }

    if (!enabled) {
      const { error: disableErr } = await admin
        .from("meta_lead_forms")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("id", form.id);
      if (disableErr) throw disableErr;
      return NextResponse.json({ ok: true, enabled: false });
    }

    // Enable: refresh questions from Meta, then materialize the
    // virtual Workspace flow.
    const pageToken = await getPageToken(ctx.supabase, ctx.accountId, form.page_id);
    let questions = form.questions;
    let formName = form.form_name;
    let status = form.status;
    try {
      const detail = await getForm(config, pageToken, form.form_id);
      questions = questionList(detail.questions);
      formName = detail.name ?? formName;
      status = detail.status ?? status;
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof MetaLeadAdsError
              ? `Could not read this form from Meta: ${err.message}`
              : "Could not read this form from Meta.",
        },
        { status: 502 },
      );
    }

    // First enable starts a historical import. A form that already
    // finished importing keeps its cursor; polling picks up new leads.
    const startImport = form.import_status !== "done";

    const { error: enableErr } = await admin
      .from("meta_lead_forms")
      .update({
        enabled: true,
        questions,
        form_name: formName,
        status,
        last_synced_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
        ...(startImport
          ? {
              import_status: "importing",
              import_cursor: null,
              imported_count: 0,
            }
          : {}),
      })
      .eq("id", form.id);
    if (enableErr) throw enableErr;

    const ownerUserId = await resolveAuditUserId(admin, ctx.accountId);
    const flowId = await ensureVirtualFlow(admin, {
      accountId: ctx.accountId,
      ownerUserId,
      form: {
        id: form.id,
        form_id: form.form_id,
        form_name: formName,
        questions,
      },
    });

    let importResult: ImportResult | null = null;
    if (startImport) {
      try {
        const fresh = await getFormForImport(admin, ctx.accountId, form.form_id);
        if (fresh) {
          importResult = await importFormLeads(admin, config, {
            accountId: ctx.accountId,
            form: fresh,
            maxPages: 2,
          });
        }
      } catch (err) {
        importResult = {
          imported: 0,
          processed: 0,
          failed: 0,
          hasMore: true,
          error: importErrorMessage(err),
        };
      }
    }

    return NextResponse.json({
      ok: true,
      enabled: true,
      flowId,
      import: importResult,
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
