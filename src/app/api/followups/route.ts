import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import {
  isFollowupStatus,
  normalizeAgentWhatsappNumber,
  validateFollowupInput,
  type Followup,
  type FollowupCreator,
  type FollowupWorkspaceContext,
} from "@/lib/followups/types";

function toFollowup(row: Record<string, unknown>): Followup {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    recipient_phone: (row.recipient_phone as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    scheduled_for: row.scheduled_for as string,
    message_text: row.message_text as string,
    template_name: (row.template_name as string | null) ?? null,
    template_language: (row.template_language as string | null) ?? null,
    status: row.status as Followup["status"],
    attempts: (row.attempts as number) ?? 0,
    whatsapp_message_id: (row.whatsapp_message_id as string | null) ?? null,
    message_id: (row.message_id as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
    read_at: (row.read_at as string | null) ?? null,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
    failed_at: (row.failed_at as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    // Optional origin columns: NULL on pre-migration schemas —
    // never assumed present.
    source_kind: (row.source_kind as string | null) ?? null,
    source_run_id: (row.source_run_id as string | null) ?? null,
    recipient_custom:
      typeof row.recipient_custom === "boolean" ? row.recipient_custom : null,
  };
}

const DISPLAY_VIEWS = [
  "all",
  "scheduled",
  "processing",
  "sent",
  "delivered",
  "read",
  "failed",
  "cancelled",
] as const;

type FollowupView = (typeof DISPLAY_VIEWS)[number];

function isFollowupView(value: unknown): value is FollowupView {
  return (
    typeof value === "string" &&
    (DISPLAY_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Apply one display-state filter. Delivered/Read are receipt-derived
 * (never separate DB statuses): delivered = sent + delivered_at set
 * + read_at unset; read = sent + read_at set; bare sent excludes
 * both, so Meta acceptance is never mislabeled as delivery.
 */
interface StatusFilterable {
  eq(col: string, val: unknown): unknown;
  is(col: string, val: null): unknown;
  not(col: string, op: string, val: unknown): unknown;
}

function applyViewFilter<Q extends StatusFilterable>(
  query: Q,
  view: FollowupView,
): Q {
  switch (view) {
    case "all":
      return query;
    case "delivered":
      query.eq("status", "sent");
      query.not("delivered_at", "is", null);
      query.is("read_at", null);
      return query;
    case "read":
      query.eq("status", "sent");
      query.not("read_at", "is", null);
      return query;
    case "sent":
      query.eq("status", "sent");
      query.is("delivered_at", null);
      query.is("read_at", null);
      return query;
    default:
      query.eq("status", view);
      return query;
  }
}

/**
 * Load the creating agent's stored WhatsApp number
 * (`profiles.whatsapp_number`) and normalize it to the canonical
 * digits-only form Meta expects. Returns null when the agent has
 * no (or no valid) stored number — and also when the column does
 * not exist yet (pre-migration schema): both cases fail closed at
 * the caller, never substituting another number.
 */
async function loadAgentRecipientPhone(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("whatsapp_number")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeAgentWhatsappNumber(
    (data as { whatsapp_number?: unknown }).whatsapp_number,
  );
}

/**
 * Resolve creator profiles for the listed rows in ONE batched query
 * (no N+1). Only profiles behind rows the caller is already
 * authorized to see are resolved; email stays admin+ only,
 * mirroring the members roster rule.
 */
async function loadCreators(
  supabase: SupabaseClient,
  accountId: string,
  rows: Record<string, unknown>[],
  includeEmail: boolean,
): Promise<Record<string, FollowupCreator>> {
  const ids = [
    ...new Set(
      rows.map((r) => r.created_by).filter((v): v is string => typeof v === "string"),
    ),
  ];
  if (ids.length === 0) return {};
  const { data } = await supabase
    .from("profiles")
    .select("user_id, full_name, email, account_role")
    .eq("account_id", accountId)
    .in("user_id", ids);
  const map: Record<string, FollowupCreator> = {};
  for (const p of (data ?? []) as Array<{
    user_id: string;
    full_name: string | null;
    email: string | null;
    account_role: string | null;
  }>) {
    map[p.user_id] = {
      id: p.user_id,
      full_name: p.full_name,
      email: includeEmail ? p.email : null,
      account_role: p.account_role,
    };
  }
  return map;
}

/**
 * Workspace origin for source-linked rows, resolved in batched
 * queries. Anything unresolvable yields null (never a guessed
 * lead): missing columns, foreign runs, renamed assignee fields,
 * or absent profiles all degrade to "Standalone reminder".
 */
async function loadWorkspaceContext(
  supabase: SupabaseClient,
  accountId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, FollowupWorkspaceContext>> {
  const runIds = [
    ...new Set(
      rows
        .filter((r) => typeof r.source_run_id === "string" && r.source_run_id)
        .map((r) => r.source_run_id as string),
    ),
  ];
  if (runIds.length === 0) return {};
  const { data: runs } = await supabase
    .from("flow_runs")
    .select("id, flow_id, contact_id")
    .eq("account_id", accountId)
    .in("id", runIds);
  const runList = (runs ?? []) as Array<{
    id: string;
    flow_id: string;
    contact_id: string | null;
  }>;
  if (runList.length === 0) return {};
  const runsById = new Map(runList.map((r) => [r.id, r]));
  const flowIds = [...new Set(runList.map((r) => r.flow_id))];
  const { data: flows } = await supabase
    .from("flows")
    .select("id, name, kind")
    .eq("account_id", accountId)
    .in("id", flowIds);
  const flowsById = new Map(
    ((flows ?? []) as Array<{ id: string; name: string | null; kind: string | null }>).map(
      (f) => [f.id, f],
    ),
  );
  const contactIds = [
    ...new Set([
      ...runList.map((r) => r.contact_id).filter((v): v is string => typeof v === "string"),
      ...rows.map((r) => r.contact_id).filter((v): v is string => typeof v === "string"),
    ]),
  ];
  const contactsById = new Map<string, { name: string | null; phone: string }>();
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, name, phone")
      .eq("account_id", accountId)
      .in("id", contactIds);
    for (const c of (contacts ?? []) as Array<{
      id: string;
      name: string | null;
      phone: string;
    }>) {
      contactsById.set(c.id, { name: c.name, phone: c.phone });
    }
  }
  // Assignee only via the exact Assigned-To cell on Meta tables —
  // never inferred from created_by.
  const assigneeByRun = new Map<string, string>();
  const metaFlowIds = runList
    .filter((r) => flowsById.get(r.flow_id)?.kind === "meta_lead_ads")
    .map((r) => r.flow_id);
  if (metaFlowIds.length > 0) {
    const { data: fields } = await supabase
      .from("workspace_fields")
      .select("id, flow_id, name")
      .eq("account_id", accountId)
      .in("flow_id", [...new Set(metaFlowIds)]);
    const assigneeFields = ((fields ?? []) as Array<{
      id: string;
      flow_id: string;
      name: string;
    }>).filter((f) => f.name.trim().toLowerCase() === "assigned to");
    if (assigneeFields.length > 0) {
      const fieldIds = assigneeFields.map((f) => f.id);
      const runIdsForAssignee = runList
        .filter((r) => assigneeFields.some((f) => f.flow_id === r.flow_id))
        .map((r) => r.id);
      if (runIdsForAssignee.length > 0) {
        const { data: values } = await supabase
          .from("workspace_values")
          .select("flow_run_id, value_text")
          .eq("account_id", accountId)
          .in("field_id", fieldIds)
          .in("flow_run_id", runIdsForAssignee);
        const ownerIds = [
          ...new Set(
            ((values ?? []) as Array<{ flow_run_id: string; value_text: string | null }>)
              .map((v) => v.value_text)
              .filter((v): v is string => typeof v === "string" && v !== ""),
          ),
        ];
        if (ownerIds.length > 0) {
          const { data: owners } = await supabase
            .from("profiles")
            .select("user_id, full_name")
            .eq("account_id", accountId)
            .in("user_id", ownerIds);
          const ownersById = new Map(
            ((owners ?? []) as Array<{ user_id: string; full_name: string | null }>).map(
              (o) => [o.user_id, o.full_name ?? "Unknown user"],
            ),
          );
          for (const v of (values ?? []) as Array<{
            flow_run_id: string;
            value_text: string | null;
          }>) {
            if (v.value_text && ownersById.has(v.value_text)) {
              assigneeByRun.set(v.flow_run_id, ownersById.get(v.value_text)!);
            }
          }
        }
      }
    }
  }
  const out: Record<string, FollowupWorkspaceContext> = {};
  for (const r of rows) {
    const runId = r.source_run_id;
    if (typeof runId !== "string" || !runId) continue;
    const run = runsById.get(runId);
    if (!run) continue;
    const flow = flowsById.get(run.flow_id);
    const contact = run.contact_id ? contactsById.get(run.contact_id) : undefined;
    out[r.id as string] = {
      flow_name: flow?.name ?? null,
      lead_name: contact?.name ?? null,
      lead_phone: contact?.phone ?? null,
      assignee_name: assigneeByRun.get(runId) ?? null,
    };
  }
  return out;
}

/** Sanitize free text for a PostgREST `or()` ilike clause. */
function sanitizeOrText(value: string): string {
  return value.replace(/[(),]/g, "").trim();
}

/**
 * GET /api/followups — account-scoped list for the Reminders page.
 *
 * Query params (all optional):
 *   view= all|scheduled|processing|sent|delivered|read|failed|cancelled
 *   status= legacy DB status filter (mapped to view when view absent)
 *   q= search across message, recipient, template (+ creator names)
 *   from= / to= scheduled_for range (ISO)
 *   template= exact template name
 *   creator= exact creator user id
 *   counts=1 → { counts } per display state (agent-scoped, unfiltered)
 *   templates=1 → { templates } distinct non-empty template names
 *
 * Any member may read, but agents are scoped to their OWN reminders
 * only (created_by = authenticated user id, derived server-side —
 * never a client-supplied id). Owner/admin/viewer keep their
 * existing workspace-wide visibility. Rows carry creator profiles
 * (batched), origin passthrough, and Workspace context.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    const agentScoped = role === "agent";

    // ---- counts mode (tab badges; unaffected by list filters) ----
    if (params.get("counts") === "1") {
      const counts: Record<string, number> = { all: 0 };
      const base = () => {
        let q = supabase
          .from("whatsapp_followups")
          .select("id", { count: "exact", head: true })
          .eq("account_id", accountId);
        if (agentScoped) q = q.eq("created_by", userId);
        return q;
      };
      for (const view of DISPLAY_VIEWS) {
        if (view === "all") continue;
        const { count, error } = await applyViewFilter(base(), view);
        if (error) throw error;
        counts[view] = count ?? 0;
      }
      const { count: total, error: totalError } = await base();
      if (totalError) throw totalError;
      counts.all = total ?? 0;
      return NextResponse.json({ counts });
    }

    // ---- templates mode (filter dropdown options) ----
    if (params.get("templates") === "1") {
      let q = supabase
        .from("whatsapp_followups")
        .select("template_name")
        .eq("account_id", accountId)
        .not("template_name", "is", null);
      if (agentScoped) q = q.eq("created_by", userId);
      const { data, error } = await q.limit(500);
      if (error) throw error;
      const templates = [
        ...new Set(
          ((data ?? []) as Array<{ template_name: string | null }>)
            .map((r) => (typeof r.template_name === "string" ? r.template_name.trim() : ""))
            .filter((t) => t !== ""),
        ),
      ].sort();
      return NextResponse.json({ templates });
    }

    // ---- list mode ----
    const viewParam = params.get("view");
    const statusParam = params.get("status");
    // Legacy ?status=sent keeps its historical meaning (every
    // Meta-accepted row); the `sent` VIEW is strictly unconfirmed.
    const legacySent = statusParam === "sent" && viewParam === null;
    let view: FollowupView = "all";
    if (viewParam !== null) {
      if (!isFollowupView(viewParam)) {
        return NextResponse.json({ error: "Invalid view filter." }, { status: 400 });
      }
      view = viewParam;
    } else if (statusParam !== null) {
      if (!isFollowupStatus(statusParam)) {
        return NextResponse.json({ error: "Invalid status filter." }, { status: 400 });
      }
      view = statusParam as FollowupView;
    }

    let query = supabase
      .from("whatsapp_followups")
      .select("*")
      .eq("account_id", accountId);
    // Agent isolation: ownership condition inside the query so
    // list, search, pagination, sorting, and status filters can
    // never expose another agent's reminders.
    if (agentScoped) {
      query = query.eq("created_by", userId);
    }
    if (legacySent) {
      query = query.eq("status", "sent");
    } else {
      query = applyViewFilter(query, view);
    }

    const q = (params.get("q") ?? "").trim();
    if (q !== "") {
      const safe = sanitizeOrText(q).slice(0, 120);
      if (safe !== "") {
        // Creator-name matches resolve server-side to ids so text
        // search stays accurate across pages.
        const { data: matched } = await supabase
          .from("profiles")
          .select("user_id")
          .eq("account_id", accountId)
          .ilike("full_name", `%${safe}%`);
        const creatorIds = ((matched ?? []) as Array<{ user_id: string }>).map(
          (p) => p.user_id,
        );
        const orParts = [
          `message_text.ilike.%${safe}%`,
          `recipient_phone.ilike.%${safe}%`,
          `template_name.ilike.%${safe}%`,
          ...(creatorIds.length > 0 ? [`created_by.in.(${creatorIds.join(",")})`] : []),
        ];
        query = query.or(orParts.join(","));
      }
    }
    const from = params.get("from");
    const to = params.get("to");
    if (from) query = query.gte("scheduled_for", from);
    if (to) query = query.lte("scheduled_for", to);
    const template = params.get("template");
    if (template) query = query.eq("template_name", template);
    const creator = params.get("creator");
    if (creator) query = query.eq("created_by", creator);

    const ascending = view === "all" || view === "scheduled";
    const { data, error } = await query
      .order("scheduled_for", { ascending })
      .limit(100);
    if (error) throw error;
    // Customer context in the same round trip (no N+1): contact
    // names/phones for the listed rows only. Display context —
    // never the recipient.
    const rows = (data ?? []) as Record<string, unknown>[];
    const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
    const contactsById: Record<string, { name: string | null; phone: string }> = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .eq("account_id", accountId)
        .in("id", contactIds);
      for (const c of (contacts ?? []) as Array<{
        id: string;
        name: string | null;
        phone: string;
      }>) {
        contactsById[c.id] = { name: c.name, phone: c.phone };
      }
    }
    const includeEmail = hasMinRole(role, "admin");
    // Enrichment is best-effort by contract: an optional metadata
    // lookup (missing column on an old schema, RLS surprise) must
    // never break the core reminder list — rows degrade to null
    // creator/workspace instead.
    const [creatorsById, workspaceById] = await Promise.all([
      loadCreators(supabase, accountId, rows, includeEmail).catch(
        (): Record<string, FollowupCreator> => ({}),
      ),
      loadWorkspaceContext(supabase, accountId, rows).catch(
        (): Record<string, FollowupWorkspaceContext> => ({}),
      ),
    ]);
    return NextResponse.json({
      followups: rows.map((r) => {
        const base = toFollowup(r);
        const creator = r.created_by
          ? (creatorsById[r.created_by as string] ?? null)
          : null;
        return {
          ...base,
          contact_name: contactsById[r.contact_id as string]?.name ?? null,
          contact_phone: contactsById[r.contact_id as string]?.phone ?? null,
          creator,
          workspace: workspaceById[r.id as string] ?? null,
        };
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/followups — schedule a reminder. Agent+.
 *
 * The reminder is delivered TO ITS CREATOR's stored WhatsApp
 * number (`profiles.whatsapp_number`), snapshotted into
 * `recipient_phone` at creation. Creation FAILS CLOSED when the
 * agent has no valid stored number — no other number may be
 * substituted. Creation carries NO customer field: any
 * `contact_id` in the body is ignored and the row stores NULL.
 * No customer conversation is created or attached.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let input;
    try {
      // No customer field on creation: contact_id is always stored
      // as NULL regardless of what the body carries.
      input = validateFollowupInput({
        contact_id: null,
        scheduled_for: body.scheduled_for,
        message_text: body.message_text,
        template_name: body.template_name,
        template_language: body.template_language,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid input." },
        { status: 400 },
      );
    }

    // Resolve the creator's stored WhatsApp number and snapshot it.
    // Fail closed: without a valid agent number there is no
    // recipient, and NO fallback (customer / business / email) may
    // be substituted. A missing column (pre-migration schema) also
    // fails closed — the error tells the agent what to do.
    const recipient_phone = await loadAgentRecipientPhone(
      supabase,
      userId,
    );
    if (!recipient_phone) {
      return NextResponse.json(
        {
          error:
            "Add your WhatsApp number in Settings → Reminder WhatsApp Number before creating a reminder.",
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("whatsapp_followups")
      .insert({
        account_id: accountId,
        recipient_phone,
        contact_id: null,
        // No thread for a self-reminder: delivery goes straight to
        // the agent's number, never into a customer conversation.
        conversation_id: null,
        scheduled_for: input.scheduled_for,
        message_text: input.message_text,
        template_name: input.template_name,
        template_language: input.template_language,
        status: "scheduled",
        created_by: userId,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(
      { followup: toFollowup(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
