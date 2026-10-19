// /api/integrations/meta-lead-ads/pages
//
// Manual (Trace-style) setup:
//   GET    — the Page(s) this account connected. No OAuth discovery:
//            a System User token generally cannot list a user's Pages.
//   POST   — connect/reconnect one numeric Page ID: verify it with the
//            stored token, subscribe our app to `leadgen` (best-effort),
//            and store the encrypted Page token.
//   DELETE — disconnect a Page (best-effort unsubscribe + row removal).

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { connectPage } from "@/lib/meta-lead-ads/connect-page";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { unsubscribePageFromLeadgen } from "@/lib/meta-lead-ads/graph-client";
import {
  disconnectPage,
  getPageToken,
  getUserToken,
} from "@/lib/meta-lead-ads/store";

interface StoredPage {
  page_id: string;
  page_name: string | null;
  subscribed: boolean;
  webhook_verified: boolean;
  last_error: string | null;
  last_synced_at: string | null;
  last_polled_at: string | null;
}

const PAGE_ID_PATTERN = /^\d{5,32}$/;

// Deliberately generic: never leak the other account's identity or
// details — only that the Page is already taken somewhere else.
const PAGE_TAKEN_MESSAGE =
  "This Facebook Page is already connected to another WhatsApp Max workspace. " +
  "Disconnect it there first, or choose a different Page.";

function serialize(row: StoredPage) {
  return {
    pageId: row.page_id,
    pageName: row.page_name,
    selected: true,
    subscribed: row.subscribed,
    webhookVerified: row.webhook_verified,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    lastPolledAt: row.last_polled_at,
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = metaLeadAdsConfig();

    const { data } = await ctx.supabase
      .from("meta_lead_pages")
      .select(
        "page_id, page_name, subscribed, webhook_verified, last_error, last_synced_at, last_polled_at",
      )
      .eq("account_id", ctx.accountId)
      .order("page_name", { ascending: true });

    const pages = ((data ?? []) as StoredPage[]).map(serialize);
    return NextResponse.json({
      configured: config !== null,
      connected: pages.length > 0,
      pages,
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
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
      | { page_id?: string }
      | null;
    const pageId = body?.page_id?.trim();
    if (!pageId || !PAGE_ID_PATTERN.test(pageId)) {
      return NextResponse.json(
        { error: "Enter the numeric Facebook Page ID." },
        { status: 400 },
      );
    }

    // A Facebook Page may back exactly ONE WhatsApp Max account. Check
    // globally (service role, because RLS can only show this account's
    // rows) BEFORE any side effect, so we never subscribe a Page we
    // then refuse to record. The response stays generic.
    const admin = supabaseAdmin();
    const { data: foreignRows, error: foreignErr } = await admin
      .from("meta_lead_pages")
      .select("account_id")
      .eq("page_id", pageId)
      .neq("account_id", ctx.accountId)
      .limit(1);
    if (foreignErr) throw foreignErr;
    if ((foreignRows ?? []).length > 0) {
      return NextResponse.json(
        { error: PAGE_TAKEN_MESSAGE, code: "page_already_connected" },
        { status: 409 },
      );
    }

    const token = await getUserToken(ctx.supabase, ctx.accountId);
    let connected;
    try {
      connected = await connectPage(ctx.supabase, config, {
        accountId: ctx.accountId,
        token,
        pageId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return NextResponse.json(
          { error: PAGE_TAKEN_MESSAGE, code: "page_already_connected" },
          { status: 409 },
        );
      }
      throw err;
    }

    return NextResponse.json({
      ok: true,
      page: {
        pageId: connected.pageId,
        pageName: connected.pageName,
        subscribed: connected.subscribed,
        webhookVerified: connected.webhookVerified,
        warning: connected.warning,
      },
    });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const pageId = new URL(request.url).searchParams.get("page_id")?.trim();
    if (!pageId) {
      return NextResponse.json({ error: "page_id is required." }, { status: 400 });
    }

    const config = metaLeadAdsConfig();
    if (config) {
      try {
        const pageToken = await getPageToken(ctx.supabase, ctx.accountId, pageId);
        await unsubscribePageFromLeadgen(config, pageToken, pageId);
      } catch {
        // Best-effort: a stale token still lets us remove the local row.
      }
    }

    const admin = supabaseAdmin();
    await disconnectPage(admin, ctx.accountId, pageId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
