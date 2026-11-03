// ============================================================
// Public API (v1) — CRM User Mapping management for the Travel
// Agency CRM integration.
//
// Lets the Travel Agency CRM backend manage the mappings stored in
// WhatsApp Max's `crm_user_mappings` table (the same rows the
// dashboard Settings API manages).
//
// Auth: machine-to-machine API key with the `crm-mappings:manage`
// scope (`Authorization: Bearer wacrm_live_…`). The key lookup fixes
// the account server-side — the account is NEVER taken from request
// input, so one tenant can never read or modify another tenant's
// mappings. No user session, no cookies, no RLS: every query is
// explicitly filtered by the key's account.
//
// Validation mirrors the dashboard Settings API exactly (member of
// the key's account on the WACRM side, live CRM-roster membership on
// the CRM side), so both management paths enforce the same rules.
//
// Envelope: the versioned v1 shape (`{ data }` / `{ error: { code,
// message } }`) — never the dashboard's internal shape.
// ============================================================

import { requireApiKey } from "@/lib/auth/api-context";
import { fail, ok, toApiErrorResponse } from "@/lib/api/v1/respond";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import {
  listAccountMappings,
  loadCrmRoster,
} from "@/lib/integrations/travel-crm/user-mapping";

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, "crm-mappings:manage");

    const { rows, members, crmReachable } = await listAccountMappings(
      ctx.supabase,
      ctx.accountId,
    );
    return ok({ mappings: rows, wacrm_users: members, crm_reachable: crmReachable });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("mappings fetch failed")) {
      console.error("[api/v1/crm-user-mappings] list failed:", err.message);
      return fail("internal", "Failed to load mappings.", 500);
    }
    if (err instanceof Error && err.message.startsWith("members fetch failed")) {
      console.error("[api/v1/crm-user-mappings] members failed:", err.message);
      return fail("internal", "Failed to load workspace users.", 500);
    }
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, "crm-mappings:manage");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const wacrmUserId =
      typeof body?.wacrm_user_id === "string" ? body.wacrm_user_id.trim() : "";
    const crmUserId =
      typeof body?.crm_user_id === "string" ? body.crm_user_id.trim() : "";
    if (!wacrmUserId || !crmUserId) {
      return fail("bad_request", "wacrm_user_id and crm_user_id are required.", 400);
    }

    // WACRM side: must be a current member of the key's account.
    const { data: member, error: memberError } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email")
      .eq("account_id", ctx.accountId)
      .eq("user_id", wacrmUserId)
      .maybeSingle();
    if (memberError) {
      console.error("[api/v1/crm-user-mappings] member lookup failed:", memberError.message);
      return fail("internal", "Failed to verify the WhatsApp Max user.", 500);
    }
    if (!member) {
      return fail(
        "wacrm_user_not_found",
        "That WhatsApp Max user is not a member of this workspace.",
        400,
      );
    }
    const memberName = member as { full_name?: unknown; email?: unknown };

    // One mapping per WACRM user per workspace.
    const { data: existing, error: existingError } = await ctx.supabase
      .from("crm_user_mappings")
      .select("id")
      .eq("account_id", ctx.accountId)
      .eq("wacrm_user_id", wacrmUserId)
      .maybeSingle();
    if (existingError) {
      console.error("[api/v1/crm-user-mappings] duplicate check failed:", existingError.message);
      return fail("internal", "Failed to check existing mappings.", 500);
    }
    if (existing) {
      return fail(
        "mapping_exists",
        "This user already has a mapping. Update it instead.",
        409,
      );
    }

    // CRM side: must belong to the CONNECTED CRM account — validated
    // live against the tenant-scoped roster (owner-email locator), so
    // a foreign CRM user id is rejected even if the caller knows it.
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

    const { data: created, error: insertError } = await ctx.supabase
      .from("crm_user_mappings")
      .insert({
        account_id: ctx.accountId,
        wacrm_user_id: wacrmUserId,
        crm_user_id: crmUserId,
        created_by: ctx.createdBy,
      })
      .select("id, wacrm_user_id, crm_user_id, created_at, updated_at")
      .single();
    if (insertError || !created) {
      console.error("[api/v1/crm-user-mappings] insert failed:", insertError?.message);
      return fail("internal", "Failed to save the mapping.", 500);
    }

    console.info(
      "[api/v1/crm-user-mappings] mapping created:",
      JSON.stringify({ keyId: ctx.keyId, accountId: ctx.accountId, mappingId: (created as { id: string }).id }),
    );
    // Both sides were validated above, so the new row is active by
    // construction — resolve its display names directly instead of
    // re-reading through the roster join.
    const salesperson = roster.find((u) => u.id === crmUserId);
    const row = created as {
      id: string;
      wacrm_user_id: string;
      crm_user_id: string;
      created_at: string;
      updated_at: string;
    };
    return ok(
      {
        mapping: {
          id: row.id,
          wacrm_user_id: row.wacrm_user_id,
          wacrm_name:
            typeof memberName.full_name === "string" ? memberName.full_name : null,
          wacrm_email: typeof memberName.email === "string" ? memberName.email : null,
          crm_user_id: row.crm_user_id,
          crm_name: salesperson?.fullName ?? null,
          crm_email: salesperson?.email ?? null,
          status: "active" as const,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
      },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
