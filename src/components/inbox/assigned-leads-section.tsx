"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  assignedLeadKey,
  fetchAssignedLeads,
  formatLeadSubmittedAt,
  type AssignedLead,
} from "./assigned-leads";

/**
 * Assigned Leads — lead-only Inbox section for Meta Lead Ads leads
 * assigned to the viewer that have no WhatsApp conversation yet.
 *
 * Rendered below the conversation list in the Inbox left pane (own
 * collapsed scroll region, never mixed into conversation rows):
 * - Excludes any lead whose contact already has a thread (the
 *   `threadContactIds` prop covers the race between thread creation
 *   and the next server refetch).
 * - Never fabricates last-message text, unread counts, or delivery
 *   status — rows show lead context + a "no conversation yet" state.
 * - Refetches on `resyncToken` and whenever the thread set changes,
 *   so assignment/reassignment and first-message transitions update
 *   without a manual refresh and without polling.
 */
export function AssignedLeadsSection({
  searchQuery,
  resyncToken,
  threadContactIds,
  activeLeadRunId,
  onSelectLead,
}: {
  searchQuery: string;
  resyncToken?: number;
  threadContactIds: string[];
  activeLeadRunId: string | null;
  onSelectLead: (lead: AssignedLead) => void;
}) {
  const [leads, setLeads] = useState<AssignedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const gateRef = useRef(0);

  // Debounce the search query so keystrokes don't fan out requests.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 280);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const threadKey = threadContactIds.slice().sort().join(",");
  const refresh = useCallback(() => setRetry((n) => n + 1), []);

  useEffect(() => {
    const gate = ++gateRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const rows = await fetchAssignedLeads(debouncedQuery, controller.signal);
        if (gateRef.current !== gate) return;
        setLeads(rows);
      } catch (err) {
        if (gateRef.current !== gate) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLeads([]);
        setError(err instanceof Error ? err.message : "Could not load assigned leads.");
      } finally {
        if (gateRef.current === gate) setLoading(false);
      }
    })();
    return () => controller.abort();
    // threadKey (not the array identity) retriggers when threads
    // appear/disappear; resyncToken covers manual refresh +
    // workspace-values events. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, resyncToken, threadKey, retry]);

  const visible = leads.filter(
    (l) => !l.contact_id || !threadContactIds.includes(l.contact_id)
  );

  return (
    <section
      aria-label="Assigned leads"
      className="border-border bg-card shrink-0 border-t"
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Assigned Leads
          {!loading && visible.length > 0 ? (
            <span className="ml-1.5 font-normal">· {visible.length}</span>
          ) : null}
        </h2>
        {!loading && !error ? (
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh assigned leads"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Refresh
          </button>
        ) : null}
      </div>
      <div className="max-h-56 overflow-y-auto pb-2">
        {loading && leads.length === 0 ? (
          <p className="text-muted-foreground px-3 py-3 text-xs" role="status">
            Loading assigned leads…
          </p>
        ) : error ? (
          <div className="px-3 py-2">
            <p className="text-destructive text-xs" role="alert">{error}</p>
            <button
              type="button"
              onClick={refresh}
              className="text-primary mt-1 text-xs hover:underline"
            >
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            {debouncedQuery.trim() !== ""
              ? `No assigned leads match "${debouncedQuery.trim()}"`
              : "No assigned leads without a conversation."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {visible.map((lead) => (
              <AssignedLeadRow
                key={assignedLeadKey(lead)}
                lead={lead}
                isActive={lead.run_id === activeLeadRunId}
                onSelect={onSelectLead}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AssignedLeadRow({
  lead,
  isActive,
  onSelect,
}: {
  lead: AssignedLead;
  isActive: boolean;
  onSelect: (lead: AssignedLead) => void;
}) {
  const initial = (lead.name || "?").charAt(0).toUpperCase();
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Assigned lead ${lead.name}${lead.phone ? `, ${lead.phone}` : ""}. New lead, no WhatsApp conversation yet.`}
        aria-current={isActive ? "true" : undefined}
        onClick={() => onSelect(lead)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(lead);
          }
        }}
        className={cn(
          "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/60",
          isActive && "bg-muted"
        )}
      >
        <div className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-foreground truncate text-sm font-medium">
              {lead.name}
            </p>
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {formatLeadSubmittedAt(lead.submitted_at)}
            </span>
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {[lead.phone, lead.form_name ?? lead.flow_name].filter(Boolean).join(" · ") ||
              lead.flow_name}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            New lead · No WhatsApp conversation yet
          </p>
        </div>
      </div>
    </li>
  );
}
