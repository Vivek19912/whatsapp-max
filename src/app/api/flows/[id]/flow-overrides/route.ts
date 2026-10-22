import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  buildFlowTableColumns,
} from "@/lib/flows/flow-tables";
import { isRunOwnedByUser } from "@/lib/flows/workspace-ownership";
import type { FlowNodeLite } from "@/lib/flows/sheet-columns";

/**
 * Agents on Meta Lead Ads Tables may only touch their own assigned
 * leads. Owners/admins/viewers and every Flow Table keep existing
 * behavior. Missing ownership reads as not-found (same shape as a
 * foreign run — never an existence oracle).
 */
async function assertAgentMayTouchRun(args: {
  supabase: SupabaseClient;
  accountId: string;
  flow: { id: string; kind?: string | null };
  runId: string;
  userId: string;
  role: string;
}): Promise<NextResponse | null> {
  const { supabase, accountId, flow, runId, userId, role } = args;
  if (role !== "agent" || flow.kind !== "meta_lead_ads") return null;
  const owned = await isRunOwnedByUser(supabase, {
    accountId,
    flowId: flow.id,
    runId,
    userId,
  });
  if (!owned) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
  return null;
}

export const dynamic = "force-dynamic";

/**
 * Workspace flow-answer overrides — agent edits to flow-derived
 * table cells WITHOUT touching the original submission.
 *
 * PUT    { flow_run_id, field_key, value } — set one Workspace
 *        override. `value: null` (or "") stores an EXPLICIT EMPTY
 *        override: the cell renders blank and stays blank (it does
 *        NOT fall back to the original). Saving a value equal to
 *        the original deletes any override instead (treated as
 *        unchanged — no junk rows).
 * DELETE { flow_run_id, field_key } — remove the override
 *        ("Restore original"); the cell shows the original flow
 *        answer again.
 *
 * Agent+ (operational data). flow_runs.vars, workspace_fields,
 * workspace_values, Sheets, and history are never touched — only
 * workspace_flow_overrides rows. The flow question keeps its
 * identity (var_key/node_key — never the display label); unknown
 * keys and system columns are rejected, and select answers must
 * be one of the question's own options.
 */

async function loadFlowAccount(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data: flow, error } = await supabase
    .from("flows")
    .select("id, account_id, entry_node_id, kind")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  const typed = flow as {
    id: string;
    account_id: string;
    entry_node_id?: string | null;
    kind?: string | null;
  } | null;
  if (!typed || typed.account_id !== accountId) return null;
  return typed;
}

interface OverrideTarget {
  runVars: Record<string, unknown>;
  answerKeys: Set<string>;
  optionsByKey: Map<string, string[]>;
}

function textOrNull(value: unknown): string | null {
  // Mirrors textValue() in the Travel CRM lead loader: strings pass
  // through verbatim (even ""), finite numbers/booleans stringify,
  // everything else is unusable. No trimming, no length caps — the
  // agent's exact input is preserved, like workspace_values.
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  return null;
}

/**
 * Load + validate the override target: the run must belong to
 * this (account, flow), and the key must be a current
 * flow-derived answer column (system columns and unknown keys
 * are rejected — WhatsApp Name stays sourced from contacts).
 */
async function loadTarget(
  supabase: SupabaseClient,
  accountId: string,
  flow: { id: string; entry_node_id?: string | null },
  runId: string,
  fieldKey: unknown,
): Promise<
  | { ok: true; target: OverrideTarget }
  | { ok: false; response: NextResponse }
