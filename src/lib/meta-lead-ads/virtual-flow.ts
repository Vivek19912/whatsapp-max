// ============================================================
// Meta Lead Ads — "virtual flow" materialization.
//
// Each ENABLED Instant Form is surfaced in the existing Workspace
// as a virtual flow: a `flows` row (kind = 'meta_lead_ads') with
// one synthesized `collect_input` node per form question (plus a
// leading "Source" column). The Workspace then derives columns,
// filtering, and editing exactly as it does for a WhatsApp flow —
// no parallel lead UI.
//
// The mapping is pure (`buildVirtualFlowNodes`), so the node/column
// shape is unit-testable without a database. `ensureVirtualFlow`
// idempotently creates/refreshes the flow + nodes.
//
// These flows are status='archived' + trigger_type='manual' so the
// conversational engines (which only pick up ACTIVE keyword /
// first-inbound flows) never dispatch them, while the Workspace
// (which lists every flow) still shows them.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { DEFAULT_FALLBACK_POLICY } from "@/lib/flows/types";

import { sanitizeQuestionKey } from "./normalize";

export const META_SOURCE_COLUMN_KEY = "meta_lead_source";
export const META_SOURCE_COLUMN_LABEL = "Source";

export interface MetaQuestionInput {
  key?: string;
  label?: string;
  type?: string;
}

export interface VirtualFlowNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

/** Coerce the stored `questions` jsonb into a well-formed list. */
export function parseFormQuestions(raw: unknown): MetaQuestionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: MetaQuestionInput[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      out.push({
        key: typeof e.key === "string" ? e.key : undefined,
        label: typeof e.label === "string" ? e.label : undefined,
        type: typeof e.type === "string" ? e.type : undefined,
      });
    }
  }
  return out;
}

/**
 * Build the virtual flow's node list: a leading "Source" column
 * followed by one `collect_input` node per question, chained via
 * `next_node_key` so column derivation walks them in form order.
 * Keys are sanitized + de-duplicated; labels fall back to the raw
 * key. Pure.
 */
export function buildVirtualFlowNodes(questions: MetaQuestionInput[]): {
  nodes: VirtualFlowNode[];
  entryNodeKey: string;
  questionKeys: string[];
} {
  const used = new Set<string>([META_SOURCE_COLUMN_KEY]);
  const nodes: VirtualFlowNode[] = [];

  questions.forEach((q, index) => {
    let key = sanitizeQuestionKey(q.key ?? q.label, index);
    while (used.has(key)) key = `${key}_${index}`;
    used.add(key);
    const label = (q.label ?? q.key ?? key).trim() || key;
    nodes.push({
      node_key: `meta_q_${index}_${key}`,
      node_type: "collect_input",
      config: {
        var_key: key,
        prompt_text: label,
        sheet_column_name: label,
        sheet_include: true,
      },
    });
  });

  const all: VirtualFlowNode[] = [
    {
      node_key: "meta_source_node",
      node_type: "collect_input",
      config: {
        var_key: META_SOURCE_COLUMN_KEY,
        prompt_text: META_SOURCE_COLUMN_LABEL,
        sheet_column_name: META_SOURCE_COLUMN_LABEL,
        sheet_include: true,
      },
    },
    ...nodes,
  ];

  // Chain in order so `orderNodesForSheets` (which follows
  // `outgoingEdges`) yields form order.
  for (let i = 0; i < all.length; i++) {
    const next = i + 1 < all.length ? all[i + 1].node_key : undefined;
    if (next) all[i].config.next_node_key = next;
  }

  return {
    nodes: all,
    entryNodeKey: all[0].node_key,
    questionKeys: all.slice(1).map((n) => n.config.var_key as string),
  };
}

/** Display name for the virtual flow (never a bare UUID). */
export function virtualFlowName(
  formName: string | null | undefined,
  formId: string,
): string {
  const trimmed = (formName ?? "").trim();
  return `Meta Lead Ads · ${trimmed !== "" ? trimmed : formId}`;
}

export interface FormRowForVirtualFlow {
  id: string;
  form_id: string;
  form_name: string | null;
  questions: unknown;
}

/**
 * Idempotently create/refresh the virtual Workspace flow for one
 * form. Returns the flow id. Rewrites the node list from the latest
 * questions (so added/removed questions stay in sync) while leaving
 * existing `flow_runs.vars` untouched — old answers simply stop
 * having a column.
 */
export async function ensureVirtualFlow(
  db: SupabaseClient,
  args: { accountId: string; ownerUserId: string; form: FormRowForVirtualFlow },
): Promise<string> {
  const { accountId, ownerUserId, form } = args;
  const { nodes, entryNodeKey } = buildVirtualFlowNodes(
    parseFormQuestions(form.questions),
  );
  const name = virtualFlowName(form.form_name, form.form_id);

  const { data: existing } = await db
    .from("flows")
    .select("id")
    .eq("meta_form_id", form.id)
    .maybeSingle();

  let flowId = (existing as { id: string } | null)?.id ?? null;

  if (!flowId) {
    const { data: created, error } = await db
      .from("flows")
      .insert({
        user_id: ownerUserId,
        account_id: accountId,
        name,
        description: "Meta Lead Ads Instant Form (auto-generated Workspace source).",
        status: "archived",
        trigger_type: "manual",
        trigger_config: {},
        entry_node_id: entryNodeKey,
        fallback_policy: DEFAULT_FALLBACK_POLICY,
        kind: "meta_lead_ads",
        meta_form_id: form.id,
      })
      .select("id")
      .single();

    if (error || !created) {
      // Concurrent enable — another request created it first.
      if (isUniqueViolation(error)) {
        const { data: raced } = await db
          .from("flows")
          .select("id")
          .eq("meta_form_id", form.id)
          .maybeSingle();
        flowId = (raced as { id: string } | null)?.id ?? null;
      }
      if (!flowId) throw error ?? new Error("Failed to create Meta flow");
    } else {
      flowId = (created as { id: string }).id;
    }
  } else {
    await db
      .from("flows")
      .update({ name, entry_node_id: entryNodeKey, updated_at: new Date().toISOString() })
      .eq("id", flowId);
  }

  // Refresh nodes from the current question set, but ONLY when it
  // actually changed. Rewriting on every inbound lead would race
  // concurrent webhook workers on flow_nodes' UNIQUE (flow_id,
  // node_key); a no-op refresh keeps the hot path cheap and safe.
  // flow_runs reference node_key only as free text, so a rewrite
  // never breaks historical rows.
  const desiredKeys = nodes.map((n) => n.node_key);
  const { data: existingNodes } = await db
    .from("flow_nodes")
    .select("node_key")
    .eq("flow_id", flowId);
  const existingKeys = (existingNodes ?? []).map(
    (n) => (n as { node_key: string }).node_key,
  );
  const unchanged =
    existingKeys.length === desiredKeys.length &&
    desiredKeys.every((key) => existingKeys.includes(key));

  if (!unchanged) {
    if (existingKeys.length > 0) {
      await db.from("flow_nodes").delete().eq("flow_id", flowId);
    }
    if (nodes.length > 0) {
      const { error: nodeErr } = await db.from("flow_nodes").insert(
        nodes.map((n) => ({
          flow_id: flowId,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        })),
      );
      // A concurrent writer that already wrote this exact key set wins
      // the race harmlessly — the desired nodes exist either way.
      if (nodeErr && !isUniqueViolation(nodeErr)) throw nodeErr;
    }
  }

  return flowId;
}
