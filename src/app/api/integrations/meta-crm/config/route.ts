// GET /api/integrations/meta-crm/config
// PUT /api/integrations/meta-crm/config
//
// Per-workspace (account) Meta CRM feedback configuration: on/off,
// the selected Meta CRM dataset, and the dedicated Meta CRM access
// token (password input in Settings; stored encrypted, never
// returned). Enabling requires the dataset to belong to this
// account AND pass Meta verification with the dedicated CRM token
// (fail closed — feedback stays disabled otherwise). The Meta Lead
// Ads connection token is never used here.
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  getCrmFeedbackConfig,
  isMissingAccessTokenColumn,
  saveCrmFeedbackConfig,
  toPublicCrmFeedbackConfig,
  TOKEN_STORAGE_MISSING_MESSAGE,
} from "@/lib/meta-crm/feedback";
import { MetaCrmError } from "@/lib/meta-crm/datasets";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = await getCrmFeedbackConfig(ctx.supabase, ctx.accountId);
    // Proactive storage probe: SELECT * tolerates the missing
    // column, so an un-migrated database would otherwise look
    // healthy until the first token save 500s. Flag it so the UI
    // shows guidance instead of a dead token field.
    let tokenMigrationMissing = false;
    try {
      const probe = await ctx.supabase
        .from("meta_crm_config")
        .select("access_token")
        .eq("account_id", ctx.accountId)
        .limit(1);
      if (probe.error) throw probe.error;
    } catch (err) {
      if (isMissingAccessTokenColumn(err)) {
        tokenMigrationMissing = true;
      } else {
        throw err;
      }
    }
    return NextResponse.json({
      ok: true,
      config: toPublicCrmFeedbackConfig(config),
      tokenMigrationMissing,
    });
  } catch (err) {
    // meta_crm_config table missing (migration 175 not applied yet)
    // → honest unconfigured state, not a lie. The dataset registry
    // (migration 174) keeps working independently.
    if ((err as { code?: string })?.code === "42P01") {
      return NextResponse.json({
        ok: true,
        config: toPublicCrmFeedbackConfig(null),
        migrationMissing: true,
      });
    }
    return toErrorResponse(err);
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
    const enabled = body.enabled === true;
    const datasetRowId =
      typeof body.datasetRowId === "string" && body.datasetRowId.trim() !== ""
        ? body.datasetRowId.trim()
        : null;
    // Dedicated CRM token semantics: absent = keep the stored
    // token; "" (with removeAccessToken) = remove it; non-empty =
    // replace it (verified against the dataset before storing).
    // The raw value is never logged or returned.
    const accessToken =
      typeof body.accessToken === "string" ? body.accessToken : undefined;
    const removeAccessToken = body.removeAccessToken === true;
    if (enabled && !datasetRowId) {
      return NextResponse.json(
        { error: "Select a CRM dataset to enable feedback." },
        { status: 400 },
      );
    }

    try {
      const { config, ownershipVerified } = await saveCrmFeedbackConfig(
        ctx.supabase,
        {
          accountId: ctx.accountId,
          enabled,
          datasetRowId,
          actorUserId: ctx.userId,
          accessToken: removeAccessToken ? "" : accessToken,
        },
      );
      return NextResponse.json({
        ok: true,
        ownershipVerified,
        config: toPublicCrmFeedbackConfig(config),
      });
    } catch (err) {
      if (err instanceof MetaCrmError) {
        return NextResponse.json(
          {
            error: err.message,
            code: err.code,
            ...(err.metaCode !== null ? { metaCode: err.metaCode } : {}),
            ...(err.metaSubcode !== null ? { metaSubcode: err.metaSubcode } : {}),
          },
          { status: err.status },
        );
      }
      // Un-migrated database (migration 176 missing): the upsert
      // references access_token and PostgREST rejects it with a
      // plain 42703 object — map it to an actionable 503 instead
      // of the bare "Internal server error".
      if (isMissingAccessTokenColumn(err)) {
        return NextResponse.json(
          { error: TOKEN_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
          { status: 503 },
        );
      }
      throw err;
    }
  } catch (err) {
    if (isMissingAccessTokenColumn(err)) {
      return NextResponse.json(
        { error: TOKEN_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
        { status: 503 },
      );
    }
    return toErrorResponse(err);
  }
}
