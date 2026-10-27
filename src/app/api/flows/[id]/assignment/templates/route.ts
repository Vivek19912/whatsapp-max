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
      .select("name, language, status, category")
      .eq("account_id", ctx.accountId)
      .eq("status", "APPROVED")
      .order("name", { ascending: true })
      .limit(200);
    const approved = (((templates ?? []) as Array<Record<string, unknown>>).filter(
      (t) => typeof t.name === "string" && t.name !== "" && typeof t.language === "string",
    ) as Array<{ name: string; language: string; status?: unknown; category?: unknown }>).map((t) => ({
      name: t.name,
      language: t.language,
      status: typeof t.status === "string" ? t.status : "APPROVED",
      category: typeof t.category === "string" ? t.category : null,
    }));
    const { data: sender } = await ctx.supabase
      .from("whatsapp_config")
      .select("phone_number_id")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    const row = sender as { phone_number_id?: unknown } | null;
    return NextResponse.json({
      templates: approved,
      sender_connected:
        !!row && typeof row.phone_number_id === "string" && row.phone_number_id !== "",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
