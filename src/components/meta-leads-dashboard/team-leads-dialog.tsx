"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import { getSelectChip } from "@/lib/flows/workspace-select-chips";
import { loadTeamPerformance } from "@/lib/meta-leads-dashboard/team-performance-client";
import type { TeamLeadRow } from "@/lib/meta-leads-dashboard/team-performance-types";
import {
  NO_STAGE_LABEL,
  NO_STAGE_VALUE,
  NO_TYPE_LABEL,
  NO_TYPE_VALUE,
} from "@/lib/meta-leads-dashboard/team-performance-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const PAGE_SIZE = 25;

interface TeamLeadsDialogProps {
  /** Stable user_id, or null for the Unassigned bucket. */
  memberId: string | null;
  memberName: string;
  /** Pre-selected Stage (raw stored value, or null). */
  initialStage: string | null;
  formId: string | null;
  from: string | null;
  to: string | null;
  tz: string;
  onClose: () => void;
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function chipStyle(field: "Stage" | "Lead Type", value: string | null) {
  if (value === null) return undefined;
  const chip = getSelectChip(field, value);
  if (!chip) return undefined;
  return { backgroundColor: chip.background, color: chip.color };
}

/**
 * Read-only lead list for one team member (or Unassigned). Inherits
 * the section's Form + Date filters; adds Stage, Type, and text
 * search with server-side pagination. No assignment or Stage
 * editing — analytics and reporting only.
 */
export function TeamLeadsDialog({
  memberId,
  memberName,
  initialStage,
  formId,
  from,
  to,
  tz,
  onClose,
}: TeamLeadsDialogProps) {
  const [stage, setStage] = useState<string | null>(initialStage);
  const [type, setType] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TeamLeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Reset paging whenever any filter changes.
  useEffect(() => {
    setPage(1);
  }, [stage, type, debouncedSearch, memberId, formId, from, to]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => clearTimeout(t);
  }, [search]);

  // Reset the pre-selected stage if a different member is opened.
  useEffect(() => {
    setStage(initialStage);
    setType(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    loadTeamPerformance(
      {
        formId,
        from,
        to,
        tz,
        member: memberId ?? "unassigned",
        stage,
        type,
        search: debouncedSearch || null,
        page,
        pageSize: PAGE_SIZE,
      },
      ctrl.signal,
    )
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setRows(d.leads);
        setTotal(d.leadsTotal);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[meta-leads] team leads failed:", err);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [memberId, stage, type, debouncedSearch, formId, from, to, tz, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const stageOptions = useMemo(() => [...STAGE_OPTIONS], []);
  const typeOptions = useMemo(() => [...LEAD_TYPE_OPTIONS], []);

  const setStageFilter = useCallback((next: string | null) => {
    setStage(next);
  }, []);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl overflow-hidden border-border bg-popover p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle className="text-sm text-popover-foreground">
            {memberName} — Meta Leads ({total.toLocaleString()})
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Individual Instant Form submissions. Read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by lead name or phone…"
            aria-label="Search leads"
            className="h-8 max-w-56 text-sm"
          />
          <select
            value={stage ?? ""}
            onChange={(e) => setStageFilter(e.target.value === "" ? null : e.target.value)}
            aria-label="Filter by stage"
            className="h-8 max-w-44 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">All Stages</option>
            {stageOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={NO_STAGE_VALUE}>{NO_STAGE_LABEL}</option>
          </select>
          <select
            value={type ?? ""}
            onChange={(e) => setType(e.target.value === "" ? null : e.target.value)}
            aria-label="Filter by type"
            className="h-8 max-w-40 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">All Types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={NO_TYPE_VALUE}>{NO_TYPE_LABEL}</option>
          </select>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="space-y-2 py-4" aria-label="Loading leads">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No matching submissions.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">Date &amp; Time</th>
                    <th className="px-2 py-1.5 font-medium">Lead Name</th>
                    <th className="px-2 py-1.5 font-medium">Phone</th>
                    <th className="px-2 py-1.5 font-medium">Form</th>
                    <th className="px-2 py-1.5 font-medium">Assigned To</th>
                    <th className="px-2 py-1.5 font-medium">Type</th>
                    <th className="px-2 py-1.5 font-medium">Stage</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.date}-${i}`} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                        {formatDateTime(r.date)}
                      </td>
                      <td className="max-w-32 truncate px-2 py-1.5 text-foreground">
                        {r.leadName || "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-foreground">
                        {r.leadPhone || "—"}
                      </td>
                      <td className="max-w-40 truncate px-2 py-1.5 text-foreground" title={r.formName}>
                        {r.formName}
                      </td>
                      <td className="max-w-32 truncate px-2 py-1.5 text-foreground">
                        {r.assigneeName || memberName}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={
                            chipStyle("Lead Type", r.type) ?? {
                              backgroundColor: "#f1f5f9",
                              color: "#475569",
                            }
                          }
                        >
                          {r.type ?? NO_TYPE_LABEL}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={
                            chipStyle("Stage", r.stage) ?? {
                              backgroundColor: "#f1f5f9",
                              color: "#475569",
                            }
                          }
                        >
                          {r.stage ?? NO_STAGE_LABEL}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {total.toLocaleString()} leads
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-md px-2 py-1 hover:bg-muted disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-md px-2 py-1 hover:bg-muted disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
