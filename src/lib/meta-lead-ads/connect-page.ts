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
import {
  describeMetaGraphError,
  describeSubscriptionError,
  graphErrorDiagnostic,
  MetaLeadAdsError,
} from "./errors";
import {
  debugToken,
  getAppPageSubscriptions,
  getDataset,
  getPage,
  inspectPageSubscriptions,
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
    /**
     * OAuth page selection requires the token to belong to the shared
     * app. Manual setup leaves this false so polling still works when
     * the token cannot install the webhook.
     */
    enforceOurApp?: boolean;
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

  try {
    const info = await debugToken(config, args.token);
    if (!info.isValid) {
      checks.push({
        name: "Token app",
        ok: false,
        detail: `Meta reports this token as invalid (${info.error ?? "debug_token failed"}). Polling and reads may fail until it is reconnected.`,
      });
      if (args.enforceOurApp) {
        throw new MetaLeadAdsError(
          "needs_reauth",
          "Meta reports this token as invalid. Reconnect before selecting Pages.",
          409,
        );
      }
    } else if (!info.appId) {
      checks.push({
        name: "Token app",
        ok: false,
        detail:
          "Meta did not identify the issuing app for this token. Reads/polling may still work, but the shared webhook cannot be installed unless the token belongs to the shared app.",
      });
    } else if (info.appId !== config.appId) {
      const detail =
        "This token belongs to a different Meta app, so it cannot install the shared app's webhook. Reads/polling may still work; reconnect through Connect with Facebook for real-time delivery.";
      checks.push({ name: "Token app", ok: false, detail });
      if (args.enforceOurApp) {
        throw new MetaLeadAdsError("permission_denied", detail, 400);
      }
    } else {
      checks.push({
        name: "Token app",
        ok: true,
        detail: `The token belongs to the shared app${info.type ? ` (${info.type})` : ""} and reports ${info.scopes.length} granted scope${info.scopes.length === 1 ? "" : "s"}.`,
      });
    }
  } catch (err) {
    if (err instanceof MetaLeadAdsError && args.enforceOurApp) throw err;
    if (!checks.some((check) => check.name === "Token app")) {
      checks.push({
        name: "Token app",
        ok: false,
        detail: `Could not verify the token's app: ${graphErrorDiagnostic(err)}. Reads/polling may still work; webhook installation requires the shared app's token.`,
      });
    }
  }

  let appConfigured = false;
  try {
    const app = await getAppPageSubscriptions(config);
    appConfigured = app.configured;
    checks.push({
      name: "App webhook (leadgen)",
      ok: appConfigured,
      detail: appConfigured
        ? "The shared app has leadgen enabled at app level."
        : "The shared app does not have leadgen enabled at app level. Complete Webhooks → Page → leadgen in the Meta App Dashboard. Page installation alone cannot deliver events; polling remains active.",
    });
  } catch (err) {
    checks.push({
      name: "App webhook (leadgen)",
      ok: false,
      detail: `Could not read the shared app's webhook configuration: ${graphErrorDiagnostic(err)}. Polling remains active.`,
    });
  }

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
  try {
    subscribed = await subscribePageToLeadgen(config, pageToken, args.pageId);
  } catch (err) {
    subscribed = false;
    checks.push({
      name: "Page installation",
      ok: false,
      detail: describeSubscriptionError(err),
    });
  }

  let pageVerified = false;
  try {
    const inspection = await inspectPageSubscriptions(
      config,
      pageToken,
      args.pageId,
    );
    pageVerified = inspection.subscribed;
    if (inspection.subscribed) {
      checks.push({
        name: "Page installation",
        ok: true,
        detail: "The Page readback contains the shared app with leadgen.",
      });
    } else if (!checks.some((check) => check.name === "Page installation")) {
      checks.push({
        name: "Page installation",
        ok: false,
        detail:
          "The Page readback does not contain the shared app with leadgen. This can mean missing pages_manage_metadata/ads_management, a non-Page token, or a token from another app. Polling remains active.",
      });
    }
  } catch (err) {
    checks.push({
      name: "Page installation",
      ok: false,
      detail: `Could not read back the Page subscription: ${graphErrorDiagnostic(err)}. Polling remains active.`,
    });
  }

  const webhookVerified = appConfigured && pageVerified;
  let webhookDetail: string;
  if (webhookVerified) {
    webhookDetail = "Real-time delivery is configured: app-level leadgen is enabled and the Page readback contains the shared app.";
  } else if (pageVerified && !appConfigured) {
    webhookDetail =
      "The Page is installed by the shared app, but app-level leadgen is not enabled. Complete the App Dashboard webhook action; polling remains active.";
  } else {
    webhookDetail =
      "Not subscribed to leadgen. New leads still arrive via polling; use the reported Graph diagnostics to fix installation.";
  }
  checks.push({
    name: "Webhook subscription",
    ok: webhookVerified,
    detail: webhookDetail,
  });

  const warningText = checks
    .filter(
      (check) =>
        !check.ok &&
        (check.name === "Token app" ||
          check.name === "App webhook (leadgen)" ||
          check.name === "Page installation" ||
          check.name === "Webhook subscription"),
    )
    .map((check) => `${check.name}: ${check.detail}`)
    .join(" ");
  const warning = warningText === "" ? null : warningText;

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
