// GET /api/integrations/meta-capi/status
//
// Safe projection for the settings UI: is CAPI available on this
// server, has the customer stored a dataset + token, how healthy is
// it, and a summary of recent deliveries. The access token is NEVER
// selected or returned.

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/auth/account";
import { toPublicConfig, toPublicDelivery } from "@/lib/meta-capi/serialize";
import { getConfig, listDeliveries, listMappings } from "@/lib/meta-capi/store";
import { metaCapiPlatform } from "@/lib/meta-capi/triggers";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [config, mappings, deliveries] = await Promise.all([
      getConfig(ctx.supabase, ctx.accountId),
      listMappings(ctx.supabase, ctx.accountId),
      listDeliveries(ctx.supabase, ctx.accountId, 10),
    ]);

    return NextResponse.json({
      configured: metaCapiPlatform() !== null,
      config: toPublicConfig(config),
      mappingSummary: {
        total: mappings.length,
        enabled: mappings.filter((m) => m.enabled).length,
      },
      recentDeliveries: deliveries.map(toPublicDelivery),
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
