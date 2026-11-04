"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toDateInputValue } from "@/lib/dashboard/date-utils";
import {
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import { getSelectChip } from "@/lib/flows/workspace-select-chips";
import { loadTeamPerformance } from "@/lib/meta-leads-dashboard/team-performance-client";
import type {
  TeamMemberPerformance,
  TeamPerformanceData,
  UnassignedPerformance,
} from "@/lib/meta-leads-dashboard/team-performance-types";
import {
  NO_STAGE_LABEL,
  NO_TYPE_LABEL,
  NO_TYPE_VALUE,
  NO_STAGE_VALUE,
  UNASSIGNED_KEY,
} from "@/lib/meta-leads-dashboard/team-performance-types";
import { TeamLeadsDialog } from "./team-leads-dialog";

type DatePreset =
  | "all"
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "month"
  | "custom";

const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: "all", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "month", label: "This Month" },
  { value: "custom", label: "Custom Range" },
];

function localKey(d: Date): string {
  return toDateInputValue(d);
}

function addLocalDays(key: string, days: number): string {
  const [y, m, dd] = key.split("-").map(Number);
  const d = new Date(y, m - 1, dd);
  d.setDate(d.getDate() + days);
  return localKey(d);
}

/** Resolve a preset to inclusive [from, to] calendar keys (tz = browser local). Nulls = All Time. */
function presetRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): { from: string | null; to: string | null } {
  const today = localKey(now);
  switch (preset) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addLocalDays(today, -1), to: addLocalDays(today, -1) };
    case "last7":
      return { from: addLocalDays(today, -6), to: today };
    case "last30":
      return { from: addLocalDays(today, -29), to: today };
    case "month": {
      const first = `${today.slice(0, 7)}-01`;
      return { from: first, to: today };
    }
    case "custom": {
      if (!customFrom || !customTo) return { from: null, to: null };
      return customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : { from: customTo, to: customFrom };
    }
  }
}

