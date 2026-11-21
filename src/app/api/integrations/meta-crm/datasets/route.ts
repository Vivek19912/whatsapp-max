// POST /api/integrations/meta-crm/datasets
//
// Feature 1: Create a Meta CRM Dataset via the Business Dataset API.
//   POST https://graph.facebook.com/v27.0/{BUSINESS_ID}/ads_dataset
//   Authorization: Bearer {user token}, name + is_crm=true
//
// Backend-only: the user-entered token is used for this single Meta
// call and never persisted, logged, or returned. Non-secret metadata
// (id/name/business id) is returned to the caller for display and
// future CRM features. No automatic retry — an uncertain response is
// surfaced, never replayed (it may have created a duplicate).
//
// This is a NEW, independent Instant Form CRM Integration feature.
// It does NOT reuse the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { MetaCrmError, createCrmDataset } from "@/lib/meta-crm/datasets";
import { validateCrmDatasetInput } from "@/lib/meta-crm/validate";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const validation = validateCrmDatasetInput({
      datasetName:
        typeof body.datasetName === "string" ? body.datasetName : null,
      businessPortfolioId:
        typeof body.businessPortfolioId === "string"
          ? body.businessPortfolioId
          : null,
      accessToken:
        typeof body.accessToken === "string" ? body.accessToken : null,
    });
    if (!validation.ok || !validation.values) {
      return NextResponse.json(
        { error: "Check the highlighted fields.", fieldErrors: validation.fieldErrors },
        { status: 400 },
      );
    }

    const { datasetName, businessPortfolioId, accessToken } = validation.values;

    try {
      const created = await createCrmDataset({
        businessPortfolioId,
        datasetName,
        accessToken,
      });
      return NextResponse.json({
        ok: true,
        dataset: {
          id: created.id,
          name: created.name,
          businessPortfolioId,
          type: "CRM",
          status: "Created",
        },
      });
    } catch (err) {
      if (err instanceof MetaCrmError) {
        // Safe to log: no tokens, only account + Meta diagnostics.
        console.error("[meta-crm] dataset creation failed:", {
          accountId: ctx.accountId,
          code: err.code,
          metaCode: err.metaCode,
          metaSubcode: err.metaSubcode,
          status: err.status,
        });
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
