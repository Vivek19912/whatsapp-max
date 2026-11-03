// ============================================================
// CRM User Mapping API — WhatsApp Max user → Travel CRM salesperson.
//
// Standalone Settings section ("CRM User Mapping"), Owner/Admin only.
// Identity is by INTERNAL IDs on both sides (profiles.user_id ↔
// Travel CRM users.id) — never email or name matching.
//
//   GET  /api/settings/crm-user-mappings  — list with resolved names + status
//   POST /api/settings/crm-user-mappings  — create { wacrm_user_id, crm_user_id }
//
// All failures are safe: 4xx for caller errors, 502 when Travel CRM
// is unreachable, never a secret in any response.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import {
  listAccountMappings,
  loadCrmRoster,
} from "@/lib/integrations/travel-crm/user-mapping";

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { rows, crmReachable } = await listAccountMappings(supabase, accountId);
    return NextResponse.json({
      success: true,
      mappings: rows,
      crmReachable,
    });
  } catch (err) {
    // Auth/role failures (thrown by requireRole) keep their status;
    // only store failures collapse to the LOAD_FAILED envelope.
    if (err instanceof Error && "status" in err) return toErrorResponse(err);
    console.error("[crm-user-mappings] list fetch error:", err);
    return NextResponse.json(
      { success: false, code: "LOAD_FAILED", error: "Failed to load mappings." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("admin");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const wacrmUserId =
      typeof body?.wacrm_user_id === "string" ? body.wacrm_user_id.trim() : "";
    const crmUserId =
      typeof body?.crm_user_id === "string" ? body.crm_user_id.trim() : "";

    // The WACRM side is identified by its internal profiles.user_id
    // (an opaque id — never an email). Format is not validated here;
    // membership in THIS account (checked below) is authoritative.
    if (!wacrmUserId) {
      return NextResponse.json(
        { success: false, code: "INVALID_REQUEST", error: "wacrm_user_id is required." },
        { status: 400 },
      );
    }
    if (!crmUserId) {
      return NextResponse.json(
        { success: false, code: "INVALID_REQUEST", error: "crm_user_id is required." },
        { status: 400 },
      );
    }

    // The WACRM side must be a current member of THIS account.
    const { data: member, error: memberError } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId)
      .eq("user_id", wacrmUserId)
      .maybeSingle();
    if (memberError) {
      console.error("[crm-user-mappings] member lookup failed:", memberError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to verify the WhatsApp Max user." },
        { status: 500 },
      );
    }
    if (!member) {
      return NextResponse.json(
        {
          success: false,
          code: "WACRM_USER_NOT_FOUND",
          error: "That WhatsApp Max user is not a member of this workspace.",
        },
        { status: 400 },
      );
    }

    // One mapping per WACRM user per workspace — update instead.
    const { data: existing, error: existingError } = await supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("account_id", accountId)
      .eq("wacrm_user_id", wacrmUserId)
      .maybeSingle();
    if (existingError) {
      console.error("[crm-user-mappings] duplicate check failed:", existingError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to check existing mappings." },
        { status: 500 },
      );
    }
    if (existing) {
      return NextResponse.json(
        {
          success: false,
          code: "MAPPING_EXISTS",
          error: "This user already has a mapping. Edit it instead.",
        },
        { status: 409 },
      );
    }

    // The CRM side must belong to the CONNECTED CRM account — validated
    // live against the tenant-scoped assignable-users feed. Agent input
    // can never smuggle an arbitrary ID past this check.
    const { secret, baseUrl } = getTravelCrmConfig();
    if (!secret) {
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_NOT_CONFIGURED",
          error: "Travel CRM integration is not configured.",
        },
        { status: 503 },
      );
    }
    const ownerEmail = await resolveAccountOwnerEmail(supabase, accountId);
    const roster = await loadCrmRoster(baseUrl, secret, ownerEmail);
    if (!roster) {
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_UNAVAILABLE",
          error: "Could not reach Travel CRM to validate the salesperson. Try again.",
        },
        { status: 502 },
      );
    }
    if (!roster.some((u) => u.id === crmUserId)) {
      return NextResponse.json(
        {
          success: false,
          code: "CRM_USER_NOT_FOUND",
          error: "That salesperson does not belong to the connected Travel CRM account.",
        },
        { status: 400 },
      );
    }

    const { data: created, error: insertError } = await supabase
      .from("crm_user_mappings")
      .insert({
        account_id: accountId,
        wacrm_user_id: wacrmUserId,
        crm_user_id: crmUserId,
        created_by: userId,
      })
      .select("id, wacrm_user_id, crm_user_id, created_at, updated_at")
      .single();
    if (insertError || !created) {
      console.error("[crm-user-mappings] insert failed:", insertError);
      return NextResponse.json(
        { success: false, code: "SAVE_FAILED", error: "Failed to save the mapping." },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, mapping: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
