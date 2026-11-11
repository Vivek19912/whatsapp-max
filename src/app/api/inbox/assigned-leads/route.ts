import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import { isAssigneeField } from "@/lib/flows/workspace-assignee";
import {
  normalizeLeadFieldData,
  standardContactFromAnswers,
} from "@/lib/meta-lead-ads/normalize";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hard caps keep the assigned-lead scan bounded per request. */
const FLOW_LIMIT = 200;
const VALUE_LIMIT = 500;

/**
 * GET /api/inbox/assigned-leads — Meta Lead Ads leads assigned to
 * the caller that have NO WhatsApp conversation yet.
 *
 * A lead can be assigned (Workspace Assigned To cell) long before
 * the first WhatsApp message creates its `conversations` row, and
 * the Inbox conversation list cannot render what has no thread.
 * This endpoint returns those lead-only entries so the Inbox can
 * show them in a dedicated Assigned Leads section — without
 * fabricating conversations, messages, or previews.
 *
 * Scope (server-enforced, never from client params):
 * - agent without view_all: only runs whose Assigned To cell equals
 *   the caller's Supabase UID.
 * - owner/admin/viewer/view_all agent: all assigned (member-UUID)
 *   leads in the account.
 * Excluded always: Unassigned/cleared cells, non-UUID values
 * (external notification-only contacts are never owners), runs
 * whose contact already has a conversation (shown in the normal
 * list instead — never duplicated, never leaked across owners).
 */
export interface AssignedLeadEntry {
  run_id: string;
  flow_id: string;
  flow_name: string;
  form_name: string | null;
  contact_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  owner_id: string;
  owner_name: string | null;
  submitted_at: string;
  status: string;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    // Viewer keeps legacy read-all; owner/admin are account-wide by
    // role. Agents need an explicit view_all grant for the
    // account-wide list, otherwise they see only their own leads.
    let canViewAll = role === "owner" || role === "admin" || role === "viewer";
    if (!canViewAll && role === "agent") {
      const { data: grant, error: grantError } = await supabase
        .from("agent_inbox_permissions")
        .select("can_view_all")
        .eq("account_id", accountId)
        .eq("user_id", userId)
        .maybeSingle();
      if (grantError) throw grantError;
      canViewAll = (grant as { can_view_all?: unknown } | null)?.can_view_all === true;
    }
    if (!canViewAll && role !== "agent") {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }

    const q =
      new URL(request.url).searchParams.get("q")?.trim().toLowerCase() || null;

    // 1. Meta Lead Ads flows in this account.
    const { data: flowRows, error: flowError } = await supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads")
      .limit(FLOW_LIMIT);
    if (flowError) throw flowError;
    const flows = ((flowRows ?? []) as Array<{ id: string; name: string | null }>)
      .filter((f) => typeof f.id === "string");
    if (flows.length === 0) {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }
    const flowById = new Map(flows.map((f) => [f.id, f]));
    const flowIds = [...flowById.keys()];

    // 2. Assigned To fields (existing resolution: name match).
    const { data: fieldRows, error: fieldError } = await supabase
      .from("workspace_fields")
      .select("id, flow_id, name")
      .eq("account_id", accountId)
      .in("flow_id", flowIds);
    if (fieldError) throw fieldError;
    const assigneeFieldIds = (((fieldRows ?? []) as Array<{
      id: string;
      flow_id: string;
      name: string;
    }>).filter((f) => isAssigneeField({ name: f.name ?? "" }))).map(
      (f) => f.id
    );
    if (assigneeFieldIds.length === 0) {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }

    // 3. Assignment cells. Agents are scoped to their own UID;
    // account-wide views filter to member UUIDs in code (externals
    // can never be owners, so they drop out here).
    let valuesQuery = supabase
      .from("workspace_values")
      .select("field_id, flow_run_id, value_text")
      .eq("account_id", accountId)
      .in("field_id", assigneeFieldIds)
      .limit(VALUE_LIMIT);
    if (!canViewAll) {
      valuesQuery = valuesQuery.eq("value_text", userId);
    }
    const { data: valueRows, error: valueError } = await valuesQuery;
    if (valueError) throw valueError;
    const cells = ((valueRows ?? []) as Array<{
      field_id: string;
      flow_run_id: string;
      value_text: string | null;
    }>).filter(
      (c) =>
        typeof c.flow_run_id === "string" &&
        typeof c.value_text === "string" &&
        UUID_RE.test(c.value_text.trim())
    );
    if (cells.length === 0) {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }
    const ownerByRun = new Map(
      cells.map((c) => [c.flow_run_id, c.value_text!.trim()])
    );

    // 4. The lead runs themselves (same account).
    const { data: runRows, error: runError } = await supabase
      .from("flow_runs")
      .select("id, flow_id, contact_id, vars, started_at, status")
      .eq("account_id", accountId)
      .in("id", [...ownerByRun.keys()]);
    if (runError) throw runError;
    const runs = ((runRows ?? []) as Array<{
      id: string;
      flow_id: string;
      contact_id: string | null;
      vars: unknown;
      started_at: string;
      status: string | null;
    }>).filter((r) => flowById.has(r.flow_id));
    if (runs.length === 0) {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }

    const contactIds = [...new Set(runs.map((r) => r.contact_id).filter(Boolean))] as string[];

