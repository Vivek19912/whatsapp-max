// /api/integrations/meta-lead-ads/forms
//
// GET   — the Instant Forms discovered for this account (stored).
// POST  — re-sync a Page's forms from Meta.
// PATCH — enable or disable a form. Enabling refreshes its questions
//         and materializes the virtual Workspace flow.

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
  last_synced_at: string | null;
  last_error: string | null;
}

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
    lastSyncedAt: f.last_synced_at,
    lastError: f.last_error,
  }));
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const pageId = new URL(request.url).searchParams.get("page_id");

    let query = ctx.supabase
      .from("meta_lead_forms")
      .select(
        "id, page_id, form_id, form_name, status, locale, questions, enabled, last_synced_at, last_error",
      )
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
    if (!pageId) {
      return NextResponse.json({ error: "page_id is required." }, { status: 400 });
    }

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

    const { data: refreshed } = await ctx.supabase
      .from("meta_lead_forms")
      .select(
        "id, page_id, form_id, form_name, status, locale, questions, enabled, last_synced_at, last_error",
      )
      .eq("account_id", ctx.accountId)
      .eq("page_id", pageId)
      .order("form_name", { ascending: true });

    return NextResponse.json({ ok: true, forms: serializeForms((refreshed ?? []) as FormRow[]) });
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

    const { data: formRow } = await ctx.supabase
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
      const admin = supabaseAdmin();
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

    const admin = supabaseAdmin();
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

    return NextResponse.json({ ok: true, enabled: true, flowId });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
