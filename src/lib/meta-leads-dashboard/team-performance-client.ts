// Loader + normalizers for Team Member Lead Performance. One
// GET /api/meta-lead-ads/team-performance per section state
// (filters + optional View Leads page). Totals and splits pass
// straight through from the RPC — never recomputed here.

import type {
  MetaLeadForm,
  TeamLeadRow,
  TeamMemberPerformance,
  TeamPerformanceData,
  TeamPerformanceSummary,
  UnassignedPerformance,
} from "./team-performance-types";

export interface TeamPerformanceParams {
  formId?: string | null;
  /** YYYY-MM-DD calendar bounds in tz; both or neither. */
  from?: string | null;
  to?: string | null;
  tz: string;
  /** user_id | "unassigned" — absent = aggregates only. */
  member?: string | null;
  /** Exact Stage value | "__none__" | absent. */
  stage?: string | null;
  /** Exact Type value | "__none__" | absent. */
  type?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

function toCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function normalizeStageSplit(input: unknown): Array<{ stage: string | null; leads: number }> {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).flatMap((s) => {
    if (!isRecord(s)) return [];
    const stage = s.stage;
    if (stage !== null && typeof stage !== "string") return [];
    return [{ stage, leads: toCount(s.leads) }];
  });
}

function normalizeTypeSplit(input: unknown): Array<{ type: string | null; leads: number }> {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).flatMap((t) => {
    if (!isRecord(t)) return [];
    const type = t.type;
    if (type !== null && typeof type !== "string") return [];
    return [{ type, leads: toCount(t.leads) }];
  });
}

function normalizeMember(input: unknown): TeamMemberPerformance | null {
  if (!isRecord(input) || typeof input.userId !== "string" || input.userId === "") return null;
  return {
    userId: input.userId,
    name: typeof input.name === "string" && input.name !== "" ? input.name : "Unnamed member",
    email: typeof input.email === "string" ? input.email : null,
    avatarUrl: typeof input.avatar === "string" ? input.avatar : null,
    total: toCount(input.total),
    stages: normalizeStageSplit(input.stages),
    types: normalizeTypeSplit(input.types),
  };
}

function normalizeUnassigned(input: unknown): UnassignedPerformance {
  const r = isRecord(input) ? input : {};
  return {
    total: toCount(r.total),
    stages: normalizeStageSplit(r.stages),
    types: normalizeTypeSplit(r.types),
  };
}

function normalizeSummary(input: unknown): TeamPerformanceSummary {
  const r = isRecord(input) ? input : {};
  const total = toCount(r.total);
  const assigned = toCount(r.assigned);
  const unassigned = toCount(r.unassigned);
  return { total, assigned, unassigned };
}

function normalizeForms(input: unknown): MetaLeadForm[] {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).flatMap((f) => {
    if (!isRecord(f) || typeof f.formId !== "string" || f.formId === "") return [];
    return [{
      formId: f.formId,
      formName: typeof f.formName === "string" && f.formName !== "" ? f.formName : f.formId,
    }];
  });
}

function normalizeLeadRow(input: unknown): TeamLeadRow | null {
  if (!isRecord(input)) return null;
  if (typeof input.date !== "string") return null;
  const at = Date.parse(input.date);
  // Invalid timestamps are dropped, never fabricated.
  if (Number.isNaN(at)) return null;
  return {
    date: new Date(at).toISOString(),
    leadName: typeof input.leadName === "string" ? input.leadName : null,
    leadPhone: typeof input.leadPhone === "string" ? input.leadPhone : null,
    formName: typeof input.formName === "string" ? input.formName : "Unknown form",
    assigneeName: typeof input.assigneeName === "string" ? input.assigneeName : null,
    type: typeof input.type === "string" ? input.type : null,
    stage: typeof input.stage === "string" ? input.stage : null,
  };
}

/** Map RPC snake_case lead rows onto the client shape. */
export function normalizeLeadRows(input: unknown): TeamLeadRow[] {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).flatMap((r) => {
    if (!isRecord(r)) return [];
    return [normalizeLeadRow({
      date: r.ts,
      leadName: r.contact_name,
      leadPhone: r.contact_phone,
      formName: r.form_name,
      assigneeName: r.assignee_name,
      type: r.type,
      stage: r.stage,
    })].filter((x): x is TeamLeadRow => x !== null);
  });
}

export async function loadTeamPerformance(
  params: TeamPerformanceParams,
  signal?: AbortSignal,
): Promise<TeamPerformanceData> {
  const qs = new URLSearchParams({ tz: params.tz });
  if (params.formId) qs.set("formId", params.formId);
  if (params.from && params.to) {
    qs.set("from", params.from);
    qs.set("to", params.to);
  }
  if (params.member) qs.set("member", params.member);
  if (params.stage !== undefined && params.stage !== null) qs.set("stage", params.stage);
  if (params.type !== undefined && params.type !== null) qs.set("type", params.type);
  if (params.search) qs.set("search", params.search);
  qs.set("page", String(params.page ?? 1));
  qs.set("pageSize", String(params.pageSize ?? 25));
  const res = await fetch(`/api/meta-lead-ads/team-performance?${qs.toString()}`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Team performance request failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    members?: unknown;
    unassigned?: unknown;
    summary?: unknown;
    forms?: unknown;
    leads?: unknown;
  };
  const leadsRaw = isRecord(json.leads) ? json.leads : {};
  return {
    members: Array.isArray(json.members)
      ? (json.members as unknown[]).flatMap((m) => {
          const n = normalizeMember(m);
          return n ? [n] : [];
        })
      : [],
    unassigned: normalizeUnassigned(json.unassigned),
    summary: normalizeSummary(json.summary),
    forms: normalizeForms(json.forms),
    leadsTotal: toCount(leadsRaw.total),
    leads: normalizeLeadRows(leadsRaw.rows),
  };
}
