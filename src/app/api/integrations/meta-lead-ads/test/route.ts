// POST /api/integrations/meta-lead-ads/test
//
// Diagnostics only — verifies configuration, token validity, granted
// permissions, Page access and the `leadgen` webhook subscription per
// selected Page. It NEVER claims a live lead was received; that can
// only be proven by an actual submission appearing in the Workspace.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import {
  META_LEAD_ADS_SCOPES,
  metaLeadAdsConfig,
} from "@/lib/meta-lead-ads/config";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import {
  debugToken,
  getPageSubscriptions,
  listForms,
} from "@/lib/meta-lead-ads/graph-client";
import { getConnection, getPageToken, getUserToken } from "@/lib/meta-lead-ads/store";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function message(err: unknown): string {
  return err instanceof MetaLeadAdsError ? err.message : "Unexpected error.";
}

export async function POST() {
  try {
    const ctx = await requireRole("admin");
    const config = metaLeadAdsConfig();
    const checks: Check[] = [];

    if (!config) {
      checks.push({
        name: "Configuration",
        ok: false,
        detail: "Server is missing Meta credentials (see docs/meta-lead-ads.md).",
      });
      return NextResponse.json({ ok: false, checks });
    }
    checks.push({
      name: "Configuration",
      ok: true,
      detail: `Configured for Graph ${config.graphVersion}.`,
    });

    const conn = await getConnection(ctx.supabase, ctx.accountId);
    if (!conn) {
      checks.push({
        name: "Authorization",
        ok: false,
        detail: "No Meta account is connected.",
      });
      return NextResponse.json({ ok: false, checks });
    }

    let token: string;
    try {
      token = await getUserToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      checks.push({ name: "Authorization", ok: false, detail: message(err) });
      return NextResponse.json({ ok: false, checks });
    }

    try {
      const info = await debugToken(config, token);
      checks.push({
        name: "Authorization",
        ok: info.isValid,
        detail: info.isValid ? "Access token is valid." : "Access token is invalid or expired.",
      });
      const missing = META_LEAD_ADS_SCOPES.filter(
        (scope) => !info.scopes.includes(scope),
      );
      checks.push({
        name: "Permissions",
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? "All required permissions are granted."
            : `Missing permissions: ${missing.join(", ")}.`,
      });
    } catch (err) {
      checks.push({ name: "Authorization", ok: false, detail: message(err) });
    }

    const { data: pageRows } = await ctx.supabase
      .from("meta_lead_pages")
      .select("page_id, page_name")
      .eq("account_id", ctx.accountId);
    const pages = (pageRows ?? []) as Array<{ page_id: string; page_name: string | null }>;

    if (pages.length === 0) {
      checks.push({
        name: "Pages",
        ok: false,
        detail: "No Pages selected yet.",
      });
    }

    for (const p of pages) {
      const label = p.page_name ?? p.page_id;
      try {
        const pageToken = await getPageToken(ctx.supabase, ctx.accountId, p.page_id);
        const subscribed = await getPageSubscriptions(config, pageToken, p.page_id);
        let formsOk = true;
        try {
          await listForms(config, pageToken, p.page_id);
        } catch {
          formsOk = false;
        }
        checks.push({
          name: `Page: ${label}`,
          ok: subscribed && formsOk,
          detail:
            subscribed && formsOk
              ? "Page access and leadgen subscription OK."
              : [subscribed ? null : "Webhook subscription missing.", formsOk ? null : "Forms not accessible."]
                  .filter(Boolean)
                  .join(" "),
        });
      } catch (err) {
        checks.push({ name: `Page: ${label}`, ok: false, detail: message(err) });
      }
    }

    const ok = checks.every((c) => c.ok);
    return NextResponse.json({ ok, checks });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
