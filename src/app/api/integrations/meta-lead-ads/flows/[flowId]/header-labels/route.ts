import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  META_HEADER_LABEL_MAX,
  metaHeaderLabelKey,
  normalizeHeaderLabel,
} from "@/lib/meta-lead-ads/header-labels";
import { META_SOURCE_COLUMN_KEY } from "@/lib/meta-lead-ads/virtual-flow";

/**
 * Custom header names for one Meta Lead Ads table.
 *
 *   GET — every override as { "flow:<column_key>": "Custom Name" }.
 *         Any account member. Defaults are NOT stored (they resolve
 *         from the Instant Form questions), so new imports can never
 *         disturb labels.
 *   PUT — { column_key, label } upserts one override (agent+);
 *         { column_key, label: null } deletes it (restore original).
 *         Labels validate as non-blank text; keys must be current
 *         Instant Form question columns of this Meta table.
 *
 * Meta-only by construction: the flow must belong to the caller's
 * account AND be a virtual Meta Lead Ads table (kind =
 * 'meta_lead_ads'). Flow Tables can never read or write here —
 * they 404 exactly like a foreign flow. Stored answers, field
 * mappings, lead records, and API values are never touched; only
 * the rendered header text changes.
 */

const COLUMN_KEY_MAX = 120;

async function loadMetaFlowAccount(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data: flow, error } = await supabase
    .from("flows")
    .select("id, account_id, kind")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  const typed = flow as {
    id: string;
    account_id: string;
    kind?: string | null;
  } | null;
  if (
    !typed ||
    typed.account_id !== accountId ||
    typed.kind !== "meta_lead_ads"
  ) {
    return null;
  }
  return typed;
}

/** Current Instant Form question column keys for one Meta table. */
async function questionColumnKeys(
  supabase: SupabaseClient,
  flowId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("flow_nodes")
    .select("node_type, config")
    .eq("flow_id", flowId);
  if (error) throw error;
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{
    node_type: string;
    config?: unknown;
  }>) {
    if (row.node_type !== "collect_input") continue;
    const varKey = (row.config as Record<string, unknown> | null)?.var_key;
    if (typeof varKey === "string" && varKey !== "" && varKey !== META_SOURCE_COLUMN_KEY) {
      keys.add(varKey);
    }
  }
  return keys;
}

function toLabels(
  rows: Array<{ column_key: string; label: string }>,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.column_key === "string" && typeof row.label === "string") {
      labels[row.column_key] = row.label;
    }
  }
  return labels;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  try {
    const { flowId } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    if (!(await loadMetaFlowAccount(supabase, accountId, flowId))) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("meta_lead_header_labels")
      .select("column_key, label")
      .eq("account_id", accountId)
      .eq("flow_id", flowId);
    if (error) throw error;
    return NextResponse.json({
      labels: toLabels(
        (data ?? []) as Array<{ column_key: string; label: string }>,
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  try {
    const { flowId } = await params;
    const { supabase, accountId } = await requireRole("agent");
    if (!(await loadMetaFlowAccount(supabase, accountId, flowId))) {
      return NextResponse.json({ error: "Table not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { column_key: rawKey, label: rawLabel } = body;
    if (
      typeof rawKey !== "string" ||
      rawKey.trim() === "" ||
      rawKey.trim().length > COLUMN_KEY_MAX
    ) {
      return NextResponse.json(
        { error: "column_key is required." },
        { status: 400 },
      );
    }
    const columnKey = rawKey.trim();

    // Restoring the original name deletes the override. A missing
    // label is a client bug (400); empty or whitespace-only text is
    // invalid (400) — only an explicit null restores.
    if (rawLabel === undefined) {
      return NextResponse.json(
        { error: "label is required (null restores the original)." },
        { status: 400 },
      );
    }
    if (rawLabel === null) {
      const { error } = await supabase
        .from("meta_lead_header_labels")
        .delete()
        .eq("account_id", accountId)
        .eq("flow_id", flowId)
        .eq("column_key", metaHeaderLabelKey(columnKey));
      if (error) throw error;
      return NextResponse.json({
        column_key: columnKey,
        label: null,
      });
    }

    let label: string;
    try {
      label = normalizeHeaderLabel(rawLabel);
    } catch {
      return NextResponse.json(
        {
          error: `label must be 1-${META_HEADER_LABEL_MAX} non-blank characters.`,
        },
        { status: 400 },
      );
    }

    // Only currently-rendered Instant Form question columns may be
    // renamed — never system headers, the Source column, or keys
    // from another form. The stored key stays stable while the
    // question text may evolve; new imports keep their mappings.
    const questionKeys = await questionColumnKeys(supabase, flowId);
    if (!questionKeys.has(columnKey)) {
      return NextResponse.json(
        { error: "Unknown column for this form." },
        { status: 400 },
      );
    }

    const storageKey = metaHeaderLabelKey(columnKey);
    const { error } = await supabase.from("meta_lead_header_labels").upsert(
      {
        account_id: accountId,
        flow_id: flowId,
        column_key: storageKey,
        label,
      },
      { onConflict: "account_id,flow_id,column_key" },
    );
    if (error) throw error;
    return NextResponse.json({ column_key: columnKey, label });
  } catch (err) {
    return toErrorResponse(err);
  }
}
