import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { resolveTableFlow } from "@/lib/lead-assignment/table-config";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/flows/[id]/assignment/templates — this account's
 * send-eligible WhatsApp templates for the Assignment dialog's
 * template picker. Works for Meta Lead Ads tables and Flow tables
 * (the table identity only proves tenancy — templates themselves
 * are account-scoped).
 *
 * Members+ may read. Returns APPROVED templates only (name,
 * language, status, and category as stored from the Meta sync,
 * ordered by name), verified live from the account's own
 * `message_templates` rows — never another account's, never
 * hardcoded — plus whether the account sender is connected.
 * Category may be null for rows synced before the column
 * existed; the UI falls back instead of guessing. The notify
 * path re-validates name + language + APPROVED at send time, so
 * this list can never promise what delivery would refuse.
 *
 * `details` carries the full renderable content (header, body,
 * footer, buttons, media URLs, sample values) for the assignment
 * dialog's hover preview. Read-only enrichment from the same rows;
 * it changes no selection, validation, or send behavior.
 */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await getCurrentAccount();
    const flow = await resolveTableFlow(ctx.supabase, ctx.accountId, id);
    if (!flow) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    const { data: templates } = await ctx.supabase
      .from("message_templates")
      .select(
        "name, language, status, category, header_type, header_content, header_media_url, body_text, footer_text, buttons, sample_values",
      )
      .eq("account_id", ctx.accountId)
      .eq("status", "APPROVED")
      .order("name", { ascending: true })
      .limit(200);
    const rows = (((templates ?? []) as Array<Record<string, unknown>>).filter(
      (t) => !!t && typeof t === "object" && !Array.isArray(t),
    ) as Array<Record<string, unknown>>);
    const approved = rows
      .filter(
        (t): t is { name: string; language: string; status?: unknown; category?: unknown } =>
          typeof t.name === "string" && t.name !== "" && typeof t.language === "string",
      )
      .map((t) => ({
        name: t.name,
        language: t.language,
        status: typeof t.status === "string" ? t.status : "APPROVED",
        category: typeof t.category === "string" ? t.category : null,
      }));
    // Full renderable content for the hover preview (same rows,
    // account-scoped by the query above). Never fabricated: missing
    // values stay null/empty and the UI shows an unavailable state.
    const details = rows
      .filter(
        (t) => typeof t.name === "string" && t.name !== "" && typeof t.language === "string" && t.language !== "",
      )
      .map((t) => ({
        name: t.name as string,
        language: t.language as string,
        status: typeof t.status === "string" ? t.status : "APPROVED",
        category: typeof t.category === "string" ? t.category : null,
        header_type: typeof t.header_type === "string" ? t.header_type : null,
        header_content: typeof t.header_content === "string" ? t.header_content : null,
        header_media_url: typeof t.header_media_url === "string" ? t.header_media_url : null,
        body_text: typeof t.body_text === "string" ? t.body_text : "",
        footer_text: typeof t.footer_text === "string" ? t.footer_text : null,
        buttons: Array.isArray(t.buttons) ? t.buttons : [],
        sample_values:
          t.sample_values && typeof t.sample_values === "object" && !Array.isArray(t.sample_values)
            ? t.sample_values
            : {},
      }));
    const { data: sender } = await ctx.supabase
      .from("whatsapp_config")
      .select("phone_number_id")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    const row = sender as { phone_number_id?: unknown } | null;
    return NextResponse.json({
      templates: approved,
      details,
      sender_connected:
        !!row && typeof row.phone_number_id === "string" && row.phone_number_id !== "",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
