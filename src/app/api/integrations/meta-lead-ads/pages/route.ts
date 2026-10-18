// /api/integrations/meta-lead-ads/pages
//
// GET    — list the Facebook Pages the connected Meta user can manage,
//          merged with the Pages this account has selected.
// POST   — select a Page: verify the Page access token, subscribe our
//          app to `leadgen`, and store the (encrypted) Page token.
// DELETE — disconnect a Page (best-effort unsubscribe + row removal).

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import {
  getPageSubscriptions,
  listPages,
  subscribePageToLeadgen,
  unsubscribePageFromLeadgen,
} from "@/lib/meta-lead-ads/graph-client";
import type { MetaPage } from "@/lib/meta-lead-ads/graph-client";
import { disconnectPage, getConnection, getPageToken, getUserToken } from "@/lib/meta-lead-ads/store";
import { encrypt } from "@/lib/whatsapp/encryption";

interface StoredPage {
  page_id: string;
  page_name: string | null;
  subscribed: boolean;
  webhook_verified: boolean;
  last_error: string | null;
}

// Deliberately generic: never leak the other account's identity or
// details — only that the Page is already taken somewhere else.
const PAGE_TAKEN_MESSAGE =
  "This Facebook Page is already connected to another WhatsApp Max workspace. " +
  "Disconnect it there first, or choose a different Page.";

function errorDetail(err: unknown): string {
  if (err instanceof MetaLeadAdsError) return err.message;
  return "Could not reach Meta. Please try again.";
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = metaLeadAdsConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Meta Lead Ads is not configured on this server." },
        { status: 501 },
      );
    }

    const conn = await getConnection(ctx.supabase, ctx.accountId);
    if (!conn) {
      return NextResponse.json({ configured: true, connected: false, pages: [] });
    }

    const { data: storedRows } = await ctx.supabase
      .from("meta_lead_pages")
      .select("page_id, page_name, subscribed, webhook_verified, last_error")
      .eq("account_id", ctx.accountId);
    const stored = (storedRows ?? []) as StoredPage[];
    const storedByPage = new Map(stored.map((s) => [s.page_id, s]));

    let discovered: MetaPage[] = [];
    let error: { code: string; message: string } | null = null;
    try {
      const token = await getUserToken(ctx.supabase, ctx.accountId);
      discovered = await listPages(config, token);
    } catch (err) {
      error = {
        code: err instanceof MetaLeadAdsError ? err.code : "unknown",
        message: errorDetail(err),
      };
    }

    const pages = discovered.map((p) => {
      const s = storedByPage.get(p.id);
      return {
        pageId: p.id,
        pageName: p.name ?? null,
        selected: Boolean(s),
        subscribed: s?.subscribed ?? false,
        webhookVerified: s?.webhook_verified ?? false,
        lastError: s?.last_error ?? null,
      };
    });
    // Preserve stored Pages that no longer appear in Meta so the user
    // can still disconnect them.
    for (const s of stored) {
      if (!pages.some((p) => p.pageId === s.page_id)) {
        pages.push({
          pageId: s.page_id,
          pageName: s.page_name,
          selected: true,
          subscribed: s.subscribed,
          webhookVerified: s.webhook_verified,
          lastError: s.last_error,
        });
      }
    }

    return NextResponse.json({ configured: true, connected: true, pages, error });
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
    if (!pageId) {
      return NextResponse.json({ error: "page_id is required." }, { status: 400 });
    }

    // A Facebook Page may back exactly ONE WhatsApp Max account. Check
    // globally (service role, because RLS can only ever show this
    // account's rows) BEFORE any side effect, so we never subscribe a
    // Page we then refuse to record. The response stays generic.
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
    const pages = await listPages(config, token);
    const page = pages.find((p) => p.id === pageId);
    if (!page) {
      return NextResponse.json(
        { error: "That Page is not among your authorized Pages." },
        { status: 404 },
      );
    }
    if (!page.access_token) {
      return NextResponse.json(
        {
          error:
            "No Page access token was returned — you need a role on this Page that grants lead access.",
        },
        { status: 403 },
      );
    }

    let subscribed = false;
    let warning: string | null = null;
    try {
      subscribed = await subscribePageToLeadgen(config, page.access_token, pageId);
    } catch (err) {
      warning = errorDetail(err);
    }
    // Never mark connected on OAuth alone: confirm the subscription.
    let verified = false;
    try {
      verified = await getPageSubscriptions(config, page.access_token, pageId);
    } catch {
      verified = false;
    }

    // Never persist a half-open connection: if the subscription cannot
    // be confirmed there is no lead-producing state to keep, so store
    // NOTHING and roll back any subscription we just attempted. This
    // leaves no partial subscription and no inconsistent record.
    if (!verified) {
      if (subscribed) {
        try {
          await unsubscribePageFromLeadgen(config, page.access_token, pageId);
        } catch {
          // Best-effort rollback — a stale token must not block the
          // (no-op) local teardown.
        }
      }
      return NextResponse.json(
        {
          ok: false,
          subscribed: false,
          webhookVerified: false,
          code: "subscription_failed",
          error:
            warning ??
            "Could not verify the leadgen webhook subscription for this Page. Nothing was saved — please try again.",
        },
        { status: 502 },
      );
    }

    const { error } = await ctx.supabase.from("meta_lead_pages").upsert(
      {
        account_id: ctx.accountId,
        page_id: pageId,
        page_name: page.name ?? null,
        access_token: encrypt(page.access_token),
        tasks: page.tasks ?? [],
        subscribed: true,
        webhook_verified: true,
        subscribed_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "account_id,page_id" },
    );
    if (error) {
      // Lost a race: another account connected this exact Page between
      // our pre-check and this write. The global unique index (120)
      // rejects it; surface the same generic conflict.
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: PAGE_TAKEN_MESSAGE, code: "page_already_connected" },
          { status: 409 },
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true, subscribed: true, webhookVerified: true });
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
