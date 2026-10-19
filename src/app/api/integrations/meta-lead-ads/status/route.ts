// GET /api/integrations/meta-lead-ads/status
//
// Lightweight probe for the settings UI: is the integration
// configured, are manual credentials stored and healthy, which Page is
// connected, how the historical import is progressing, and when did
// the last lead sync succeed. Tokens are NEVER returned.

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/auth/account";
import { getConfig } from "@/lib/meta-capi/store";
import { metaLeadAdsConfigured } from "@/lib/meta-lead-ads/config";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

interface ConnectionRow {
  dataset_id: string | null;
  meta_user_name: string | null;
  status: string;
  scopes: string | null;
  token_expiry: string | null;
  last_error: string | null;
  updated_at: string;
  access_token: string | null;
}

interface PageRow {
  page_id: string;
  page_name: string | null;
  subscribed: boolean;
  webhook_verified: boolean;
  last_error: string | null;
  last_synced_at: string | null;
  last_polled_at: string | null;
}

interface FormRow {
  id: string;
  enabled: boolean;
  import_status: string;
  imported_count: number;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [
      { data: conn },
      { data: pages },
      { data: forms },
      { data: lastSync },
      capi,
    ] = await Promise.all([
      ctx.supabase
        .from("meta_lead_connections")
        .select(
          "dataset_id, meta_user_name, status, scopes, token_expiry, last_error, updated_at, access_token",
        )
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
      ctx.supabase
        .from("meta_lead_pages")
        .select(
          "page_id, page_name, subscribed, webhook_verified, last_error, last_synced_at, last_polled_at",
        )
        .eq("account_id", ctx.accountId)
        .order("page_name", { ascending: true }),
      ctx.supabase
        .from("meta_lead_forms")
        .select("id, enabled, import_status, imported_count")
        .eq("account_id", ctx.accountId),
      ctx.supabase
        .from("meta_lead_submissions")
        .select("processed_at")
        .eq("account_id", ctx.accountId)
        .eq("status", "processed")
        .order("processed_at", { ascending: false })
        .limit(1),
      getConfig(ctx.supabase, ctx.accountId),
    ]);

    const connection = conn as ConnectionRow | null;
    const formRows = (forms ?? []) as FormRow[];

    return NextResponse.json({
      configured: metaLeadAdsConfigured(),
      connected: !!connection,
      status: connection?.status ?? null,
      datasetId: connection?.dataset_id ?? capi?.dataset_id ?? null,
      hasToken: Boolean(connection?.access_token) || Boolean(capi?.access_token),
      tokenSource: connection?.access_token
        ? "manual"
        : capi?.access_token
          ? "capi"
          : null,
      account: connection
        ? {
            userName: connection.meta_user_name,
            status: connection.status,
            datasetId: connection.dataset_id,
            scopes: connection.scopes ? connection.scopes.split(",") : [],
            tokenExpiry: connection.token_expiry,
            lastError: connection.last_error,
            updatedAt: connection.updated_at,
          }
        : null,
      pages: ((pages ?? []) as PageRow[]).map((p) => ({
        pageId: p.page_id,
        pageName: p.page_name,
        subscribed: p.subscribed,
        webhookVerified: p.webhook_verified,
        lastError: p.last_error,
        lastSyncedAt: p.last_synced_at,
        lastPolledAt: p.last_polled_at,
      })),
      formSummary: {
        total: formRows.length,
        enabled: formRows.filter((f) => f.enabled).length,
        importing: formRows.filter((f) => f.import_status === "importing").length,
        imported: formRows.reduce((sum, f) => sum + (f.imported_count ?? 0), 0),
      },
      capi: {
        datasetId: capi?.dataset_id ?? null,
        hasToken: Boolean(capi?.access_token),
      },
      lastSuccessAt:
        ((lastSync ?? []) as Array<{ processed_at: string | null }>)[0]
          ?.processed_at ?? null,
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
