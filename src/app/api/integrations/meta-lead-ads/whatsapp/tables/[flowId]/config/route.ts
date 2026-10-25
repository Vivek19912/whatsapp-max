// /api/integrations/meta-lead-ads/whatsapp/tables/[flowId]/config
//
// Per-Workspace-table WhatsApp auto-send templates (Meta Lead Ads
// only). The table is resolved server-side to its Meta form; every
// read and write is scoped to (account, form), so one table's
// sequence can never leak into or overwrite another table's.
//
// GET (members+) — table + form identity, this table's config
//   (paused, delay, ordered items with variable mappings), the
//   account's APPROVED templates with their variable slots, the
//   table's available mapping fields, a sample lead's values for
//   preview, and send-history counts.
// PUT (owner-only) — replace this table's template sequence
//   (including per-template variable mappings), delay, and paused
//   flag. Every template must exist and be APPROVED; templates
//   with variables require every slot mapped to a known field of
//   THIS table. Static templates keep working unchanged. Never
//   touches other tables. Flow Tables resolve to 404 here (same
//   as unknown tables) — their behavior is unchanged.

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
  loadTableVariableFields,
  templateSendBlockers,
} from '@/lib/meta-lead-whatsapp/queue';
import { validateAutoSendConfig } from '@/lib/meta-lead-whatsapp/config';
import {
  buildAvailableVariableFields,
  getLatestLeadFieldMap,
  getTemplateVariableSlots,
  validateVariableMappings,
} from '@/lib/meta-lead-whatsapp/variables';
import { parseFormQuestions } from '@/lib/meta-lead-ads/virtual-flow';
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

    // This table's mapping targets: standard fields + one entry
    // per Instant Form question (same keys the drain resolves).
    const { data: formRow } = await ctx.supabase
      .from('meta_lead_forms')
      .select('questions')
      .eq('id', table.formDbId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const fields = buildAvailableVariableFields(
      parseFormQuestions(
        (formRow as { questions?: unknown } | null)?.questions
      )
    );

    // APPROVED templates only — the picker must never offer a
    // template that auto-send would refuse to deliver. Slots are
    // computed server-side from the approved structure so the UI
    // maps exactly what Meta will require at send time.
    const { data: templates } = await ctx.supabase
      .from('message_templates')
      .select(
        'name, language, status, header_type, header_content, header_media_url, body_text, buttons'
      )
      .eq('account_id', ctx.accountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true })
      .limit(200);
    const approved = ((templates ?? []) as Array<{
      name: string;
      language: string;
      status: string;
      header_type?: string | null;
      header_content?: string | null;
      header_media_url?: string | null;
      body_text?: string | null;
      buttons?: unknown;
    }>).filter((t) => typeof t.name === 'string' && t.name !== '');

    // Sample preview values from this table's latest processed
    // lead (best-effort; null when no lead exists yet).
    let sample_values: Record<string, string> | null = null;
    try {
      sample_values = await getLatestLeadFieldMap(
        ctx.supabase,
        ctx.accountId,
        table.formId
      );
    } catch {
      sample_values = null;
    }

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
      fields,
      sample_values,
      approved_templates: approved.map((t) => {
        const row = {
          header_type: (t.header_type ?? null) as
            | 'text'
            | 'image'
            | 'video'
            | 'document'
            | null
            | undefined,
          header_content: t.header_content ?? null,
          body_text: t.body_text ?? '',
          buttons: Array.isArray(t.buttons)
            ? (t.buttons as Parameters<
                typeof getTemplateVariableSlots
              >[0]['buttons'])
            : [],
        };
        return {
          template_name: t.name,
          template_language: t.language,
          preview: typeof t.body_text === 'string' ? t.body_text.slice(0, 160) : null,
          body_text: typeof t.body_text === 'string' ? t.body_text : '',
          variables: getTemplateVariableSlots({
            header_type: row.header_type ?? undefined,
            header_content: row.header_content ?? undefined,
            body_text: row.body_text,
            buttons: row.buttons,
          }),
        };
      }),
      counts: status.counts,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { flowId } = await params;
    // Owner-only: a table's auto-send sequence, delay, pause
    // state, and variable mappings control outbound messaging —
    // same bar as the Sheets per-table config.
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

    // This table's known mapping targets (reject mappings that
    // reference another table's answer keys).
    const { keys: availableKeys } = await loadTableVariableFields(
      ctx.supabase,
      ctx.accountId,
      table.formId
    );

    // Every template must exist and be APPROVED in THIS account.
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
      // Media without a file can never send; variables are fine
      // once every slot is mapped to one of THIS table's fields.
      const blockers = templateSendBlockers(row);
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: `Template "${item.template_name}" cannot be auto-sent: ${blockers.join('; ')}.`,
          },
          { status: 400 }
        );
      }
      const slots = getTemplateVariableSlots(row);
      const mappingProblem = validateVariableMappings(
        slots,
        item.variable_mappings,
        availableKeys
      );
      if (mappingProblem) {
        return NextResponse.json(
          {
            error: `Template "${item.template_name}" (${item.template_language}): ${mappingProblem}`,
          },
          { status: 400 }
        );
      }
    }

    // Replace the sequence atomically-in-effect: upsert the config,
    // delete this table's items, insert the new order with their
    // mappings. Scoped to (account, form) throughout — sibling
    // tables are untouched. Service-role writes: the queue/config
    // tables expose no member-write RLS (service role owns writes),
    // matching the Sheets per-table mutation path.
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
            variable_mappings: t.variable_mappings,
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
