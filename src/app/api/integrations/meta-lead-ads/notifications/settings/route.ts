// GET/PUT /api/integrations/meta-lead-ads/notifications/settings
//
// Per-account opt-in for new-lead salesperson emails (Meta tables
// only). GET is any member; PUT is admin+. SMTP credentials are
// server env vars and are never readable or writable here.

import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  defaultNotifySettings,
  validateNotifyTemplates,
} from "@/lib/meta-lead-ads/notify";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("meta_lead_notification_settings")
      .select("enabled, subject_template, body_template, updated_at")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? {}) as {
      enabled?: boolean;
      subject_template?: string | null;
      body_template?: string | null;
      updated_at?: string | null;
    };
    const defaults = defaultNotifySettings();
    return NextResponse.json({
      enabled: row.enabled === true,
      subject_template: row.subject_template ?? defaults.subjectTemplate,
      body_template: row.body_template ?? defaults.bodyTemplate,
      updated_at: row.updated_at ?? null,
      is_default: !data,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
    }
    const validated = validateNotifyTemplates({
      subjectTemplate: body.subject_template,
      bodyTemplate: body.body_template,
    });
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const { error } = await ctx.supabase
      .from("meta_lead_notification_settings")
      .upsert(
        {
          account_id: ctx.accountId,
          enabled: body.enabled,
          subject_template: validated.subjectTemplate,
          body_template: validated.bodyTemplate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (error) throw error;
    return NextResponse.json({ ok: true, enabled: body.enabled });
  } catch (err) {
    return toErrorResponse(err);
  }
}
