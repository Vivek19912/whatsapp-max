// POST /api/integrations/meta-capi/retry
//
// Admin-only. With a `delivery_id` retries exactly that failed
// delivery; otherwise sweeps every failed delivery whose backoff window
// has elapsed. Retries reuse the original event_id, so Meta
// de-duplicates rather than double-counting.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { retryDeliveryById, runDueDeliveries } from "@/lib/meta-capi/deliver";
import { metaCapiPlatform } from "@/lib/meta-capi/triggers";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { supabaseAdmin } from "@/lib/flows/admin-client";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const platform = metaCapiPlatform();
    if (!platform) {
      return NextResponse.json(
        { error: "Meta is not configured on this server.", code: "not_configured" },
        { status: 501 },
      );
    }

    const admin = supabaseAdmin();
    const body = (await request.json().catch(() => null)) as
      | { delivery_id?: string }
      | null;
    const deliveryId = body?.delivery_id?.trim();

    if (deliveryId) {
      const result = await retryDeliveryById(admin, platform, ctx.accountId, deliveryId);
      return NextResponse.json({ ok: true, result });
    }

    const result = await runDueDeliveries(admin, platform, 20, ctx.accountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
