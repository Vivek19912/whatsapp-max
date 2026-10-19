// GET /api/integrations/meta-capi/cron
//
// Sweeps failed Conversions API deliveries whose bounded-backoff
// window has elapsed. Auth re-uses AUTOMATION_CRON_SECRET / CRON_SECRET,
// matching the other cron endpoints.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { runDueDeliveries } from "@/lib/meta-capi/deliver";
import { metaCapiPlatform } from "@/lib/meta-capi/triggers";
import { supabaseAdmin } from "@/lib/flows/admin-client";

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

  const platform = metaCapiPlatform();
  if (!platform) {
    return NextResponse.json(
      { error: "Meta is not configured on this server." },
      { status: 503 },
    );
  }

  try {
    const result = await runDueDeliveries(supabaseAdmin(), platform, 50);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[meta-capi-cron] delivery sweep failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
