// ============================================================
// Meta Lead Ads — connect one Page by id.
//
// Manual setup pastes a Page id (instead of OAuth Page discovery).
// This helper verifies the Page with the account's token, attempts
// the `leadgen` webhook subscription, reads the subscription back,
// and persists the Page row with its encrypted Page token.
//
// The webhook subscription is best-effort: a token that can read
// leads but cannot manage metadata still enables the polling
// fallback, so a subscription failure is reported as a warning
// rather than throwing away a valid connection.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { MetaLeadAdsConfig } from "./config";
import { MetaLeadAdsError } from "./errors";
import {
  getPage,
  getPageSubscriptions,
  subscribePageToLeadgen,
} from "./graph-client";

export interface ConnectPageResult {
  pageId: string;
  pageName: string | null;
  subscribed: boolean;
  webhookVerified: boolean;
  warning: string | null;
}

function message(err: unknown): string {
  if (err instanceof MetaLeadAdsError) return err.message;
  return "Could not reach Meta. Please try again.";
}

/**
 * Verify + persist a Page for the account. Throws when the token
 * cannot read the Page at all (nothing is written in that case).
 */
export async function connectPage(
  db: SupabaseClient,
  config: MetaLeadAdsConfig,
  args: { accountId: string; token: string; pageId: string },
): Promise<ConnectPageResult> {
  const page = await getPage(config, args.token, args.pageId);
  if (!page.id) {
    throw new MetaLeadAdsError(
      "page_not_found",
      "Meta did not return that Page. Check the numeric Page ID.",
      404,
    );
  }

  const pageToken = page.access_token ?? args.token;

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

  const now = new Date().toISOString();
  const { error } = await db.from("meta_lead_pages").upsert(
    {
      account_id: args.accountId,
      page_id: args.pageId,
      page_name: page.name ?? null,
      access_token: page.access_token ? encrypt(page.access_token) : null,
      tasks: page.tasks ?? [],
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
  };
}
