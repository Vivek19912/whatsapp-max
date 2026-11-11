/**
 * Assigned Meta Lead Ads leads without a WhatsApp conversation yet.
 *
 * The Inbox conversation list can only render `conversations` rows,
 * but an assigned lead exists as `flow_runs` + Assigned To cell long
 * before the first message creates its thread. This module fetches
 * those lead-only entries from the server-scoped endpoint so the
 * Inbox can show them in a dedicated Assigned Leads section —
 * without fabricating conversations, messages, or previews.
 */

/** One lead-only entry, as returned by GET /api/inbox/assigned-leads. */
export interface AssignedLead {
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

/** Lead-only list key prefix (never collides with conversation ids). */
export const ASSIGNED_LEAD_KEY_PREFIX = "lead:";

export function assignedLeadKey(lead: Pick<AssignedLead, "run_id">): string {
  return `${ASSIGNED_LEAD_KEY_PREFIX}${lead.run_id}`;
}

export async function fetchAssignedLeads(
  query?: string,
  signal?: AbortSignal,
): Promise<AssignedLead[]> {
  const params = new URLSearchParams();
  const q = (query ?? "").trim();
  if (q !== "") params.set("q", q);
  const suffix = params.toString() !== "" ? `?${params.toString()}` : "";
  const res = await fetch(`/api/inbox/assigned-leads${suffix}`, { signal });
  const json = (await res.json().catch(() => null)) as {
    leads?: AssignedLead[];
    error?: string;
  } | null;
  if (!res.ok || !json || !Array.isArray(json.leads)) {
    throw new Error(json?.error || "Could not load assigned leads.");
  }
  return json.leads;
}

/** Human submission time for lead-only sorting/display. */
export function formatLeadSubmittedAt(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  try {
    return new Date(at).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
