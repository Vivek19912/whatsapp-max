// POST /api/integrations/meta-crm/datasets/register
//
// Feature 2: register an EXISTING Meta CRM dataset without creating
// anything new in Meta. Verifies identity (GET dataset) and business
// accessibility (GET business) with the caller-supplied token, then
// upserts non-secret metadata into `meta_crm_datasets`.
//
// The token is used once server-side and never persisted, logged, or
// returned. Read access via the token proves authorized access — it
// is NOT claimed as proof of exclusive business ownership.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  MetaCrmError,
  verifyExistingCrmDataset,
} from "@/lib/meta-crm/datasets";
import { saveCrmDataset, toPublicCrmDataset } from "@/lib/meta-crm/store";
import { validateRegisterExistingInput } from "@/lib/meta-crm/validate";

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

    const validation = validateRegisterExistingInput({
      datasetId: typeof body.datasetId === "string" ? body.datasetId : null,
      businessPortfolioId:
        typeof body.businessPortfolioId === "string" ? body.businessPortfolioId : null,
      accessToken: typeof body.accessToken === "string" ? body.accessToken : null,
      datasetName: typeof body.datasetName === "string" ? body.datasetName : null,
    });
    if (!validation.ok || !validation.values) {
      return NextResponse.json(
        { error: "Check the highlighted fields.", fieldErrors: validation.fieldErrors },
        { status: 400 },
      );
    }

    const { datasetId, businessPortfolioId, accessToken, datasetName } =
      validation.values;

    try {
      const verified = await verifyExistingCrmDataset({
        datasetId,
        businessPortfolioId,
        accessToken,
        expectedName: datasetName,
      });

      const saved = await saveCrmDataset(ctx.supabase, {
        accountId: ctx.accountId,
        businessPortfolioId: verified.businessId ?? businessPortfolioId,
        datasetId: verified.id,
        datasetName: verified.name,
        datasetType: "CRM",
        creationStatus: "Registered",
        createdBy: ctx.userId,
      });

      return NextResponse.json({
        ok: true,
        stored: true,
        ownershipVerified: verified.ownershipVerified,
        verificationNote: verified.ownershipVerified
          ? "Dataset found under this Business Portfolio."
          : "Dataset is accessible with this token. This proves authorized access, not exclusive business ownership.",
        dataset: toPublicCrmDataset(saved.row),
      });
    } catch (err) {
      if (err instanceof MetaCrmError) {
        console.error("[meta-crm] dataset registration failed:", {
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
