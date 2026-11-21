// Team Activity feed — types + client loader for the owner-only
// Meta Lead Ads Team Performance dashboard.
//
// Genuine audit-only feed: every entry carries a real actor (team
// member, never the owner), a real action, a real timestamp, and the
// correct Meta Lead Ads table. System-attributed rows (auto
// assignment with NULL actor, ingestion, etc.) are excluded at the
// query level — never fabricated in the UI.
//
// Supported activity types (real sources only):
//   lead_assigned     — manual assignment, no previous owner
//                       (lead_assignment_events kind=manual/auto with
//                       created_by team member + previous NULL)
//                       NOTE: fully-automatic system picks with NULL
//                       created_by are excluded (no reliable actor).
//   lead_reassigned   — manual reassignment (previous owner present)
//   lead_unassigned   — manual clear/unassign with actor
//   followup_scheduled— workspace-linked reminder created
//                       (whatsapp_followups created_by + source_run_id)
//   note_added        — contact note (contact_notes.user_id)
//   whatsapp_sent     — outbound agent message to a Meta lead contact
//                       (messages sender_type=agent + sender_id)
//
// Documented gaps (no reliable actor — excluded, never invented):
//   - Lead captured (ingestion is system; no team actor)
//   - Lead stage / info updates (workspace_values + overrides have
//     no actor columns)
//   - Follow-up edited/cancelled actor (PATCH route stores no
//     updated_by/cancelled_by; only creator is known)
//   - Workspace table / assignment-config updates (no actor columns)
//   - Team member added (no actor audit)

export type TeamActivityType =
  | "lead_assigned"
  | "lead_reassigned"
  | "lead_unassigned"
  | "followup_scheduled"
  | "note_added"
  | "whatsapp_sent";

export const TEAM_ACTIVITY_TYPES: Array<{ value: TeamActivityType; label: string }> = [
  { value: "lead_assigned", label: "Lead assigned" },
  { value: "lead_reassigned", label: "Lead reassigned" },
  { value: "lead_unassigned", label: "Lead unassigned" },
  { value: "followup_scheduled", label: "Follow-up scheduled" },
  { value: "note_added", label: "Note added" },
  { value: "whatsapp_sent", label: "WhatsApp message sent" },
];

export function isTeamActivityType(v: string | null): v is TeamActivityType {
  return (
    v === "lead_assigned" ||
    v === "lead_reassigned" ||
    v === "lead_unassigned" ||
    v === "followup_scheduled" ||
    v === "note_added" ||
    v === "whatsapp_sent"
  );
}

export interface TeamActivityItem {
  id: string;
  type: TeamActivityType;
  title: string;
  description: string;
  timestamp: string;
  actorId: string;
  actorName: string;
  leadName: string | null;
  leadId: string | null;
  tableId: string | null;
  tableName: string | null;
}

export interface TeamActivityMember {
  userId: string;
  name: string;
}

export interface TeamActivityTable {
  flowId: string;
  name: string;
}

export interface TeamActivityParams {
  search?: string | null;
  member?: string | null;
  activityType?: string | null;
  tableId?: string | null;
  from?: string | null;
  to?: string | null;
  tz?: string;
  cursor?: string | null;
  limit?: number;
}

export interface TeamActivityResponse {
  activities: TeamActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function normalizeTeamActivityResponse(json: unknown): TeamActivityResponse {
  const r = (json ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(r.activities) ? r.activities : [];
  const activities: TeamActivityItem[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const er = e as Record<string, unknown>;
    if (typeof er.id !== "string" || typeof er.timestamp !== "string") continue;
    if (typeof er.actorId !== "string" || typeof er.actorName !== "string") continue;
    if (typeof er.title !== "string" || typeof er.description !== "string") continue;
    if (typeof er.type !== "string" || !isTeamActivityType(er.type)) continue;
    activities.push({
      id: er.id,
      type: er.type,
      title: er.title,
      description: er.description,
      timestamp: er.timestamp,
      actorId: er.actorId,
      actorName: er.actorName,
      leadName: typeof er.leadName === "string" ? er.leadName : null,
      leadId: typeof er.leadId === "string" ? er.leadId : null,
      tableId: typeof er.tableId === "string" ? er.tableId : null,
      tableName: typeof er.tableName === "string" ? er.tableName : null,
    });
  }
  return {
    activities,
    nextCursor: typeof r.nextCursor === "string" ? r.nextCursor : null,
    hasMore: r.hasMore === true,
  };
}

export async function loadTeamActivity(
  params: TeamActivityParams,
  signal?: AbortSignal,
): Promise<TeamActivityResponse> {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.member) qs.set("member", params.member);
  if (params.activityType) qs.set("activityType", params.activityType);
  if (params.tableId) qs.set("tableId", params.tableId);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  qs.set("tz", params.tz || "UTC");
  if (params.cursor) qs.set("cursor", params.cursor);
  qs.set("limit", String(params.limit ?? 20));
  const res = await fetch(`/api/meta-lead-ads/team-activity?${qs.toString()}`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Team activity failed: ${res.status}`);
  return normalizeTeamActivityResponse(await res.json());
}
