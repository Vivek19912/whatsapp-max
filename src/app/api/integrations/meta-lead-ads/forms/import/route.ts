// POST /api/integrations/meta-lead-ads/forms/import
//
// Re-run the historical import for one enabled Instant Form. This is
// safe to click repeatedly: the ledger's unique key skips leads that
// already exist, and only NEW leads increment `imported_count`.
//
// Bounded to a few Graph pages per call; the cron resumes the cursor
// if the form is large.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import {
  getFormForImport,
  importFormLeads,
} from "@/lib/meta-lead-ads/sync";

export const maxDuration = 60;

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
      | { form_id?: string }
      | null;
    const formId = body?.form_id?.trim();
    if (!formId) {
      return NextResponse.json({ error: "form_id is required." }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: formRow } = await admin
      .from("meta_lead_forms")
      .select("id, form_id, enabled")
      .eq("account_id", ctx.accountId)
      .eq("form_id", formId)
      .maybeSingle();
    const form = formRow as { id: string; form_id: string; enabled: boolean } | null;
    if (!form) {
      return NextResponse.json({ error: "Form not found." }, { status: 404 });
    }
    if (!form.enabled) {
      return NextResponse.json(
        { error: "Enable the form before importing its existing leads." },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const { error: resetErr } = await admin
      .from("meta_lead_forms")
      .update({
        import_status: "importing",
        import_cursor: null,
        imported_count: 0,
        last_error: null,
        updated_at: now,
      })
      .eq("id", form.id)
      .eq("account_id", ctx.accountId);
    if (resetErr) throw resetErr;

    const fresh = await getFormForImport(admin, ctx.accountId, form.form_id);
    if (!fresh) {
      return NextResponse.json({ error: "Form not found." }, { status: 404 });
    }

    const result = await importFormLeads(admin, config, {
      accountId: ctx.accountId,
      form: fresh,
    });

    return NextResponse.json({ ok: !result.error, import: result });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
