// ============================================================
// GET /api/meta-lead-ads/team-activity — owner-only Workspace activity
// feed across all Meta Lead Ads tables.
//
// Genuine audit-only feed. Every entry carries a real team-member
// actor (never the owner, never NULL/system), a real action, a real
// timestamp, and the correct Meta table. Owner rows are excluded in
// the database queries (not hidden in the UI) and never count toward
// pagination.
//
// Sources (all account-scoped, all actor-attributed):
//   lead_assignment_events (manual actor only; auto-system NULL rows
//     excluded) — assigned / reassigned / unassigned
//   whatsapp_followups (created_by + workspace-linked source_run_id)
//     — scheduled
//   contact_notes (user_id) — note added
//   messages (sender_type=agent + sender_id) — WhatsApp sent
//
// Excluded with reason (no reliable actor — never fabricated):
//   lead captured (system ingestion), stage/info updates
//   (workspace_values + overrides have no actor), follow-up
//   edited/cancelled actor (PATCH stores no updated_by/cancelled_by),
//   table/config updates (no actor), team-member added (no actor).
//
// Query params: search, member (user_id), activityType (one of the
// six above), tableId (flows.id), from/to (YYYY-MM-DD), tz, cursor
// (`ISO|id` keyset), limit (1..50, default 20).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  isTeamActivityType,
  type TeamActivityItem,
  type TeamActivityType,
} from "@/lib/meta-lead-ads/team-activity";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOSE_UUID_RE = UUID_RE;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const PER_SOURCE_FETCH = 50;

function parseDayKey(v: string | null): string | null {
  if (!v || !DAY_RE.test(v)) return null;
  const [y, mo, d] = v.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return v;
}

