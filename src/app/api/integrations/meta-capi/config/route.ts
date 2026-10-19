// /api/integrations/meta-capi/config
//
// GET    — the customer's CAPI configuration (token never returned).
// PUT    — store the dataset id / access token / test event code /
//          action source / wizard step. When a dataset + token are
//          both present we VERIFY them against Meta before marking the
//          integration connected; a bad pair is stored as 'error' with
//          a safe message and reported to the caller.
// DELETE — forget the stored credentials (event mappings are kept).

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { isValidActionSource } from "@/lib/meta-capi/catalog";
import { validateDataset } from "@/lib/meta-capi/client";
import { toPublicConfig } from "@/lib/meta-capi/serialize";
import {
  clearCredentials,
  clearToken,
  getConfig,
  getDecryptedToken,
  markConfigStatus,
  saveActionSource,
  saveDataset,
  saveSetupStep,
  saveTestEventCode,
  saveToken,
} from "@/lib/meta-capi/store";
import { metaCapiPlatform } from "@/lib/meta-capi/triggers";
import { MetaLeadAdsError } from "@/lib/meta-lead-ads/errors";
import { metaErrorResponse } from "@/lib/meta-lead-ads/error-response";

const DATASET_ID_PATTERN = /^\d{5,32}$/;
const TEST_CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export async function GET() {
  try {
    const ctx = await requireRole("admin");
    const config = await getConfig(ctx.supabase, ctx.accountId);
    return NextResponse.json({ config: toPublicConfig(config) });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    if (has("action_source")) {
      if (
        typeof body.action_source !== "string" ||
        !isValidActionSource(body.action_source)
      ) {
        return NextResponse.json(
          { error: "Choose a valid action source." },
          { status: 400 },
        );
      }
      await saveActionSource(ctx.supabase, ctx.accountId, body.action_source);
    }

    if (has("setup_step")) {
      const step = Number(body.setup_step);
      if (!Number.isInteger(step) || step < 1 || step > 5) {
        return NextResponse.json(
          { error: "Invalid setup step." },
          { status: 400 },
        );
      }
      await saveSetupStep(ctx.supabase, ctx.accountId, step);
    }

    if (has("test_event_code")) {
      const code = body.test_event_code;
      if (code !== null && (typeof code !== "string" || !TEST_CODE_PATTERN.test(code))) {
        return NextResponse.json(
          { error: "A Test Event Code is letters/numbers only." },
          { status: 400 },
        );
      }
      await saveTestEventCode(
        ctx.supabase,
        ctx.accountId,
        typeof code === "string" ? code : null,
      );
    }

    if (has("dataset_id")) {
      const raw = body.dataset_id;
      if (typeof raw !== "string" || !DATASET_ID_PATTERN.test(raw.trim())) {
        return NextResponse.json(
          {
            error:
              "The Dataset/Pixel ID must be the numeric ID shown in Events Manager.",
          },
          { status: 400 },
        );
      }
      await saveDataset(ctx.supabase, ctx.accountId, raw.trim());
    }

    if (has("access_token")) {
      const raw = body.access_token;
      if (raw === null) {
        await clearToken(ctx.supabase, ctx.accountId);
      } else {
        if (typeof raw !== "string") {
          return NextResponse.json(
            { error: "The access token must be text." },
            { status: 400 },
          );
        }
        const token = raw.trim();
        if (token.length < 20 || /\s/.test(token)) {
          return NextResponse.json(
            { error: "That does not look like a Conversions API access token." },
            { status: 400 },
          );
        }
        await saveToken(ctx.supabase, ctx.accountId, token);
      }
    }

    // Verify once both halves exist.
    const config = await getConfig(ctx.supabase, ctx.accountId);
    if (config?.dataset_id && config?.access_token) {
      const platform = metaCapiPlatform();
      if (!platform) {
        return NextResponse.json(
          {
            error: "Meta is not configured on this server.",
            code: "not_configured",
          },
          { status: 501 },
        );
      }
      try {
        const token = await getDecryptedToken(ctx.supabase, ctx.accountId);
        if (!token) {
          throw new MetaLeadAdsError("not_configured", "No token is stored.", 400);
        }
        const info = await validateDataset(platform, config.dataset_id, token);
        await markConfigStatus(ctx.supabase, ctx.accountId, "connected", null);
        const fresh = await getConfig(ctx.supabase, ctx.accountId);
        return NextResponse.json({
          ok: true,
          datasetName: info.name ?? null,
          config: toPublicConfig(fresh),
        });
      } catch (err) {
        const message =
          err instanceof MetaLeadAdsError
            ? err.message
            : "Could not verify these details with Meta.";
        await markConfigStatus(ctx.supabase, ctx.accountId, "error", message);
        return NextResponse.json(
          { error: message, code: "verification_failed" },
          { status: 400 },
        );
      }
    }

    const fresh = await getConfig(ctx.supabase, ctx.accountId);
    return NextResponse.json({ ok: true, config: toPublicConfig(fresh) });
  } catch (err) {
    return metaErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole("admin");
    await clearCredentials(ctx.supabase, ctx.accountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return metaErrorResponse(err);
  }
}
