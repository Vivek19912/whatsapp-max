// POST /api/integrations/meta-lead-ads/test
//
// Diagnostics only — verifies configuration, the stored manual
// credentials, Page access, form access and the `leadgen` webhook
// subscription. It NEVER claims a live lead was received; that can
// only be proven by an actual submission appearing in the Workspace.
//
// Token validation deliberately uses an authenticated Page read with
// the customer's own token. `debug_token` is bound to the token's Meta
// app and would fail for a System User token issued by another app.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import {
  getDataset,
  getPage,
  getPageSubscriptions,
  listForms,
  probeFormLeadAccess,
} from "@/lib/meta-lead-ads/graph-client";
import {
  getConnection,
  getPageToken,
  getUserToken,
} from "@/lib/meta-lead-ads/store";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function message(err: unknown): string {
  return err instanceof MetaLeadAdsError
    ? err.message
    : "Unexpected error.";
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
        name: "Credentials",
        ok: false,
        detail: "Add your Dataset ID, access token and Page ID in the setup form.",
      });
      return NextResponse.json({ ok: false, checks });
    }

    checks.push({
      name: "Dataset ID",
      ok: Boolean(conn.dataset_id),
      detail: conn.dataset_id
        ? "A Dataset/Pixel ID is stored."
        : "No Dataset/Pixel ID is stored.",
    });

    let token: string;
    try {
      token = await getUserToken(ctx.supabase, ctx.accountId);
    } catch (err) {
      checks.push({ name: "Access token", ok: false, detail: message(err) });
      return NextResponse.json({ ok: false, checks });
    }

    if (conn.dataset_id) {
      try {
        const dataset = await getDataset(config, token, conn.dataset_id);
        checks.push({
          name: "Dataset access",
          ok: Boolean(dataset.id),
          detail: dataset.name
            ? `The token can reach dataset "${dataset.name}".`
            : "The token can reach the dataset.",
        });
      } catch (err) {
        checks.push({ name: "Dataset access", ok: false, detail: message(err) });
      }
    }

    const { data: pageRows } = await ctx.supabase
      .from("meta_lead_pages")
      .select("page_id, page_name, subscribed, webhook_verified")
      .eq("account_id", ctx.accountId);
    const pages = (pageRows ?? []) as Array<{
      page_id: string;
      page_name: string | null;
      subscribed: boolean;
      webhook_verified: boolean;
    }>;

    if (pages.length === 0) {
      checks.push({
        name: "Facebook Page",
        ok: false,
        detail: "No Page is connected yet.",
      });
      return NextResponse.json({ ok: false, checks });
    }

    for (const p of pages) {
      const label = p.page_name ?? p.page_id;
      try {
        const page = await getPage(config, token, p.page_id);
        checks.push({
          name: `Token → Page: ${label}`,
          ok: Boolean(page.id),
          detail: page.id
            ? "The stored token can read this Page."
            : "Meta did not return this Page.",
        });

        const pageToken = await getPageToken(
          ctx.supabase,
          ctx.accountId,
          p.page_id,
        );

        let formsOk = true;
        let formCount = 0;
        let firstFormId: string | null = null;
        try {
          const forms = await listForms(config, pageToken, p.page_id);
          formCount = forms.length;
          firstFormId = forms[0]?.id ?? null;
        } catch {
          formsOk = false;
        }
        checks.push({
          name: `Forms: ${label}`,
          ok: formsOk,
          detail: formsOk
            ? formCount === 0
              ? "No Instant Forms on this Page yet."
              : `${formCount} Instant Form${formCount === 1 ? "" : "s"} readable.`
            : "Meta refused the form list. Check leads_retrieval and the Page role.",
        });

        if (formsOk && firstFormId) {
          let leadsOk = true;
          try {
            await probeFormLeadAccess(config, pageToken, firstFormId);
          } catch {
            leadsOk = false;
          }
          checks.push({
            name: `Lead retrieval: ${label}`,
            ok: leadsOk,
            detail: leadsOk
              ? "Existing form submissions are readable."
              : "Meta refused the lead list. Grant leads_retrieval and the Page role.",
          });
        }

        let subscribed = false;
        try {
          subscribed = await getPageSubscriptions(config, pageToken, p.page_id);
        } catch {
          subscribed = false;
        }
        checks.push({
          name: `Webhook: ${label}`,
          ok: subscribed,
          detail: subscribed
            ? "The app is subscribed to leadgen."
            : "Not subscribed. Polling still imports new leads; re-save the Page to retry the subscription.",
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