function parseCursor(v: string | null): { ts: string; id: string } | null {
  if (!v) return null;
  const sep = v.lastIndexOf("|");
  if (sep <= 0) return null;
  const ts = v.slice(0, sep);
  const id = v.slice(sep + 1);
  if (!id || Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

interface FlowInfo {
  id: string;
  name: string;
}

function escIlike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("owner");
    const { supabase, accountId } = ctx;
    const url = new URL(request.url);

    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 120) || null;
    const member = (url.searchParams.get("member") ?? "").trim() || null;
    const activityTypeRaw = (url.searchParams.get("activityType") ?? "").trim() || null;
    const tableId = (url.searchParams.get("tableId") ?? "").trim() || null;
    const fromRaw = parseDayKey(url.searchParams.get("from"));
    const toRaw = parseDayKey(url.searchParams.get("to"));
    if (
      (url.searchParams.get("from") !== null || url.searchParams.get("to") !== null) &&
      (!fromRaw || !toRaw)
    ) {
      return NextResponse.json(
        { error: "from and to must both be valid YYYY-MM-DD dates" },
        { status: 400 },
      );
    }
    if (fromRaw && toRaw && Date.parse(toRaw) < Date.parse(fromRaw)) {
      return NextResponse.json({ error: "to must be on/after from" }, { status: 400 });
    }
    if (activityTypeRaw && !isTeamActivityType(activityTypeRaw)) {
      return NextResponse.json({ error: "Unknown activityType" }, { status: 400 });
    }
    const activityType = activityTypeRaw as TeamActivityType | null;
    if (member && !LOOSE_UUID_RE.test(member) && !UUID_RE.test(member)) {
      return NextResponse.json({ error: "Invalid member" }, { status: 400 });
    }
    if (tableId && !LOOSE_UUID_RE.test(tableId) && !UUID_RE.test(tableId)) {
      return NextResponse.json({ error: "Invalid tableId" }, { status: 400 });
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT));
    const cursor = parseCursor(url.searchParams.get("cursor"));
    if (url.searchParams.get("cursor") !== null && !cursor) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }

    const fromStart = fromRaw ? `${fromRaw}T00:00:00.000Z` : null;
    const toExclusive = toRaw
      ? new Date(Date.parse(`${toRaw}T00:00:00.000Z`) + 86_400_000).toISOString()
      : null;

    // Owner identity — excluded at the query level everywhere below.
    const { data: accountRow, error: accountErr } = await supabase
      .from("accounts")
      .select("owner_user_id")
      .eq("id", accountId)
      .maybeSingle();
    if (accountErr) {
      return NextResponse.json({ error: "Failed to load account" }, { status: 500 });
    }
    const ownerId =
      (accountRow as { owner_user_id?: unknown } | null)?.owner_user_id != null
        ? String((accountRow as { owner_user_id: unknown }).owner_user_id)
        : null;

    // All Meta tables for this account (hidden included — no hidden filter).
    const { data: flowRows, error: flowErr } = await supabase
      .from("flows")
      .select("id, name")
      .eq("account_id", accountId)
      .eq("kind", "meta_lead_ads")
      .order("name", { ascending: true });
    if (flowErr) {
      return NextResponse.json({ error: "Failed to load tables" }, { status: 500 });
    }
    const flows = ((flowRows ?? []) as Array<{ id: string; name: string | null }>)
      .filter((f) => typeof f.id === "string")
      .map((f) => ({ id: f.id, name: f.name?.trim() ? f.name : "Untitled Table" }));
    const flowById = new Map(flows.map((f) => [f.id, f]));
    const flowIds = new Set(flows.map((f) => f.id));
    if (tableId && !flowIds.has(tableId)) {
      const res = NextResponse.json({ activities: [], nextCursor: null, hasMore: false, tables: flows });
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    const tableFilter = tableId ?? null;

    // Team roster for names + member filter validation (non-owner only).
    const { data: profileRows } = await supabase
      .from("profiles")
      .select("user_id, full_name, account_role")
      .eq("account_id", accountId);
    const nameByUser = new Map<string, string>();
    const teamUserIds = new Set<string>();
    for (const p of ((profileRows ?? []) as Array<{
      user_id?: unknown;
      full_name?: unknown;
      account_role?: unknown;
    }>)) {
      if (typeof p.user_id !== "string") continue;
      if (ownerId && p.user_id === ownerId) continue;
      if (p.account_role !== "admin" && p.account_role !== "agent") continue;
      teamUserIds.add(p.user_id);
      const n = typeof p.full_name === "string" && p.full_name.trim() !== "" ? p.full_name.trim() : "Team member";
      nameByUser.set(p.user_id, n);
    }
    if (member && !teamUserIds.has(member)) {
      const res = NextResponse.json({ activities: [], nextCursor: null, hasMore: false, tables: flows });
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    const want = (t: TeamActivityType): boolean => !activityType || activityType === t;
    const inCursor = (ts: string, id: string): boolean => {
      if (!cursor) return true;
      if (ts < cursor.ts) return true;
      if (ts > cursor.ts) return false;
      return id < cursor.id;
    };
    const inDate = (ts: string): boolean => {
      if (fromStart && ts < fromStart) return false;
      if (toExclusive && ts >= toExclusive) return false;
      return true;
    };

    const out: TeamActivityItem[] = [];
    const fetchN = PER_SOURCE_FETCH + 1;

    // ---- A. Assignment events (manual actor only) ----
    if (want("lead_assigned") || want("lead_reassigned") || want("lead_unassigned")) {
      let q = supabase
        .from("lead_assignment_events")
        .select("id, kind, assigned_user_id, previous_user_id, flow_id, flow_run_id, created_by, created_at, reason")
        .eq("account_id", accountId)
        .not("created_by", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchN);
      if (ownerId) q = q.neq("created_by", ownerId);
      if (member) q = q.eq("created_by", member);
      if (tableFilter) q = q.eq("flow_id", tableFilter);
      if (fromStart) q = q.gte("created_at", fromStart);
      if (toExclusive) q = q.lt("created_at", toExclusive);
      if (cursor) q = q.lte("created_at", cursor.ts);
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((r) => typeof r.created_at === "string" && typeof r.id === "string")
        .filter((r) => inDate(r.created_at as string) && inCursor(r.created_at as string, r.id as string))
        .slice(0, PER_SOURCE_FETCH);

      // Batch resolve runs → contacts + assignee names.
      const runIds = [...new Set(rows.map((r) => r.flow_run_id).filter((v): v is string => typeof v === "string"))];
      const runById = new Map<string, { contact_id: string | null; flow_id: string | null }>();
      const contactIds: string[] = [];
      if (runIds.length > 0) {
        const { data: runRows } = await supabase
          .from("flow_runs")
          .select("id, contact_id, flow_id")
          .eq("account_id", accountId)
          .in("id", runIds.slice(0, 200));
        for (const r of ((runRows ?? []) as Array<{ id: string; contact_id: string | null; flow_id: string | null }>)) {
          runById.set(r.id, { contact_id: r.contact_id, flow_id: r.flow_id });
          if (r.contact_id) contactIds.push(r.contact_id);
        }
      }
      const nameByContact = new Map<string, string>();
      if (contactIds.length > 0) {
        const { data: cRows } = await supabase
          .from("contacts")
          .select("id, name")
          .eq("account_id", accountId)
          .in("id", [...new Set(contactIds)].slice(0, 200));
        for (const c of ((cRows ?? []) as Array<{ id: string; name: string | null }>)) {
          if (c.name?.trim()) nameByContact.set(c.id, c.name.trim());
        }
      }
      // Assignee display names (batch).
      const assigneeIds = [...new Set(rows.flatMap((r) => [r.assigned_user_id, r.previous_user_id]).filter((v): v is string => typeof v === "string"))];
      const assigneeNames = new Map<string, string>();
      if (assigneeIds.length > 0) {
        const { data: aRows } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .eq("account_id", accountId)
          .in("user_id", assigneeIds.slice(0, 200));
        for (const p of ((aRows ?? []) as Array<{ user_id: string; full_name: string | null }>)) {
          assigneeNames.set(p.user_id, p.full_name?.trim() || "Team member");
        }
      }

      for (const r of rows) {
        const actor = String(r.created_by);
        if (!teamUserIds.has(actor)) continue;
        const kind = String(r.kind ?? "");
        const assigned = typeof r.assigned_user_id === "string" ? r.assigned_user_id : null;
        const previous = typeof r.previous_user_id === "string" ? r.previous_user_id : null;
        let type: TeamActivityType | null = null;
        if (kind === "manual" || kind === "auto") {
          if (assigned && !previous) type = "lead_assigned";
          else if (assigned && previous && assigned !== previous) type = "lead_reassigned";
          else if (!assigned) type = "lead_unassigned";
          else continue;
        } else if (kind === "unassigned" || kind === "cleared") {
          type = "lead_unassigned";
        } else continue;
        if (!want(type)) continue;
        const ts = r.created_at as string;
        const runId = typeof r.flow_run_id === "string" ? r.flow_run_id : null;
        const run = runId ? runById.get(runId) : undefined;
        // Skip runs from non-Meta flows (Flow Tables never belong here).
        const flowId = typeof r.flow_id === "string" ? r.flow_id : (run?.flow_id ?? null);
        if (flowId && !flowIds.has(flowId)) continue;
        const table = flowId ? flowById.get(flowId) ?? null : null;
        const leadName = run?.contact_id ? (nameByContact.get(run.contact_id) ?? null) : null;
        const actorName = nameByUser.get(actor) ?? "Team member";
        const assigneeName = assigned ? (assigneeNames.get(assigned) ?? "Team member") : null;
        const tableLabel = table ? ` in “${table.name}”` : "";
        const leadLabel = leadName ? `“${leadName}”` : "a lead";
        let title = "Lead assigned";
        let desc = `Lead ${leadLabel} assigned${assigneeName ? ` to ${assigneeName}` : ""}${tableLabel}`;
        if (type === "lead_reassigned") {
          const prevName = previous ? (assigneeNames.get(previous) ?? "previous owner") : "previous owner";
          title = "Lead reassigned";
          desc = `Lead ${leadLabel} reassigned from ${prevName}${assigneeName ? ` to ${assigneeName}` : ""}${tableLabel}`;
        } else if (type === "lead_unassigned") {
          title = "Lead unassigned";
          desc = `Lead ${leadLabel} unassigned${tableLabel}`;
        }
        out.push({
          id: `assign:${r.id}`,
          type,
          title,
          description: desc,
          timestamp: ts,
          actorId: actor,
          actorName,
          leadName,
          leadId: runId,
          tableId: flowId,
          tableName: table?.name ?? null,
        });
      }
    }

    // ---- B. Follow-ups scheduled (workspace-linked only) ----
    if (want("followup_scheduled")) {
      let q = supabase
        .from("whatsapp_followups")
        .select("id, contact_id, source_run_id, source_kind, created_by, created_at, scheduled_for")
        .eq("account_id", accountId)
        .eq("source_kind", "meta_workspace_followup")
        .not("source_run_id", "is", null)
        .not("created_by", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchN);
      if (ownerId) q = q.neq("created_by", ownerId);
      if (member) q = q.eq("created_by", member);
      if (fromStart) q = q.gte("created_at", fromStart);
      if (toExclusive) q = q.lt("created_at", toExclusive);
      if (cursor) q = q.lte("created_at", cursor.ts);
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((r) => typeof r.created_at === "string" && typeof r.id === "string")
        .filter((r) => inDate(r.created_at as string) && inCursor(r.created_at as string, r.id as string))
        .slice(0, PER_SOURCE_FETCH);

      const runIds = [...new Set(rows.map((r) => r.source_run_id).filter((v): v is string => typeof v === "string"))];
      const runById = new Map<string, { contact_id: string | null; flow_id: string | null }>();
      const contactIds: string[] = [];
      if (runIds.length > 0) {
        const { data: runRows } = await supabase
          .from("flow_runs")
          .select("id, contact_id, flow_id")
          .eq("account_id", accountId)
          .in("id", runIds.slice(0, 200));
        for (const r of ((runRows ?? []) as Array<{ id: string; contact_id: string | null; flow_id: string | null }>)) {
          runById.set(r.id, { contact_id: r.contact_id, flow_id: r.flow_id });
          if (r.contact_id) contactIds.push(r.contact_id);
        }
      }
      const nameByContact = new Map<string, string>();
      if (contactIds.length > 0) {
        const { data: cRows } = await supabase
          .from("contacts")
          .select("id, name")
          .eq("account_id", accountId)
          .in("id", [...new Set(contactIds)].slice(0, 200));
        for (const c of ((cRows ?? []) as Array<{ id: string; name: string | null }>)) {
          if (c.name?.trim()) nameByContact.set(c.id, c.name.trim());
        }
      }
      for (const r of rows) {
        const actor = String(r.created_by);
        if (!teamUserIds.has(actor)) continue;
        const runId = r.source_run_id as string;
        const run = runById.get(runId);
        if (!run || !run.flow_id || !flowIds.has(run.flow_id)) continue;
        if (tableFilter && run.flow_id !== tableFilter) continue;
        const ts = r.created_at as string;
        const table = flowById.get(run.flow_id) ?? null;
        const leadName = run.contact_id ? (nameByContact.get(run.contact_id) ?? null) : null;
        const when = typeof r.scheduled_for === "string" ? r.scheduled_for : null;
        let whenLabel = "";
        if (when) {
          const d = new Date(when);
          if (!Number.isNaN(d.getTime())) {
            whenLabel = ` for ${d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
          }
        }
        out.push({
          id: `followup:${r.id}`,
          type: "followup_scheduled",
          title: "Follow-up scheduled",
          description: `Follow-up for ${leadName ? `“${leadName}”` : "a lead"} scheduled${whenLabel}${table ? ` in “${table.name}”` : ""}`,
          timestamp: ts,
          actorId: actor,
          actorName: nameByUser.get(actor) ?? "Team member",
          leadName,
          leadId: runId,
          tableId: run.flow_id,
          tableName: table?.name ?? null,
        });
      }
    }

    // ---- C. Notes ----
    if (want("note_added")) {
      let q = supabase
        .from("contact_notes")
        .select("id, contact_id, user_id, note_text, created_at")
        .eq("account_id", accountId)
        .not("user_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchN);
      if (ownerId) q = q.neq("user_id", ownerId);
      if (member) q = q.eq("user_id", member);
      if (fromStart) q = q.gte("created_at", fromStart);
      if (toExclusive) q = q.lt("created_at", toExclusive);
      if (cursor) q = q.lte("created_at", cursor.ts);
      if (search) q = q.ilike("note_text", `%${escIlike(search)}%`);
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((r) => typeof r.created_at === "string" && typeof r.id === "string")
        .filter((r) => inDate(r.created_at as string) && inCursor(r.created_at as string, r.id as string))
        .slice(0, PER_SOURCE_FETCH);

      const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((v): v is string => typeof v === "string"))];
      // Latest Meta run per contact (single batched read, newest first).
      const runByContact = new Map<string, { run_id: string; flow_id: string }>();
      const nameByContact = new Map<string, string>();
      if (contactIds.length > 0) {
        const { data: cRows } = await supabase
          .from("contacts")
          .select("id, name")
          .eq("account_id", accountId)
          .in("id", contactIds.slice(0, 200));
        for (const c of ((cRows ?? []) as Array<{ id: string; name: string | null }>)) {
          if (c.name?.trim()) nameByContact.set(c.id, c.name.trim());
          else nameByContact.set(c.id, "");
        }
        const { data: runRows } = await supabase
          .from("flow_runs")
          .select("id, contact_id, flow_id, started_at")
          .eq("account_id", accountId)
          .in("contact_id", contactIds.slice(0, 200))
          .order("started_at", { ascending: false })
          .limit(400);
        for (const r of ((runRows ?? []) as Array<{ id: string; contact_id: string | null; flow_id: string | null }>)) {
          if (!r.contact_id || !r.flow_id || !flowIds.has(r.flow_id)) continue;
          if (!runByContact.has(r.contact_id)) runByContact.set(r.contact_id, { run_id: r.id, flow_id: r.flow_id });
        }
      }
      for (const r of rows) {
        const actor = String(r.user_id);
        if (!teamUserIds.has(actor)) continue;
        const contactId = typeof r.contact_id === "string" ? r.contact_id : null;
        const link = contactId ? runByContact.get(contactId) : undefined;
        if (!link) continue;
        if (tableFilter && link.flow_id !== tableFilter) continue;
        const ts = r.created_at as string;
        const table = flowById.get(link.flow_id) ?? null;
        const rawName = contactId ? nameByContact.get(contactId) : undefined;
        const leadName = rawName && rawName !== "" ? rawName : null;
        const snippet = typeof r.note_text === "string" ? r.note_text.trim().slice(0, 120) : "";
        out.push({
          id: `note:${r.id}`,
          type: "note_added",
          title: "Note added",
          description: `Note added to ${leadName ? `“${leadName}”` : "a lead"}${snippet ? `: “${snippet}”` : ""}${table ? ` in “${table.name}”` : ""}`,
          timestamp: ts,
          actorId: actor,
          actorName: nameByUser.get(actor) ?? "Team member",
          leadName,
          leadId: link.run_id,
          tableId: link.flow_id,
          tableName: table?.name ?? null,
        });
      }
    }

    // ---- D. Agent WhatsApp messages to Meta contacts ----
    if (want("whatsapp_sent")) {
      let q = supabase
        .from("messages")
        .select("id, conversation_id, sender_id, content_text, template_name, created_at, conversations!inner(account_id, contact_id)")
        .eq("sender_type", "agent")
        .not("sender_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchN);
      if (ownerId) q = q.neq("sender_id", ownerId);
      if (member) q = q.eq("sender_id", member);
      if (fromStart) q = q.gte("created_at", fromStart);
      if (toExclusive) q = q.lt("created_at", toExclusive);
      if (cursor) q = q.lte("created_at", cursor.ts);
      if (search) q = q.ilike("content_text", `%${escIlike(search)}%`);
      // Scope to this account via the embedded conversation (RLS also enforces).
      q = q.eq("conversations.account_id", accountId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((r) => typeof r.created_at === "string" && typeof r.id === "string")
        .filter((r) => inDate(r.created_at as string) && inCursor(r.created_at as string, r.id as string))
        .slice(0, PER_SOURCE_FETCH);

      const contactIds = [
        ...new Set(
          rows
            .map((r) => (r.conversations as { contact_id?: unknown } | null)?.contact_id)
            .filter((v): v is string => typeof v === "string"),
        ),
      ];
      const runByContact = new Map<string, { run_id: string; flow_id: string }>();
      const nameByContact = new Map<string, string>();
      if (contactIds.length > 0) {
        const { data: cRows } = await supabase
          .from("contacts")
          .select("id, name")
          .eq("account_id", accountId)
          .in("id", contactIds.slice(0, 200));
        for (const c of ((cRows ?? []) as Array<{ id: string; name: string | null }>)) {
          nameByContact.set(c.id, c.name?.trim() || "");
        }
        const { data: runRows } = await supabase
          .from("flow_runs")
          .select("id, contact_id, flow_id, started_at")
          .eq("account_id", accountId)
          .in("contact_id", contactIds.slice(0, 200))
          .order("started_at", { ascending: false })
          .limit(400);
        for (const r of ((runRows ?? []) as Array<{ id: string; contact_id: string | null; flow_id: string | null }>)) {
          if (!r.contact_id || !r.flow_id || !flowIds.has(r.flow_id)) continue;
          if (!runByContact.has(r.contact_id)) runByContact.set(r.contact_id, { run_id: r.id, flow_id: r.flow_id });
        }
      }
      for (const r of rows) {
        const actor = String(r.sender_id);
        if (!teamUserIds.has(actor)) continue;
        const contactId = (r.conversations as { contact_id?: unknown } | null)?.contact_id;
        if (typeof contactId !== "string") continue;
        const link = runByContact.get(contactId);
        if (!link) continue;
        if (tableFilter && link.flow_id !== tableFilter) continue;
        const ts = r.created_at as string;
        const table = flowById.get(link.flow_id) ?? null;
        const rawName = nameByContact.get(contactId);
        const leadName = rawName && rawName !== "" ? rawName : null;
        const template = typeof r.template_name === "string" && r.template_name.trim() !== "" ? r.template_name.trim() : null;
        out.push({
          id: `msg:${r.id}`,
          type: "whatsapp_sent",
          title: "WhatsApp message sent",
          description: template
            ? `Message sent to ${leadName ? `“${leadName}”` : "a lead"} (template: ${template})${table ? ` in “${table.name}”` : ""}`
            : `Message sent to ${leadName ? `“${leadName}”` : "a lead"}${table ? ` in “${table.name}”` : ""}`,
          timestamp: ts,
          actorId: actor,
          actorName: nameByUser.get(actor) ?? "Team member",
          leadName,
          leadId: link.run_id,
          tableId: link.flow_id,
          tableName: table?.name ?? null,
        });
      }
    }

    // ---- Global search post-filter (title/desc/lead/table) ----
    let filtered = out;
    if (search) {
      const s = search.toLowerCase();
      filtered = out.filter(
        (a) =>
          a.title.toLowerCase().includes(s) ||
          a.description.toLowerCase().includes(s) ||
          (a.leadName ?? "").toLowerCase().includes(s) ||
          (a.tableName ?? "").toLowerCase().includes(s),
      );
    }
    filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.id < b.id ? 1 : -1));
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit || out.length >= PER_SOURCE_FETCH;
    // hasMore is conservative: when any source hit its fetch cap there
    // may be older rows beyond this page. The cursor still advances
    // without duplicates.
    const last = page[page.length - 1] ?? null;
    const nextCursor = last ? `${last.timestamp}|${last.id}` : null;

    const res = NextResponse.json({
      activities: page,
      nextCursor: hasMore ? nextCursor : null,
      hasMore,
      tables: flows.map((f) => ({ flowId: f.id, name: f.name })),
      members: [...teamUserIds].map((userId) => ({ userId, name: nameByUser.get(userId) ?? "Team member" })),
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
