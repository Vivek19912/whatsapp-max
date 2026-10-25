// /api/integrations/meta-lead-ads/whatsapp/tables/[flowId]/config
//
// Per-Workspace-table WhatsApp auto-send templates (Meta Lead Ads
// only). The table is resolved server-side to its Meta form; every
// read and write is scoped to (account, form), so one table's
// sequence can never leak into or overwrite another table's.
//
// GET (members+) — table + form identity, this table's config
//   (paused, delay, ordered items), the account's APPROVED
//   templates for the picker, and send-history counts.
// PUT (owner-only) — replace this table's template sequence,
//   delay, and paused flag. Every template must exist and be
//   APPROVED; templates needing per-send values (variables/media)
//   are rejected with an actionable message. Never touches other
//   tables. Flow Tables resolve to 404 here (same as unknown
//   tables) — their behavior is unchanged.

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveTableForm } from '@/lib/meta-lead-sheets/tables';
import {
  getTableWhatsappStatus,
  templateSendBlockers,
} from '@/lib/meta-lead-whatsapp/queue';
import { validateAutoSendConfig } from '@/lib/meta-lead-whatsapp/config';
import { scheduleWhatsappDrainSoon } from '@/lib/meta-lead-whatsapp/trigger';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';

export const maxDuration = 60;

type Ctx = { params: Promise<{ flowId: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    const ctx = await getCurrentAccount();
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    const status = await getTableWhatsappStatus(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );

    // APPROVED templates only — the picker must never offer a
    // template that auto-send would refuse to deliver.
    const { data: templates } = await ctx.supabase
      .from('message_templates')
      .select('name, language, status, body_text')
      .eq('account_id', ctx.accountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true })
      .limit(200);
    const approved = ((templates ?? []) as Array<{
      name: string;
      language: string;
      status: string;
      body_text?: string | null;
    }>).filter((t) => typeof t.name === 'string' && t.name !== '');

    return NextResponse.json({
      flow: { id: table.flowId, name: table.flowName },
      form: {
        id: table.formDbId,
        form_id: table.formId,
        form_name: table.formName,
        enabled: table.formEnabled,
      },
      configured: status.configured,
      paused: status.paused,
      delay_seconds: status.delay_seconds,
      items: status.items,
      approved_templates: approved.map((t) => ({
        template_name: t.name,
        template_language: t.language,
        preview: typeof t.body_text === 'string' ? t.body_text.slice(0, 160) : null,
      })),
      counts: status.counts,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    // Owner-only: a table's auto-send sequence, delay, and pause
    // state control outbound messaging — same bar as the Sheets
    // per-table config.
    const ctx = await requireRole('owner');
    const table = await resolveTableForm(ctx.supabase, ctx.accountId, flowId);
    if (!table) {
      return NextResponse.json({ error: 'Table not found.' }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    let validated;
    try {
      validated = validateAutoSendConfig({
        delay_seconds: body.delay_seconds,
        paused: body.paused,
        templates: body.templates,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid config.' },
        { status: 400 }
      );
    }

    // Every template must exist and be APPROVED in THIS account,
    // and must not need per-send values auto-send cannot supply.
    // Service-role read so the check reflects the catalog even
    // when RLS would hide rows from the caller.
    const admin = supabaseAdmin();
    for (const item of validated.templates) {
      const { data } = await admin
        .from('message_templates')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('name', item.template_name)
        .eq('language', item.template_language)
        .maybeSingle();
      if (!data || !isMessageTemplate(data)) {
        return NextResponse.json(
          {
            error: `Template "${item.template_name}" (${item.template_language}) was not found. Sync templates from Meta first.`,
          },
          { status: 400 }
        );
      }
      const row = data as unknown as Parameters<
        typeof templateSendBlockers
      >[0] & { status?: string };
      if (row.status !== 'APPROVED') {
        return NextResponse.json(
          {
            error: `Template "${item.template_name}" (${item.template_language}) is ${row.status ?? 'not approved'} — only APPROVED templates can be auto-sent.`,
          },
          { status: 400 }
        );
      }
      const blockers = templateSendBlockers(row);
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: `Template "${item.template_name}" cannot be auto-sent: ${blockers.join('; ')}.`,
          },
          { status: 400 }
        );
      }
    }

    // Replace the sequence atomically-in-effect: upsert the config,
    // delete this table's items, insert the new order. Scoped to
    // (account, form) throughout — sibling tables are untouched.
    // Service-role writes: the queue/config tables expose no
    // member-write RLS (service role owns writes), matching the
    // Sheets per-table mutation path.
    const { error: cfgErr } = await admin
      .from('meta_lead_whatsapp_configs')
      .upsert(
        {
          account_id: ctx.accountId,
          form_id: table.formId,
          paused: validated.paused,
          delay_seconds: validated.delay_seconds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,form_id' }
      );
    if (cfgErr) throw cfgErr;

    const { error: delErr } = await admin
      .from('meta_lead_whatsapp_templates')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('form_id', table.formId);
    if (delErr) throw delErr;

    if (validated.templates.length > 0) {
      const { error: insErr } = await admin
        .from('meta_lead_whatsapp_templates')
        .insert(
          validated.templates.map((t) => ({
            account_id: ctx.accountId,
            form_id: table.formId,
            template_name: t.template_name,
            template_language: t.template_language,
            position: t.position,
          }))
        );
      if (insErr) throw insErr;
    }

    const status = await getTableWhatsappStatus(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );

    // Unpausing with pending rows should resume promptly; the cron
    // remains the fallback outside request scope.
    if (!validated.paused && validated.templates.length > 0) {
      try {
        scheduleWhatsappDrainSoon({ accountId: ctx.accountId });
      } catch {
        // Best-effort only.
      }
    }

    return NextResponse.json({
      ok: true,
      configured: status.configured,
      paused: status.paused,
      delay_seconds: status.delay_seconds,
      items: status.items,
      counts: status.counts,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
