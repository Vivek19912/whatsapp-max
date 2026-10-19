// ============================================================
// Meta Lead Ads — connect one Page by id.
//
// Manual setup pastes a Page id (instead of OAuth Page discovery).
// This helper verifies the Page with the account's token, probes each
// capability the sync depends on (dataset access, form listing, lead
// retrieval), attempts the `leadgen` webhook subscription, reads the
// subscription back, and persists the Page row with its encrypted
// Page token.
//
// Capability results are returned as a `checks` list so Save & verify
// can tell the customer EXACTLY which stage failed instead of claiming
// success because the IDs merely look valid. Only an unreadable Page
// is fatal (nothing is written in that case). The webhook subscription
// is best-effort: a token that can read leads but cannot manage
// metadata still enables the polling fallback.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { MetaLeadAdsConfig } from "./config";
import { describeMetaGraphError, MetaLeadAdsError } from "./errors";
import {
  getDataset,
  getPage,
  getPageSubscriptions,
  listForms,
  probeFormLeadAccess,
  subscribePageToLeadgen,
} from "./graph-client";

export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConnectPageResult {
  pageId: string;
  pageName: string | null;
  subscribed: boolean;
  webhookVerified: boolean;
  warning: string | null;
  checks: SetupCheck[];
}

function message(err: unknown): string {
  return describeMetaGraphError(err);
}

/**
 * Verify + persist a Page for the account. Throws when the token
 * cannot read the Page at all (nothing is written in that case).
 */
export async function connectPage(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  args: {
    accountId: string;
    token: string;
    pageId: string;
    /** When present, dataset reachability is probed as well. */
    datasetId?: string | null;
  },
): Promise<ConnectPageResult> {
  const checks: SetupCheck[] = [];

  const page = await getPage(config, args.token, args.pageId);
  if (!page.id) {
    throw new MetaLeadAdsError(
      "page_not_found",
      "Meta did not return that Page. Check the numeric Page ID.",
      404,
    );
  }
  checks.push({
    name: "Access token → Page",
    ok: true,
    detail: `The token can read "${page.name ?? args.pageId}".`,
  });

  const pageToken = page.access_token ?? args.token;

  if (args.datasetId) {
    try {
      const dataset = await getDataset(config, args.token, args.datasetId);
      checks.push({
        name: "Dataset / Pixel",
        ok: Boolean(dataset.id),
        detail: dataset.name
          ? `Found dataset "${dataset.name}".`
          : "The dataset is reachable with this token.",
      });
    } catch (err) {
      checks.push({ name: "Dataset / Pixel", ok: false, detail: message(err) });
    }
  }

  // Form listing + a lead-retrieval probe. A token that can read a Page
  // is NOT necessarily allowed to read forms or submissions.
  try {
    const forms = await listForms(config, pageToken, args.pageId);
    checks.push({
      name: "Instant Forms",
      ok: true,
      detail:
        forms.length === 0
          ? "No Instant Forms found on this Page yet."
          : `${forms.length} Instant Form${forms.length === 1 ? "" : "s"} readable.`,
    });

    if (forms.length > 0) {
      try {
        await probeFormLeadAccess(config, pageToken, forms[0].id);
        checks.push({
          name: "Lead retrieval",
          ok: true,
          detail: "Existing submissions are readable (leads_retrieval granted).",
        });
      } catch (err) {
        checks.push({ name: "Lead retrieval", ok: false, detail: message(err) });
      }
    }
  } catch (err) {
    checks.push({ name: "Instant Forms", ok: false, detail: message(err) });
  }

  let subscribed = false;
  let warning: string | null = null;
  try {
    subscribed = await subscribePageToLeadgen(config, pageToken, args.pageId);
  } catch (err) {
    warning = message(err);
  }

  let webhookVerified = false;
  try {
    webhookVerified = await getPageSubscriptions(config, pageToken, args.pageId);
  } catch (err) {
    if (!warning) warning = message(err);
    webhookVerified = false;
  }

  checks.push({
    name: "Webhook subscription",
    ok: webhookVerified,
    detail: webhookVerified
      ? "This app is subscribed to the Page's leadgen events."
      : "Not subscribed to leadgen. New leads still arrive via polling; grant pages_manage_metadata and re-save to enable the webhook.",
  });

  const now = new Date().toISOString();
  const { error } = await db.from("meta_lead_pages").upsert(
    {
      account_id: args.accountId,
      page_id: args.pageId,
      page_name: page.name ?? null,
      access_token: page.access_token ? encrypt(page.access_token) : null,
      subscribed,
      subscribed_at: subscribed ? now : null,
      webhook_verified: webhookVerified,
      last_synced_at: now,
      last_error: webhookVerified ? null : warning,
      updated_at: now,
    },
    { onConflict: "account_id,page_id" },
  );
  if (error) throw error;

  return {
    pageId: args.pageId,
    pageName: page.name ?? null,
    subscribed,
    webhookVerified,
    warning,
    checks,
  };
}
