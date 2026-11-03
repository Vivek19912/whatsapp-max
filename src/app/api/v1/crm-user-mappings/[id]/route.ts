// ============================================================
// Public API (v1) — update / delete one CRM user mapping.
//
// Same auth and tenant rules as the collection routes: API key with
// the `crm-mappings:manage` scope; the row must belong to the key's
// account or it reads as not-found (no cross-account oracle).
// Replacement salespeople are re-validated live against the
// connected CRM account's roster.
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { fail, ok, toApiErrorResponse } from "@/lib/api/v1/respond";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import { loadCrmRoster } from "@/lib/integrations/travel-crm/user-mapping";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, "crm-mappings:manage");
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const crmUserId =
      typeof body?.crm_user_id === "string" ? body.crm_user_id.trim() : "";
    if (!crmUserId) {
      return fail("bad_request", "crm_user_id is required.", 400);
    }

    const { data: row, error: rowError } = await ctx.supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (rowError) {
      console.error("[api/v1/crm-user-mappings] row lookup failed:", rowError.message);
      return fail("internal", "Failed to load the mapping.", 500);
    }
    if (!row) {
      return fail("not_found", "Mapping not found.", 404);
    }

    const { secret, baseUrl } = getTravelCrmConfig();
    if (!secret) {
      return fail("travel_crm_not_configured", "Travel CRM integration is not configured.", 503);
    }
    const ownerEmail = await resolveAccountOwnerEmail(ctx.supabase, ctx.accountId);
    const roster = await loadCrmRoster(baseUrl, secret, ownerEmail);
    if (!roster) {
      return fail(
        "travel_crm_unavailable",
        "Could not reach Travel CRM to validate the salesperson.",
        502,
      );
    }
    if (!roster.some((u) => u.id === crmUserId)) {
      return fail(
        "crm_user_not_found",
        "That salesperson does not belong to the connected Travel Agency CRM account.",
        400,
      );
    }

    const { data: updated, error: updateError } = await ctx.supabase
      .from("crm_user_mappings")
      .update({ crm_user_id: crmUserId })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id, wacrm_user_id, crm_user_id, created_at, updated_at")
      .single();
    if (updateError || !updated) {
      console.error("[api/v1/crm-user-mappings] update failed:", updateError?.message);
      return fail("internal", "Failed to update the mapping.", 500);
    }

    console.info(
      "[api/v1/crm-user-mappings] mapping updated:",
      JSON.stringify({ keyId: ctx.keyId, accountId: ctx.accountId, mappingId: id }),
    );
    return ok({ mapping: updated });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, "crm-mappings:manage");
    const { id } = await params;

    const { data: row, error: rowError } = await ctx.supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (rowError) {
      console.error("[api/v1/crm-user-mappings] row lookup failed:", rowError.message);
      return fail("internal", "Failed to load the mapping.", 500);
    }
    if (!row) {
      return fail("not_found", "Mapping not found.", 404);
    }

    const { error: deleteError } = await ctx.supabase
      .from("crm_user_mappings")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (deleteError) {
      console.error("[api/v1/crm-user-mappings] delete failed:", deleteError.message);
      return fail("internal", "Failed to delete the mapping.", 500);
    }

    console.info(
      "[api/v1/crm-user-mappings] mapping deleted:",
      JSON.stringify({ keyId: ctx.keyId, accountId: ctx.accountId, mappingId: id }),
    );
    return ok({ deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
