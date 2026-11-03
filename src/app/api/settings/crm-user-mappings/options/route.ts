// ============================================================
// CRM User Mapping options — dropdown data for the mapping UI.
//
//   GET /api/settings/crm-user-mappings/options
//
// Owner/Admin only. Returns both sides in one call so the dialog
// never needs two round-trips:
//
//   wacrm_users: every member of the caller's account
//     [{ id, name, email, role, has_mapping }]
//   crm_users: assignable salespeople in the CONNECTED Travel CRM
//     account [{ id, fullName, username, email }]
//
// The Travel CRM secret stays server-side: the route proxies the
// tenant-scoped lookups feed and returns user lists only.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { fetchTravelCrmLookups } from "@/lib/integrations/travel-crm/client";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import { extractCrmSalespeople } from "@/lib/integrations/travel-crm/user-mapping";
import { isAccountRole } from "@/lib/auth/roles";

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");

    const { data: members, error: membersError } = await supabase
      .from("profiles")
      .select("user_id, full_name, email, account_role")
      .eq("account_id", accountId)
      .order("created_at", { ascending: true });
    if (membersError) {
      console.error("[crm-user-mappings] members fetch error:", membersError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to load workspace users." },
        { status: 500 },
      );
    }

    const { data: mapped, error: mappedError } = await supabase
      .from("crm_user_mappings")
      .select("wacrm_user_id")
      .eq("account_id", accountId);
    if (mappedError) {
      console.error("[crm-user-mappings] mappings fetch error:", mappedError);
      return NextResponse.json(
        { success: false, code: "LOAD_FAILED", error: "Failed to load mappings." },
        { status: 500 },
      );
    }
    const mappedIds = new Set(
      ((mapped ?? []) as Array<{ wacrm_user_id: string }>).map((m) => m.wacrm_user_id),
    );

    const wacrm_users = (
      (members ?? []) as Array<{
        user_id: string;
        full_name: string | null;
        email: string | null;
        account_role: string;
      }>
    ).flatMap((row) => {
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          id: row.user_id,
          name: row.full_name ?? row.email ?? row.user_id,
          email: row.email,
          role: row.account_role,
          has_mapping: mappedIds.has(row.user_id),
        },
      ];
    });

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
    let crm_users;
    try {
      const lookups = await fetchTravelCrmLookups(baseUrl, secret, fetch, {
        ownerEmail,
      });
      crm_users = extractCrmSalespeople(lookups);
    } catch (err) {
      console.error(
        "[crm-user-mappings] CRM users fetch failed:",
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_UNAVAILABLE",
          error: "Could not reach Travel CRM to load salespeople. Try again.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, wacrm_users, crm_users });
  } catch (err) {
    return toErrorResponse(err);
  }
}
