// Shared shapes for Team Member Lead Performance (Meta Lead Ads
// dashboard). Assignment + Stage + Type only — no calls, no
// messages, no conversations.

export interface TeamMemberPerformance {
  /** Stable profiles.user_id (never a display name). */
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  /** Distinct Meta submissions currently assigned. */
  total: number;
  /** Raw Stage values with counts; missing renders as "No Stage". */
  stages: Array<{ stage: string | null; leads: number }>;
  /** Raw Type values with counts; missing renders as "Not Set". */
  types: Array<{ type: string | null; leads: number }>;
}

export interface UnassignedPerformance {
  total: number;
  stages: Array<{ stage: string | null; leads: number }>;
  types: Array<{ type: string | null; leads: number }>;
}

export interface TeamPerformanceSummary {
  total: number;
  assigned: number;
  unassigned: number;
}

export interface MetaLeadForm {
  formId: string;
  formName: string;
}

export interface TeamLeadRow {
  /** Reporting instant (Meta original, created_at fallback), ISO. */
  date: string;
  leadName: string | null;
  leadPhone: string | null;
  formName: string;
  assigneeName: string | null;
  type: string | null;
  stage: string | null;
}

export interface TeamPerformanceData {
  members: TeamMemberPerformance[];
  unassigned: UnassignedPerformance;
  summary: TeamPerformanceSummary;
  forms: MetaLeadForm[];
  leadsTotal: number;
  leads: TeamLeadRow[];
}

export const UNASSIGNED_KEY = "unassigned";
export const NO_STAGE_VALUE = "__none__";
export const NO_TYPE_VALUE = "__none__";
export const NO_STAGE_LABEL = "No Stage";
export const NO_TYPE_LABEL = "Not Set";
