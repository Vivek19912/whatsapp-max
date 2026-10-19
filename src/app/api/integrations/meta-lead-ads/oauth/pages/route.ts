// POST /api/integrations/meta-lead-ads/oauth/pages
//
// Connect the caller's explicitly selected Pages from a verified OAuth
// session. Only page ids present in the account's own session are
// accepted; historical connections, forms, and leads are preserved.

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { connectPage, type SetupCheck } from "@/lib/meta-lead-ads/connect-page";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { debugToken } from "@/lib/meta-lead-ads/graph-client";
import { normalizeSelectedPageIds } from "@/lib/meta-lead-ads/oauth";
import {
  deleteOAuthSession,
  getConnection,
  getOAuthSession,
  saveOAuthConnection,
} from "@/lib/meta-lead-ads/store";

const PAGE_TAKEN_MESSAGE =
  "This Facebook Page is already connected to another WhatsApp Max workspace. " +
  "Disconnect it there first, or choose a different Page.";

interface PageSelectionResult {
  pageId: string;
  ok: boolean;
  pageName: string | null;
  subscribed: boolean;
  webhookVerified: boolean;
  warning: string | null;
  error: string | null;
  code: string | null;
  checks: SetupCheck[];
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { page_ids?: unknown }
      | null;
    const pageIds = normalizeSelectedPageIds(body?.page_ids);
    if (pageIds.length === 0) {
      return NextResponse.json(
        { error: "Select at least one eligible Facebook Page." },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();
    const session = await getOAuthSession(admin, ctx.accountId);
    if (!session || session.account_id !== ctx.accountId) {
      return NextResponse.json(
        {
          error: "The Meta authorization session expired. Start Connect with Facebook again.",
          code: "oauth_session_expired",
        },
        { status: 409 },
      );
    }

    const allowed = new Set(session.pages.map((page) => page.id));
    if (pageIds.some((pageId) => !allowed.has(pageId))) {
      return NextResponse.json(
        {
          error: "One or more selected Pages were not authorized in this Meta session.",
          code: "unauthorized_page_selection",
        },
        { status: 403 },
      );
    }

    const tokenInfo = await debugToken(config, session.access_token);
    if (!tokenInfo.isValid) {
      await deleteOAuthSession(admin, ctx.accountId);
      throw new MetaLeadAdsError(
        "needs_reauth",
        "Meta reports this authorization as invalid. Start Connect with Facebook again.",
        409,
      );
    }
    if (tokenInfo.appId && tokenInfo.appId !== config.appId) {
      await deleteOAuthSession(admin, ctx.accountId);
      throw new MetaLeadAdsError(
        "permission_denied",
        "This authorization belongs to a different Meta app and cannot install the shared webhook. Start Connect with Facebook again.",
        400,
      );
    }

    const existing = await getConnection(ctx.supabase, ctx.accountId);
    const results: PageSelectionResult[] = [];

    for (const pageId of pageIds) {
      const { data: foreignRows, error: foreignErr } = await admin
        .from("meta_lead_pages")
        .select("account_id")
        .eq("page_id", pageId)
        .neq("account_id", ctx.accountId)
        .limit(1);
      if (foreignErr) throw foreignErr;
      if ((foreignRows ?? []).length > 0) {
        results.push({
          pageId,
          ok: false,
          pageName: null,
          subscribed: false,
          webhookVerified: false,
          warning: null,
          error: PAGE_TAKEN_MESSAGE,
          code: "page_already_connected",
          checks: [],
        });
        continue;
      }

      try {
        const connected = await connectPage(ctx.supabase, config, {
          accountId: ctx.accountId,
          token: session.access_token,
          pageId,
          enforceOurApp: true,
        });
        results.push({
          pageId: connected.pageId,
          ok: true,
          pageName: connected.pageName,
          subscribed: connected.subscribed,
          webhookVerified: connected.webhookVerified,
          warning: connected.warning,
          error: null,
          code: null,
          checks: connected.checks,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          results.push({
            pageId,
            ok: false,
            pageName: null,
            subscribed: false,
            webhookVerified: false,
            warning: null,
            error: PAGE_TAKEN_MESSAGE,
            code: "page_already_connected",
            checks: [],
          });
          continue;
        }
        results.push({
          pageId,
          ok: false,
          pageName: null,
          subscribed: false,
          webhookVerified: false,
          warning: null,
          error:
            err instanceof MetaLeadAdsError
              ? err.message
              : "Could not connect this Page. Polling and existing leads are unchanged.",
          code: err instanceof MetaLeadAdsError ? err.code : "page_connection_failed",
          checks: [],
        });
      }
    }

    const succeeded = results.filter((result) => result.ok);
    if (succeeded.length === 0) {
      return NextResponse.json({ ok: false, pages: results });
    }

    await saveOAuthConnection(ctx.supabase, ctx.accountId, {
      accessToken: session.access_token,
      tokenExpiry: session.token_expiry,
      scopes: session.scopes,
      metaUserId: session.meta_user_id,
      metaUserName: session.meta_user_name,
      tokenAppId: tokenInfo.appId ?? config.appId,
      tokenType: tokenInfo.type,
      datasetId: existing?.dataset_id ?? undefined,
      connectedBy: ctx.userId,
    });
    await deleteOAuthSession(admin, ctx.accountId);

    return NextResponse.json({
      ok: results.every((result) => result.ok),
      connection: { setupSource: "oauth", pages: succeeded.length },
      pages: results,
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
