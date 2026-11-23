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
  isMissingConfigColumn,
  saveCrmFeedbackConfig,
  TABLES_STORAGE_MISSING_MESSAGE,
  toPublicCrmFeedbackConfig,
  TOKEN_STORAGE_MISSING_MESSAGE,
} from "@/lib/meta-crm/feedback";
import { MetaCrmError } from "@/lib/meta-crm/datasets";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = await getCrmFeedbackConfig(ctx.supabase, ctx.accountId);
    // Proactive storage probes: SELECT * tolerates missing columns,
    // so an un-migrated database would otherwise look healthy until
    // the first token save 500s. Flag each gap so the UI shows
    // guidance instead of dead controls.
    let tokenMigrationMissing = false;
    let autoSendMigrationMissing = false;
    let showLeadQualityMigrationMissing = false;
    let tablesMigrationMissing = false;
    for (const column of ["access_token", "auto_send_lead", "show_lead_quality", "allowed_flow_ids"] as const) {
      try {
        const probe = await ctx.supabase
          .from("meta_crm_config")
          .select(column)
          .eq("account_id", ctx.accountId)
          .limit(1);
        if (probe.error) throw probe.error;
      } catch (err) {
        if (isMissingConfigColumn(err, column)) {
          if (column === "access_token") tokenMigrationMissing = true;
          else if (column === "auto_send_lead") autoSendMigrationMissing = true;
          else if (column === "show_lead_quality") showLeadQualityMigrationMissing = true;
          else tablesMigrationMissing = true;
        } else {
          throw err;
        }
      }
    }
    return NextResponse.json({
      ok: true,
      config: toPublicCrmFeedbackConfig(config),
      tokenMigrationMissing,
      autoSendMigrationMissing,
      showLeadQualityMigrationMissing,
      tablesMigrationMissing,
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
    const autoSendLead = typeof body.autoSendLead === "boolean" ? body.autoSendLead : undefined;
    const showLeadQuality = typeof body.showLeadQuality === "boolean" ? body.showLeadQuality : undefined;
    // Table allowlist: omitted = preserve the stored selection;
    // an explicit array (even empty) replaces it after ownership
    // validation in saveCrmFeedbackConfig.
    const allowedFlowIds =
      body.allowedFlowIds === undefined
        ? undefined
        : Array.isArray(body.allowedFlowIds)
          ? body.allowedFlowIds
          : null;
    if (allowedFlowIds === null) {
      return NextResponse.json(
        { error: "allowedFlowIds must be an array of Workspace table ids." },
        { status: 400 },
      );
    }
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
          autoSendLead,
          showLeadQuality,
          allowedFlowIds,
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
      // Un-migrated database (migrations 176–178 or 183 missing):
      // the upsert references the new columns and PostgREST
      // rejects them with a plain 42703 object — map it to an
      // actionable 503 instead of the bare "Internal server error".
      if (
        isMissingAccessTokenColumn(err) ||
        isMissingConfigColumn(err, "auto_send_lead") ||
        isMissingConfigColumn(err, "show_lead_quality")
      ) {
        return NextResponse.json(
          { error: TOKEN_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
          { status: 503 },
        );
      }
      if (isMissingConfigColumn(err, "allowed_flow_ids")) {
        return NextResponse.json(
          { error: TABLES_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
          { status: 503 },
        );
      }
      throw err;
    }
  } catch (err) {
    if (
      isMissingAccessTokenColumn(err) ||
      isMissingConfigColumn(err, "auto_send_lead") ||
      isMissingConfigColumn(err, "show_lead_quality")
    ) {
      return NextResponse.json(
        { error: TOKEN_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
        { status: 503 },
      );
    }
    if (isMissingConfigColumn(err, "allowed_flow_ids")) {
      return NextResponse.json(
        { error: TABLES_STORAGE_MISSING_MESSAGE, code: "migration_missing" },
        { status: 503 },
      );
    }
    return toErrorResponse(err);
  }
}
