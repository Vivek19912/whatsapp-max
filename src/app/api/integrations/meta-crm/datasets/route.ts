// POST /api/integrations/meta-crm/datasets
// GET  /api/integrations/meta-crm/datasets
//
// Feature 1 + 2: Create a Meta CRM Dataset via the Business Dataset API
// and persist its non-secret metadata in `meta_crm_datasets`.
//   POST https://graph.facebook.com/v27.0/{BUSINESS_ID}/ads_dataset
//   Authorization: Bearer {user token}, name + is_crm=true
//
// Backend-only: the user-entered token is used for this single Meta
// call and never persisted, logged, or returned. On Meta success the
// metadata is inserted (idempotent on (account_id, dataset_id)); if
// the insert fails the Meta ID is still returned with stored:false
// so the caller can retry via the register endpoint WITHOUT another
// Meta POST (which could create a duplicate).
//
// This is a NEW, independent Instant Form CRM Integration feature.
// It does NOT reuse the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { MetaCrmError, createCrmDataset } from "@/lib/meta-crm/datasets";
import { listCrmDatasets, saveCrmDataset, toPublicCrmDataset } from "@/lib/meta-crm/store";
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

      // Persist non-secret metadata. A duplicate (same account +
      // dataset) resolves to the existing row — idempotent.
      try {
        const saved = await saveCrmDataset(ctx.supabase, {
          accountId: ctx.accountId,
          businessPortfolioId,
          datasetId: created.id,
          datasetName: created.name,
          datasetType: "CRM",
          creationStatus: "Created",
          createdBy: ctx.userId,
        });
        return NextResponse.json({
          ok: true,
          stored: true,
          dataset: {
            ...toPublicCrmDataset(saved.row),
            businessPortfolioId,
          },
        });
      } catch (saveErr) {
        // Meta succeeded but the local insert failed: preserve the
        // real Meta ID and let the caller retry via the register
        // endpoint — NEVER another Meta POST.
        console.error("[meta-crm] dataset save failed:", {
          accountId: ctx.accountId,
          datasetId: created.id,
          saveError:
            saveErr instanceof Error ? saveErr.message.slice(0, 200) : String(saveErr).slice(0, 200),
        });
        return NextResponse.json({
          ok: true,
          stored: false,
          saveError:
            "Dataset was created in Meta but could not be saved locally. Use “Add Existing” with the ID below to save it without creating another dataset.",
          dataset: {
            id: `pending-${created.id}`,
            datasetId: created.id,
            datasetName: created.name,
            businessPortfolioId,
            datasetType: "CRM",
            creationStatus: "Created",
            createdAt: new Date().toISOString(),
          },
        });
      }
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

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await listCrmDatasets(ctx.supabase, ctx.accountId, 100);
    return NextResponse.json({
      ok: true,
      datasets: rows.map(toPublicCrmDataset),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
