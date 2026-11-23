// DELETE /api/integrations/meta-crm/datasets/[id]
//
// Remove ONE dataset registration from WhatsApp Max (local-only).
// This NEVER touches Meta: no Graph API call of any kind is made
// here — no delete endpoint, no dataset removal, no token use, no
// event modification. The Meta dataset and its events keep
// existing normally in Meta Events Manager.
//
// Safety rules:
//   * Admin-only writes (members may still list); rows are scoped
//     to the caller's account (RLS + explicit account_id filter),
//     so no workspace can remove another's registration.
//   * A dataset currently selected by an ENABLED CRM Feedback
//     config cannot be removed (409): the owner must disable
//     feedback (or point it at another dataset) first, so active
//     sending can never break silently. Matching is by internal
//     row id, falling back to the configured dataset_id.
//   * Pending/queued event rows and sent history are never touched:
//     they keep their stored Meta dataset ids for auditing, and
//     the drain only ever sends through the currently configured
//     dataset (which a removal can no longer be).
//   * Re-registering the same Meta dataset later (Add Existing CRM
//     Dataset) inserts a fresh row — nothing in Meta is duplicated.

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Dataset id is required." }, { status: 400 });
    }
    const ctx = await requireRole("admin");
    const { supabase, accountId } = ctx;

    const { data: row, error: loadErr } = await supabase
      .from("meta_crm_datasets")
      .select("id, account_id, dataset_id, dataset_name, business_portfolio_id")
      .eq("account_id", accountId)
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!row) {
      // Unknown id or another workspace's row: indistinguishable by
      // design (never an existence oracle for other tenants).
      return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
    }
    const target = row as {
      id: string;
      dataset_id: unknown;
      dataset_name: unknown;
    };

    // Guard the live CRM Feedback selection: an enabled config
    // pointing at this dataset blocks removal until the owner
    // disables feedback or selects another dataset.
    const { data: config, error: configErr } = await supabase
      .from("meta_crm_config")
      .select("enabled, dataset_ref, dataset_id")
      .eq("account_id", accountId)
      .maybeSingle();
    if (configErr) throw configErr;
    const cfg = config as {
      enabled?: unknown;
      dataset_ref?: unknown;
      dataset_id?: unknown;
    } | null;
    const selectedId =
      typeof cfg?.dataset_id === "string" && cfg.dataset_id.trim() !== ""
        ? cfg.dataset_id
        : null;
    const inUse =
      cfg?.enabled === true &&
      (cfg?.dataset_ref === target.id ||
        (selectedId !== null &&
          typeof target.dataset_id === "string" &&
          target.dataset_id === selectedId));
    if (inUse) {
      return NextResponse.json(
        {
          error:
            "This dataset is currently used by CRM Feedback. Disable CRM feedback (or select a different dataset) before removing it.",
          code: "dataset_in_use",
        },
        { status: 409 },
      );
    }

    // Local-only delete: no Meta call exists on this path by
    // construction (no datasets.* import, no fetch).
    const { error: deleteErr } = await supabase
      .from("meta_crm_datasets")
      .delete()
      .eq("account_id", accountId)
      .eq("id", target.id);
    if (deleteErr) throw deleteErr;

    return NextResponse.json({
      ok: true,
      removed: { id: target.id, datasetId: target.dataset_id ?? null },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
