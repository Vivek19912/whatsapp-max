// GET /api/integrations/meta-lead-ads/cron
//
// Sweeps failed Meta lead retrievals whose bounded-backoff window has
// elapsed. Auth re-uses AUTOMATION_CRON_SECRET / CRON_SECRET, matching
// the other cron endpoints (see scripts/setup-automation-cron.sh).

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { runDueRetries } from "@/lib/meta-lead-ads/process-lead";

export async function GET(request: Request) {
  const expectedSecrets = [
    process.env.CRON_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  if (expectedSecrets.length === 0) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  const supplied =
    request.headers.get("x-cron-secret") ??
    (authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  const suppliedBuf = Buffer.from(supplied);
  const authorized = expectedSecrets.some((expected) => {
    const expectedBuf = Buffer.from(expected);
    return (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    );
  });
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = metaLeadAdsConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Meta Lead Ads is not configured on this server." },
      { status: 503 },
    );
  }

  try {
    const result = await runDueRetries(supabaseAdmin(), config, 50);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[meta-lead-ads-cron] retry sweep failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