    // 5. Exclude runs whose contact already has a conversation —
    // those render in the normal conversation list (or are repaired
    // into it by adoption), so a lead-only entry would duplicate or
    // leak them.
    let threaded = new Set<string>();
    if (contactIds.length > 0) {
      const { data: convRows, error: convError } = await supabase
        .from("conversations")
        .select("contact_id")
        .eq("account_id", accountId)
        .in("contact_id", contactIds);
      if (convError) throw convError;
      threaded = new Set(
        ((convRows ?? []) as Array<{ contact_id: string | null }>)
          .map((c) => c.contact_id)
          .filter(Boolean) as string[]
      );
    }
    const leadRuns = runs.filter(
      (r) => !r.contact_id || !threaded.has(r.contact_id)
    );
    if (leadRuns.length === 0) {
      return NextResponse.json({ leads: [] as AssignedLeadEntry[] });
    }

    // 6. Contacts, submissions (form/time/details), owner names —
    // one bounded query each, no N+1.
    const wantedContacts = [...new Set(
      leadRuns.map((r) => r.contact_id).filter(Boolean)
    )] as string[];
    let contactById = new Map<string, { name: string | null; phone: string | null; email: string | null }>();
    if (wantedContacts.length > 0) {
      const { data: contactRows, error: contactError } = await supabase
        .from("contacts")
        .select("id, name, phone, email")
        .eq("account_id", accountId)
        .in("id", wantedContacts);
      if (contactError) throw contactError;
      contactById = new Map(
        ((contactRows ?? []) as Array<{
          id: string;
          name: string | null;
          phone: string | null;
          email: string | null;
        }>).map((c) => [c.id, c])
      );
    }

    const runIds = leadRuns.map((r) => r.id);
    const { data: subRows, error: subError } = await supabase
      .from("meta_lead_submissions")
      .select("flow_run_id, form_name, meta_created_time, created_at, field_data")
      .eq("account_id", accountId)
      .eq("status", "processed")
      .in("flow_run_id", runIds);
    if (subError) throw subError;
    const subsByRun = new Map<string, Array<{
      form_name: string | null;
      meta_created_time: string | null;
      created_at: string | null;
      field_data: unknown;
    }>>();
    for (const s of ((subRows ?? []) as Array<{
      flow_run_id: string | null;
      form_name: string | null;
      meta_created_time: string | null;
      created_at: string | null;
      field_data: unknown;
    }>)) {
      if (!s.flow_run_id) continue;
      const list = subsByRun.get(s.flow_run_id) ?? [];
      list.push(s);
      subsByRun.set(s.flow_run_id, list);
    }

    const ownerIds = [...new Set(ownerByRun.values())];
    let nameByUser = new Map<string, string>();
    if (ownerIds.length > 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("account_id", accountId)
        .in("user_id", ownerIds);
      if (profileError) throw profileError;
      nameByUser = new Map(
        ((profileRows ?? []) as Array<{ user_id: string; full_name: string | null }>)
          .filter((p) => typeof p.full_name === "string" && p.full_name.trim() !== "")
          .map((p) => [p.user_id, (p.full_name as string).trim()])
      );
    }

    // 7. One entry per contact (newest run wins, preserving context
    // via that run); null-contact runs each stand alone.
    const newestByGroup = new Map<string, (typeof leadRuns)[number]>();
    for (const run of leadRuns) {
      const key = run.contact_id ?? `run:${run.id}`;
      const prev = newestByGroup.get(key);
      if (!prev || (run.started_at ?? "") >= (prev.started_at ?? "")) {
        newestByGroup.set(key, run);
      }
    }

    const leads: AssignedLeadEntry[] = [];
    for (const run of newestByGroup.values()) {
      const ownerId = ownerByRun.get(run.id);
      if (!ownerId) continue;
      const contact = run.contact_id ? contactById.get(run.contact_id) : undefined;
      const subs = subsByRun.get(run.id) ?? [];
      const sub = subs.sort((a, b) =>
        (b.meta_created_time ?? b.created_at ?? "").localeCompare(
          a.meta_created_time ?? a.created_at ?? ""
        )
      )[0];
      // Lead details: contact first, then the stored submission /
      // run payload via the same standard-field resolution
      // ingestion uses (contacts may not exist for invalid phones).
      let fallback: { name: string | null; phone: string | null; email: string | null } = {
        name: null,
        phone: null,
        email: null,
      };
      try {
        if (Array.isArray(sub?.field_data)) {
          fallback = normalizeLeadFieldData(
            sub.field_data as Array<{ name?: string; values?: string[] }>
          ).standard;
        } else if (run.vars && typeof run.vars === "object" && !Array.isArray(run.vars)) {
          fallback = standardContactFromAnswers(
            run.vars as Record<string, string | null | undefined>
          );
        }
      } catch {
        // Best-effort details; the entry itself must still render.
      }
      const name = contact?.name?.trim() || fallback.name?.trim() || "Unknown lead";
      const phone = contact?.phone?.trim() || fallback.phone?.trim() || null;
      const submittedAt =
        sub?.meta_created_time ?? sub?.created_at ?? run.started_at;
      const flow = flowById.get(run.flow_id);
      leads.push({
        run_id: run.id,
        flow_id: run.flow_id,
        flow_name: flow?.name?.trim() || "Meta Lead Ads",
        form_name: sub?.form_name?.trim() || null,
        contact_id: run.contact_id,
        name,
        phone,
        email: contact?.email?.trim() || fallback.email?.trim() || null,
        owner_id: ownerId,
        owner_name: nameByUser.get(ownerId) ?? null,
        submitted_at: submittedAt,
        status: typeof run.status === "string" ? run.status : "completed",
      });
    }

    leads.sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""));

    const filtered = q
      ? leads.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q) ||
          (l.form_name ?? "").toLowerCase().includes(q) ||
          (l.flow_name ?? "").toLowerCase().includes(q)
      )
      : leads;

    return NextResponse.json({ leads: filtered });
  } catch (err) {
    return toErrorResponse(err);
  }
}