function orderStages(
  splits: Array<{ stage: string | null; leads: number }>,
): Array<{ key: string; label: string; leads: number; raw: string | null }> {
  const rank = new Map(STAGE_OPTIONS.map((s, i) => [s, i]));
  return splits
    .map((s) => ({
      key: s.stage ?? NO_STAGE_VALUE,
      label: s.stage ?? NO_STAGE_LABEL,
      leads: s.leads,
      raw: s.stage,
    }))
    .sort((a, b) => {
      const ra = a.raw === null ? Number.MAX_SAFE_INTEGER : (rank.get(a.raw) ?? Number.MAX_SAFE_INTEGER - 1);
      const rb = b.raw === null ? Number.MAX_SAFE_INTEGER : (rank.get(b.raw) ?? Number.MAX_SAFE_INTEGER - 1);
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
}

function orderTypes(
  splits: Array<{ type: string | null; leads: number }>,
): Array<{ key: string; label: string; leads: number; raw: string | null }> {
  const rank = new Map(LEAD_TYPE_OPTIONS.map((s, i) => [s, i]));
  return splits
    .map((s) => ({
      key: s.type ?? NO_TYPE_VALUE,
      label: s.type ?? NO_TYPE_LABEL,
      leads: s.leads,
      raw: s.type,
    }))
    .sort((a, b) => {
      const ra = a.raw === null ? Number.MAX_SAFE_INTEGER : (rank.get(a.raw) ?? Number.MAX_SAFE_INTEGER - 1);
      const rb = b.raw === null ? Number.MAX_SAFE_INTEGER : (rank.get(b.raw) ?? Number.MAX_SAFE_INTEGER - 1);
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
}

function chipStyle(field: "Stage" | "Lead Type", value: string | null): React.CSSProperties | undefined {
  if (value === null) return undefined;
  const chip = getSelectChip(field, value);
  if (!chip) return undefined;
  return { backgroundColor: chip.background, color: chip.color };
}

interface RowModel {
  key: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  total: number;
  stages: ReturnType<typeof orderStages>;
  types: ReturnType<typeof orderTypes>;
  memberId: string | null;
}

export function TeamPerformance() {
  const [formId, setFormId] = useState<string | null>(null);
  const [preset, setPreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<TeamPerformanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<{
    memberId: string | null;
    name: string;
    stage: string | null;
  } | null>(null);

  const range = useMemo(
    () => presetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const tz =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : "UTC";

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    loadTeamPerformance(
      {
        formId,
        from: range.from,
        to: range.to,
        tz,
      },
      ctrl.signal,
    )
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[meta-leads] team performance failed:", err);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId, range.from, range.to]);

  const openLeads = useCallback((memberId: string | null, name: string, stage: string | null = null) => {
    setDialog({ memberId, name, stage });
  }, []);

  const rows: RowModel[] = useMemo(() => {
    if (!data) return [];
    const memberRows: RowModel[] = data.members.map((m: TeamMemberPerformance) => ({
      key: m.userId,
      name: m.name,
      email: m.email,
      avatarUrl: m.avatarUrl,
      total: m.total,
      stages: orderStages(m.stages),
      types: orderTypes(m.types),
      memberId: m.userId,
    }));
    const u: UnassignedPerformance = data.unassigned;
    memberRows.push({
      key: UNASSIGNED_KEY,
      name: "Unassigned",
      email: null,
      avatarUrl: null,
      total: u.total,
      stages: orderStages(u.stages),
      types: orderTypes(u.types),
      memberId: null,
    });
    return memberRows;
  }, [data]);

  const summary = data?.summary ?? { total: 0, assigned: 0, unassigned: 0 };
  const assignedPct = summary.total > 0 ? Math.round((summary.assigned / summary.total) * 100) : 0;
  const unassignedPct = summary.total > 0 ? 100 - assignedPct : 0;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]" aria-label="Team Member Lead Performance">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold text-foreground">Team Member Lead Performance</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          See how Meta leads are distributed among team members and their current sales pipeline stages.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Form
            <select
              value={formId ?? ""}
              onChange={(e) => setFormId(e.target.value === "" ? null : e.target.value)}
              aria-label="Form filter"
              className="h-8 max-w-56 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              <option value="">All Forms</option>
              {(data?.forms ?? []).map((f) => (
                <option key={f.formId} value={f.formId}>
                  {f.formName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Date
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as DatePreset)}
              aria-label="Date filter"
              className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              {DATE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset === "custom" && (
            <>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Custom from date"
                className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
              />
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Custom to date"
                className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
              />
            </>
          )}
        </div>
      </div>

      <div className="p-5">
        {loading || !data ? (
          <div className="space-y-2" aria-label="Loading team performance">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Team Member</th>
                    <th className="px-3 py-2 font-medium">Total Leads</th>
                    <th className="px-3 py-2 font-medium">Stage Distribution</th>
                    <th className="px-3 py-2 font-medium">Type Distribution</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-b border-border last:border-0">
                      <td className="min-w-44 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {row.key === UNASSIGNED_KEY ? (
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                              ?
                            </div>
                          ) : row.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={row.avatarUrl}
                              alt=""
                              className="h-8 w-8 shrink-0 rounded-full object-cover"
                            />
                          ) : (
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                              {row.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                            {row.email && (
                              <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        <span className="text-sm font-semibold text-foreground">{row.total}</span>
                      </td>
                      <td className="min-w-56 px-3 py-2.5">
                        {row.total === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div
                              className="flex h-2.5 w-full max-w-64 overflow-hidden rounded-full bg-muted"
                              role="img"
                              aria-label={`Stage split: ${row.stages.map((s) => `${s.label} ${s.leads}`).join(", ")}`}
                            >
                              {row.stages.map((s) => {
                                const style = chipStyle("Stage", s.raw);
                                const pct = row.total > 0 ? (s.leads / row.total) * 100 : 0;
                                return (
                                  <button
                                    key={s.key}
                                    type="button"
                                    onClick={() => openLeads(row.key === UNASSIGNED_KEY ? null : row.memberId, row.name, s.raw ?? NO_STAGE_VALUE)}
                                    title={`${s.label}: ${s.leads}`}
                                    aria-label={`View ${row.name} leads in ${s.label}`}
                                    className="h-full shrink-0 border-r border-card last:border-0"
                                    style={{
                                      width: `${pct}%`,
                                      minWidth: s.leads > 0 ? 6 : 0,
                                      backgroundColor: style?.backgroundColor ?? "#cbd5e1",
                                    }}
                                  />
                                );
                              })}
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {row.stages.map((s) => {
                                const style = chipStyle("Stage", s.raw);
                                return (
                                  <button
                                    key={s.key}
                                    type="button"
                                    onClick={() => openLeads(row.key === UNASSIGNED_KEY ? null : row.memberId, row.name, s.raw ?? NO_STAGE_VALUE)}
                                    title={`View ${s.label} leads`}
                                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium"
                                    style={
                                      style ?? {
                                        backgroundColor: "#f1f5f9",
                                        color: "#475569",
                                      }
                                    }
                                  >
                                    {s.label}
                                    <span className="tabular-nums">{s.leads}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="min-w-44 px-3 py-2.5">
                        {row.total === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {row.types.map((t) => {
                              const style = chipStyle("Lead Type", t.raw);
                              return (
                                <span
                                  key={t.key}
                                  title={`${t.label}: ${t.leads}`}
                                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium"
                                  style={
                                    style ?? {
                                      backgroundColor: "#f1f5f9",
                                      color: "#475569",
                                    }
                                  }
                                >
                                  {t.label}
                                  <span className="tabular-nums">{t.leads}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => openLeads(row.key === UNASSIGNED_KEY ? null : row.memberId, row.name, null)}
                          className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-primary hover:bg-muted"
                        >
                          View Leads
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-[13px] text-muted-foreground">Total Meta Leads</p>
                <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-foreground">
                  {summary.total.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-[13px] text-muted-foreground">Assigned Leads</p>
                <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-foreground">
                  {summary.assigned.toLocaleString()}
                  <span className="ml-2 align-middle text-[13px] font-medium text-muted-foreground">
                    {assignedPct}% of total
                  </span>
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-[13px] text-muted-foreground">Unassigned Leads</p>
                <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-foreground">
                  {summary.unassigned.toLocaleString()}
                  <span className="ml-2 align-middle text-[13px] font-medium text-muted-foreground">
                    {unassignedPct}% of total
                  </span>
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {dialog && (
        <TeamLeadsDialog
          memberId={dialog.memberId}
          memberName={dialog.name}
          initialStage={dialog.stage}
          formId={formId}
          from={range.from}
          to={range.to}
          tz={tz}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
