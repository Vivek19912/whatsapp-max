// ============================================================
// CRM User Mapping item API — update / delete one mapping.
//
//   PATCH  /api/settings/crm-user-mappings/:id  { crm_user_id }
//   DELETE /api/settings/crm-user-mappings/:id
//
// Owner/Admin only (requireRole("admin")). The row is always scoped
// to the caller's account, and the replacement salesperson is
// re-validated live against the connected CRM account — an agent
// (or a stale dialog) can neither touch another workspace's rows
// nor smuggle in a foreign CRM user id.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { fetchTravelCrmLookups } from "@/lib/integrations/travel-crm/client";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import { extractCrmSalespeople } from "@/lib/integrations/travel-crm/user-mapping";

async function loadCrmIds(
  baseUrl: string,
  secret: string,
  ownerEmail: string | null,
): Promise<Set<string> | null> {
  try {
    const lookups = await fetchTravelCrmLookups(baseUrl, secret, fetch, {
      ownerEmail,
    });
    return new Set(extractCrmSalespeople(lookups).map((u) => u.id));
  } catch (err) {
    console.error(
      "[crm-user-mappings] CRM roster fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const crmUserId =
      typeof body?.crm_user_id === "string" ? body.crm_user_id.trim() : "";
    if (!crmUserId) {
      return NextResponse.json(
        { success: false, code: "INVALID_REQUEST", error: "crm_user_id is required." },
        { status: 400 },
      );
    }

    const { data: row, error: rowError } = await supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (rowError) {
      console.error("[crm-user-mappings] row lookup failed:", rowError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to load the mapping." },
        { status: 500 },
      );
    }
    if (!row) {
      return NextResponse.json(
        { success: false, code: "MAPPING_NOT_FOUND", error: "Mapping not found." },
        { status: 404 },
      );
    }

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
    const validIds = await loadCrmIds(baseUrl, secret, ownerEmail);
    if (!validIds) {
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_UNAVAILABLE",
          error: "Could not reach Travel CRM to validate the salesperson. Try again.",
        },
        { status: 502 },
      );
    }
    if (!validIds.has(crmUserId)) {
      return NextResponse.json(
        {
          success: false,
          code: "CRM_USER_NOT_FOUND",
          error: "That salesperson does not belong to the connected Travel CRM account.",
        },
        { status: 400 },
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("crm_user_mappings")
      .update({ crm_user_id: crmUserId })
      .eq("id", id)
      .eq("account_id", accountId)
      .select("id, wacrm_user_id, crm_user_id, created_at, updated_at")
      .single();
    if (updateError || !updated) {
      console.error("[crm-user-mappings] update failed:", updateError);
      return NextResponse.json(
        { success: false, code: "SAVE_FAILED", error: "Failed to update the mapping." },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, mapping: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { id } = await params;

    const { data: row, error: rowError } = await supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();
    if (rowError) {
      console.error("[crm-user-mappings] row lookup failed:", rowError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to load the mapping." },
        { status: 500 },
      );
    }
    if (!row) {
      return NextResponse.json(
        { success: false, code: "MAPPING_NOT_FOUND", error: "Mapping not found." },
        { status: 404 },
      );
    }

    const { error: deleteError } = await supabase
      .from("crm_user_mappings")
      .delete()
      .eq("id", id)
      .eq("account_id", accountId);
    if (deleteError) {
      console.error("[crm-user-mappings] delete failed:", deleteError);
      return NextResponse.json(
        { success: false, code: "DELETE_FAILED", error: "Failed to delete the mapping." },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
