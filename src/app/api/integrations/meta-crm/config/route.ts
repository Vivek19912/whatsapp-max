// GET /api/integrations/meta-crm/config
// PUT /api/integrations/meta-crm/config
//
// Per-workspace (account) Meta CRM feedback configuration: on/off
// plus the selected Meta CRM dataset. Enabling requires the
// dataset to belong to this account AND pass Meta ownership
// verification with the workspace's stored Meta connection
// (fail closed — feedback stays disabled otherwise).
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  getCrmFeedbackConfig,
  saveCrmFeedbackConfig,
  toPublicCrmFeedbackConfig,
} from "@/lib/meta-crm/feedback";
import { MetaCrmError } from "@/lib/meta-crm/datasets";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = await getCrmFeedbackConfig(ctx.supabase, ctx.accountId);
    return NextResponse.json({
      ok: true,
      config: toPublicCrmFeedbackConfig(config),
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
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
