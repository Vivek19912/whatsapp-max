// GET /api/integrations/meta-lead-ads/status
//
// Lightweight probe for the settings UI: is the integration
// configured, is an account connected and healthy, which Pages are
// selected, and when did the last lead sync succeed. Tokens are
// NEVER selected or returned.

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/auth/account";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { metaLeadAdsConfigured } from "@/lib/meta-lead-ads/config";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [{ data: conn }, { data: pages }, { data: forms }, { data: lastSync }] =
      await Promise.all([
        ctx.supabase
          .from("meta_lead_connections")
          .select("meta_user_name, status, scopes, token_expiry, last_error, updated_at")
          .eq("account_id", ctx.accountId)
          .maybeSingle(),
        ctx.supabase
          .from("meta_lead_pages")
          .select("page_id, page_name, subscribed, webhook_verified, last_error")
          .eq("account_id", ctx.accountId)
          .order("page_name", { ascending: true }),
        ctx.supabase
          .from("meta_lead_forms")
          .select("id, enabled")
          .eq("account_id", ctx.accountId),
        ctx.supabase
          .from("meta_lead_submissions")
          .select("processed_at")
          .eq("account_id", ctx.accountId)
          .eq("status", "processed")
          .order("processed_at", { ascending: false })
          .limit(1),
      ]);

    const formRows = (forms ?? []) as Array<{ id: string; enabled: boolean }>;
    const connection = conn as
      | {
          meta_user_name: string | null;
          status: string;
          scopes: string | null;
          token_expiry: string | null;
          last_error: string | null;
          updated_at: string;
        }
      | null;

    return NextResponse.json({
      configured: metaLeadAdsConfigured(),
      connected: !!connection,
      account: connection
        ? {
            userName: connection.meta_user_name,
            status: connection.status,
            scopes: connection.scopes ? connection.scopes.split(",") : [],
            tokenExpiry: connection.token_expiry,
            lastError: connection.last_error,
            updatedAt: connection.updated_at,
          }
        : null,
      pages: (pages ?? []).map((p) => {
        const row = p as {
          page_id: string;
          page_name: string | null;
          subscribed: boolean;
          webhook_verified: boolean;
          last_error: string | null;
        };
        return {
          pageId: row.page_id,
          pageName: row.page_name,
          subscribed: row.subscribed,
          webhookVerified: row.webhook_verified,
          lastError: row.last_error,
        };
      }),
      formSummary: {
        total: formRows.length,
        enabled: formRows.filter((f) => f.enabled).length,
      },
      lastSuccessAt:
        ((lastSync ?? []) as Array<{ processed_at: string | null }>)[0]?.processed_at ??
        null,
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
