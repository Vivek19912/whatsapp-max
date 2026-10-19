// GET /api/integrations/meta-capi/deliveries
//
// Recent delivery ledger for this account — the honest record of what
// was sent, skipped, failed or retried. Payloads are NOT returned.

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/auth/account";
import { toPublicDelivery } from "@/lib/meta-capi/serialize";
import { listDeliveries } from "@/lib/meta-capi/store";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const deliveries = await listDeliveries(ctx.supabase, ctx.accountId, 25);
    return NextResponse.json({ deliveries: deliveries.map(toPublicDelivery) });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