> {
  if (typeof fieldKey !== "string" || fieldKey.trim() === "") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "field_key is required." },
        { status: 400 },
      ),
    };
  }
  const key = fieldKey;
  const { data: run, error: runErr } = await supabase
    .from("flow_runs")
    .select("id, account_id, flow_id, vars")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  const typed = run as {
    account_id: string;
    flow_id: string;
    vars: unknown;
  } | null;
  if (!typed || typed.account_id !== accountId || typed.flow_id !== flow.id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Run not found." },
        { status: 404 },
      ),
    };
  }
  const { data: nodeRows, error: nodesErr } = await supabase
    .from("flow_nodes")
    .select("node_key, node_type, config, created_at")
    .eq("flow_id", flow.id);
  if (nodesErr) throw nodesErr;
  const nodes: FlowNodeLite[] = ((nodeRows ?? []) as Array<Record<string, unknown>>).map(
    (n) => ({
      node_key: typeof n.node_key === "string" ? n.node_key : "",
      node_type: typeof n.node_type === "string" ? n.node_type : "",
      config: (n.config ?? {}) as Record<string, unknown>,
      created_at: typeof n.created_at === "string" ? n.created_at : null,
    }),
  );
  const { columns, answerKeys } = buildFlowTableColumns(
    nodes,
    flow.entry_node_id ?? null,
  );
  if (!answerKeys.includes(key)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unknown field for this flow." },
        { status: 400 },
      ),
    };
  }
  const optionsByKey = new Map<string, string[]>();
  for (const c of columns) {
    if (!c.system && c.options && c.options.length > 0) {
      optionsByKey.set(c.key, c.options);
    }
  }
  const vars =
    typed.vars && typeof typed.vars === "object"
      ? (typed.vars as Record<string, unknown>)
      : {};
  return {
    ok: true,
    target: { runVars: vars, answerKeys: new Set(answerKeys), optionsByKey },
  };
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const flow = await loadFlowAccount(supabase, accountId, id);
    if (!flow) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { flow_run_id: runId, field_key: fieldKey, value } = body;
    if (typeof runId !== "string" || !runId) {
      return NextResponse.json({ error: "flow_run_id is required." }, { status: 400 });
    }
    const loaded = await loadTarget(supabase, accountId, flow, runId, fieldKey);
    if (!loaded.ok) return loaded.response;
    const forbidden = await assertAgentMayTouchRun({
      supabase,
      accountId,
      flow,
      runId,
      userId,
      role,
    });
    if (forbidden) return forbidden;
    const { target } = loaded;
    const key = fieldKey as string;

    // Normalize: "" becomes an explicit NULL (cleared cell, still
    // an override — distinct from having no override at all).
    const normalized =
      value === null || value === undefined || value === ""
        ? null
        : textOrNull(value);
    if (normalized === null && value !== null && value !== undefined && value !== "") {
      return NextResponse.json({ error: "Invalid value." }, { status: 400 });
    }
    // Select answers must stay within the question's own options
    // (null always clears); free-text answers accept anything.
    const options = target.optionsByKey.get(key);
    if (normalized !== null && options && !options.includes(normalized)) {
      return NextResponse.json(
        { error: `Invalid option. Choose one of: ${options.join(", ")}.` },
        { status: 400 },
      );
    }

    // Original value from the authoritative submission record
    // (blank normalized like the incoming value for comparison).
    const originalRaw = key in target.runVars ? target.runVars[key] : undefined;
    const originalText = textOrNull(originalRaw);
    const originalNormalized = originalText === "" ? null : originalText;
    // Equal-to-original counts as unchanged: drop any override
    // instead of storing a redundant copy of the answer.
    if (normalized === originalNormalized) {
      await supabase
        .from("workspace_flow_overrides")
        .delete()
        .eq("account_id", accountId)
        .eq("flow_id", id)
        .eq("flow_run_id", runId)
        .eq("field_key", key);
      return NextResponse.json({ value: originalNormalized });
    }

    const { data, error } = await supabase
      .from("workspace_flow_overrides")
      .upsert(
        {
          account_id: accountId,
          flow_id: id,
          flow_run_id: runId,
          field_key: key,
          value_text: normalized,
        },
        { onConflict: "account_id,flow_id,flow_run_id,field_key" },
      )
      .select("value_text")
      .single();
    if (error) throw error;
    return NextResponse.json({
      value: (data as { value_text: string | null }).value_text,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId, role } = await requireRole("agent");
    const flow = await loadFlowAccount(supabase, accountId, id);
    if (!flow) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { flow_run_id: runId, field_key: fieldKey } = body;
    if (typeof runId !== "string" || !runId) {
      return NextResponse.json({ error: "flow_run_id is required." }, { status: 400 });
    }
    const loaded = await loadTarget(supabase, accountId, flow, runId, fieldKey);
    if (!loaded.ok) return loaded.response;
    const forbidden = await assertAgentMayTouchRun({
      supabase,
      accountId,
      flow,
      runId,
      userId,
      role,
    });
    if (forbidden) return forbidden;
    const key = fieldKey as string;
    const { error } = await supabase
      .from("workspace_flow_overrides")
      .delete()
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .eq("flow_run_id", runId)
      .eq("field_key", key);
    if (error) throw error;
    // Display falls back to the original flow answer (unchanged).
    const originalRaw = key in loaded.target.runVars ? loaded.target.runVars[key] : undefined;
    const original = textOrNull(originalRaw);
    return NextResponse.json({ value: original === "" ? null : original });
  } catch (err) {
    return toErrorResponse(err);
  }
}
