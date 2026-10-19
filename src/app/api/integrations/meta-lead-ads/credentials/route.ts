// /api/integrations/meta-lead-ads/credentials
//
// GET  — the account's manual Meta setup (never returns the token).
// POST — save + verify Dataset ID, System User token and Page ID.
//
// This replaces the Facebook OAuth consent flow. A token is only
// stored after Meta confirms it can read the Page, and the Page is
// rejected if another account already owns it (the global unique
// index from migration 120 keeps the webhook's Page -> account
// lookup unambiguous).
//
// "Don't ask twice": when the Conversions API already has a dataset
// and token, the caller may omit them and the stored CAPI values are
// reused. The token is copied server-side; it is never sent to the
// browser.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole } from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getConfig, getDecryptedToken } from "@/lib/meta-capi/store";
import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";
import { connectPage } from "@/lib/meta-lead-ads/connect-page";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";
import {
  getConnection,
  saveCredentials,
} from "@/lib/meta-lead-ads/store";
import { decrypt } from "@/lib/whatsapp/encryption";

const ID_PATTERN = /^\d{5,32}$/;

const PAGE_TAKEN_MESSAGE =
  "This Facebook Page is already connected to another WhatsApp Max workspace. " +
  "Disconnect it there first, or choose a different Page.";

interface PageRow {
  page_id: string;
  page_name: string | null;
  subscribed: boolean;
  webhook_verified: boolean;
  last_error: string | null;
  last_synced_at: string | null;
  last_polled_at: string | null;
}

function serializePage(row: PageRow) {
  return {
    pageId: row.page_id,
    pageName: row.page_name,
    subscribed: row.subscribed,
    webhookVerified: row.webhook_verified,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    lastPolledAt: row.last_polled_at,
  };
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [{ data: conn }, { data: pageRows }, capi] = await Promise.all([
      ctx.supabase
        .from("meta_lead_connections")
        .select(
          "dataset_id, meta_user_name, status, last_error, updated_at, access_token",
        )
        .eq("account_id", ctx.accountId)
        .maybeSingle(),
      ctx.supabase
        .from("meta_lead_pages")
        .select(
          "page_id, page_name, subscribed, webhook_verified, last_error, last_synced_at, last_polled_at",
        )
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: true }),
      getConfig(ctx.supabase, ctx.accountId),
    ]);

    const connection = conn as
      | {
          dataset_id: string | null;
          meta_user_name: string | null;
          status: string;
          last_error: string | null;
          updated_at: string;
          access_token: string | null;
        }
      | null;
    const pages = ((pageRows ?? []) as PageRow[]).map(serializePage);

    return NextResponse.json({
      configured: metaLeadAdsConfig() !== null,
      connected: !!connection,
      datasetId: connection?.dataset_id ?? capi?.dataset_id ?? null,
      hasToken: Boolean(connection?.access_token) || Boolean(capi?.access_token),
      tokenSource: connection?.access_token
        ? "manual"
        : capi?.access_token
          ? "capi"
          : null,
      status: connection?.status ?? null,
      lastError: connection?.last_error ?? null,
      updatedAt: connection?.updated_at ?? null,
      page: pages[0] ?? null,
      pages,
      capi: {
        datasetId: capi?.dataset_id ?? null,
        hasToken: Boolean(capi?.access_token),
      },
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
      | { dataset_id?: unknown; access_token?: unknown; page_id?: unknown }
      | null;

    const pageId = trimOrNull(body?.page_id);
    if (!pageId || !ID_PATTERN.test(pageId)) {
      return NextResponse.json(
        { error: "Enter the numeric Facebook Page ID." },
        { status: 400 },
      );
    }

    const suppliedDataset = trimOrNull(body?.dataset_id);
    if (suppliedDataset && !ID_PATTERN.test(suppliedDataset)) {
      return NextResponse.json(
        {
          error:
            "The Dataset/Pixel ID must be the numeric ID shown in Meta Events Manager.",
        },
        { status: 400 },
      );
    }

    const suppliedToken = trimOrNull(body?.access_token);
    if (
      suppliedToken &&
      (suppliedToken.length < 20 || /\s/.test(suppliedToken))
    ) {
      return NextResponse.json(
        {
          error:
            "That does not look like a Meta System User access token (expected a long, whitespace-free value).",
        },
        { status: 400 },
      );
    }

    const [existing, capi] = await Promise.all([
      getConnection(ctx.supabase, ctx.accountId),
      getConfig(ctx.supabase, ctx.accountId),
    ]);

    const datasetId =
      suppliedDataset ?? existing?.dataset_id ?? capi?.dataset_id ?? null;
    if (!datasetId) {
      return NextResponse.json(
        { error: "Enter the Dataset/Pixel ID from Meta Events Manager." },
        { status: 400 },
      );
    }

    let token = suppliedToken;
    let tokenSource: "manual" | "capi" = "manual";
    if (!token) {
      if (existing?.access_token) {
        token = decrypt(existing.access_token);
      } else {
        token = await getDecryptedToken(ctx.supabase, ctx.accountId);
        tokenSource = "capi";
      }
    }
    if (!token) {
      return NextResponse.json(
        {
          error:
            "Paste a Meta System User access token (or save one in the Conversions API tab first).",
        },
        { status: 400 },
      );
    }

    // A Page may back exactly ONE account. Check globally with the
    // service role (RLS only shows this account's rows) before any
    // side effect; the response never identifies the other account.
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

    let connected;
    try {
      connected = await connectPage(ctx.supabase, config, {
        accountId: ctx.accountId,
        token,
        pageId,
        datasetId,
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

    await saveCredentials(ctx.supabase, ctx.accountId, {
      accessToken: token,
      datasetId,
      pageName: connected.pageName,
      connectedBy: ctx.userId,
    });

    const checks = connected.checks ?? [];
    return NextResponse.json({
      ok: checks.every((c) => c.ok),
      datasetId,
      tokenSource,
      checks,
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
