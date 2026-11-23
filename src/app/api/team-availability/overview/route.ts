import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { eligibleMemberIds } from "@/lib/lead-assignment/members";
import { holidayStatus, todayInZone } from "@/lib/lead-assignment/holidays";
import { ASSIGNMENT_TIMEZONE } from "@/lib/lead-assignment/table-validation";

/**
 * GET /api/team-availability/overview — owner-only snapshot for the
 * Team Availability page: eligible roster with availability,
 * holiday windows, affected tables, and KPI counts.
 *
 * Availability is derived at read time from saved holiday rows
 * against today's wall-clock date (no cron, no writes):
 * cancelled → history only; end < today → completed (available);
 * start <= today <= end → on holiday; start > today → upcoming
 * (available now). Reads are account-scoped; contact channels are
 * never exposed.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("owner");
    const today = todayInZone(ASSIGNMENT_TIMEZONE);

    const { data: rosterData, error: rosterErr } = await supabase
      .from("profiles")
      .select("user_id, full_name, account_role")
      .eq("account_id", accountId)
      .order("full_name", { ascending: true });
    if (rosterErr) throw rosterErr;
    const roster = ((rosterData ?? []) as Array<{
      user_id: unknown;
      full_name: unknown;
      account_role: unknown;
    }>)
      .filter(
        (p): p is { user_id: string; full_name: string; account_role: string } =>
          typeof p.user_id === "string" &&
          typeof p.full_name === "string" &&
          typeof p.account_role === "string",
      )
      .map((p) => ({
        user_id: p.user_id,
        full_name: p.full_name,
        role: p.account_role,
      }));
    const eligibleIds = new Set(
      eligibleMemberIds(roster.map((m) => ({ user_id: m.user_id, role: m.role }))),
    );
    const members = roster.filter((m) => eligibleIds.has(m.user_id));

    const { data: holidaysData, error: holidaysErr } = await supabase
      .from("lead_assignment_holidays")
      .select("id, user_id, start_date, end_date, reason, cancelled_at")
      .eq("account_id", accountId)
      .order("start_date", { ascending: true });
    if (holidaysErr) throw holidaysErr;
    type Window = {
      id: string;
      start_date: string;
      end_date: string;
      reason: string | null;
      status: "upcoming" | "active" | "completed" | "cancelled";
    };
    const windowsByUser = new Map<string, Window[]>();
    const activeUsers = new Set<string>();
    for (const h of (holidaysData ?? []) as Array<Record<string, unknown>>) {
      if (typeof h.user_id !== "string") continue;
      if (typeof h.start_date !== "string" || typeof h.end_date !== "string") continue;
      if (typeof h.id !== "string") continue;
      const status = holidayStatus(
        {
          start_date: h.start_date,
          end_date: h.end_date,
          cancelled_at: typeof h.cancelled_at === "string" ? h.cancelled_at : null,
        },
        today,
      );
      if (status === "cancelled") continue;
      const list = windowsByUser.get(h.user_id) ?? [];
      list.push({
        id: h.id,
        start_date: h.start_date,
        end_date: h.end_date,
        reason: typeof h.reason === "string" ? h.reason : null,
        status,
      });
      windowsByUser.set(h.user_id, list);
      if (status === "active") activeUsers.add(h.user_id);
    }

    // Which members are configured where (internal assignees only).
    const { data: configsData, error: configsErr } = await supabase
      .from("lead_assignment_table_configs")
      .select("id, flow_id")
      .eq("account_id", accountId);
    if (configsErr) throw configsErr;
    const configs = ((configsData ?? []) as Array<{ id: unknown; flow_id: unknown }>)
      .filter(
        (c): c is { id: string; flow_id: string } =>
          typeof c.id === "string" && typeof c.flow_id === "string",
      )
      .map((c) => ({ id: c.id, flow_id: c.flow_id }));
    const configIds = configs.map((c) => c.id);
    const assigneesByConfig = new Map<string, string[]>();
    if (configIds.length > 0) {
      const { data: assigneesData, error: assigneesErr } = await supabase
        .from("lead_assignment_table_assignees")
        .select("config_id, user_id")
        .in("config_id", configIds);
      if (assigneesErr) throw assigneesErr;
      for (const a of (assigneesData ?? []) as Array<{
        config_id: unknown;
        user_id: unknown;
      }>) {
        if (typeof a.config_id !== "string") continue;
        if (typeof a.user_id !== "string" || a.user_id === "") continue;
        const list = assigneesByConfig.get(a.config_id) ?? [];
        list.push(a.user_id);
        assigneesByConfig.set(a.config_id, list);
      }
    }
    const flowIds = [...new Set(configs.map((c) => c.flow_id))];
    const flowNameById = new Map<string, string>();
    if (flowIds.length > 0) {
      const { data: flowsData, error: flowsErr } = await supabase
        .from("flows")
        .select("id, name")
        .eq("account_id", accountId)
        .in("id", flowIds);
      if (flowsErr) throw flowsErr;
      for (const f of (flowsData ?? []) as Array<{ id: unknown; name: unknown }>) {
        if (typeof f.id === "string" && typeof f.name === "string" && f.name.trim() !== "") {
          flowNameById.set(f.id, f.name);
        }
      }
    }

    // Configs currently affected: at least one internal assignee on
    // active holiday. Per-member affected tables likewise.
    let assignmentsAdjusted = 0;
    const tablesByUser = new Map<string, string[]>();
    for (const c of configs) {
      const users = assigneesByConfig.get(c.id) ?? [];
      const onHoliday = users.filter((u) => activeUsers.has(u));
      if (onHoliday.length === 0) continue;
      assignmentsAdjusted += 1;
      const label = flowNameById.get(c.flow_id) ?? "Untitled table";
      for (const u of onHoliday) {
        const list = tablesByUser.get(u) ?? [];
        if (!list.includes(label)) list.push(label);
        tablesByUser.set(u, list);
      }
    }

    return NextResponse.json({
      today,
      kpis: {
        totalMembers: members.length,
        onHoliday: members.filter((m) => activeUsers.has(m.user_id)).length,
        availableToday: members.filter((m) => !activeUsers.has(m.user_id)).length,
        assignmentsAdjusted,
      },
      members: members.map((m) => ({
        user_id: m.user_id,
        full_name: m.full_name,
        role: m.role,
        availability: activeUsers.has(m.user_id) ? "on_holiday" : "available",
        holidays: windowsByUser.get(m.user_id) ?? [],
        affects_tables: tablesByUser.get(m.user_id) ?? [],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
