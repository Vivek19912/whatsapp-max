// Contract for 172: Meta dummy-phone test leads are excluded from
// ALL Meta Lead Ads dashboard analytics via one centralized SQL
// predicate. 155/156/157/169/170/171 stay immutable; 172 re-creates
// the three dashboard RPCs with the identical signatures, security
// posture, and counting rules plus the exclusion, and adds the
// helper. No live-DB harness exists here, so the SQL text is pinned.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "172_meta_leads_dummy_phone_exclusion.sql"),
  "utf8"
);

describe("172 centralized dummy-phone predicate", () => {
  it("defines is_meta_dummy_phone_lead over the standard phone keys with safe normalization", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.is_meta_dummy_phone_lead(");
    for (const key of ["phone_number", "phone", "mobile", "mobile_number", "whatsapp_number"]) {
      expect(sql).toContain(`p_answers ->> '${key}'`);
      expect(sql).toContain(`p_vars ->> '${key}'`);
    }
    expect(sql).toContain("lower(regexp_replace(btrim(v)");
    expect(sql).toContain("<test lead: dummy data for phone_number>");
    expect(sql).toContain("IMMUTABLE");
    expect(sql).toContain("GRANT EXECUTE");
    expect(sql).toContain("TO authenticated");
  });

  it("applies the SAME predicate in all three dashboard RPCs", () => {
    const uses = sql.match(/NOT public\.is_meta_dummy_phone_lead\(/g) ?? [];
    // Owner (leads CTE) + agent (leads CTE) + team (lead_attr) = 3.
    expect(uses.length).toBe(3);
  });

  it("keeps all three function signatures, security posture, and grants", () => {
    for (const needle of [
      "CREATE OR REPLACE FUNCTION public.get_meta_leads_analytics(",
      "CREATE OR REPLACE FUNCTION public.get_meta_leads_agent_analytics(",
      "CREATE OR REPLACE FUNCTION public.get_meta_leads_team_performance(",
      "SECURITY INVOKER",
      "auth.uid()",
      "Caller has no account",
      "REVOKE ALL",
    ]) {
      expect(sql).toContain(needle);
    }
  });

  it("filters before aggregation so every breakdown reconciles", () => {
    // Owner/agent: predicate inside the leads CTE (feeds KPIs, daily, monthly).
    const ownerBody = sql.slice(sql.indexOf("get_meta_leads_analytics("));
    expect(ownerBody).toContain("AND NOT public.is_meta_dummy_phone_lead(s.answers, NULL)");
    // Team: predicate in lead_attr (feeds members/unassigned/summary/tables/stages/forms/detail).
    const teamBody = sql.slice(sql.indexOf("get_meta_leads_team_performance("));
    expect(teamBody).toContain("WHERE NOT public.is_meta_dummy_phone_lead(l.answers, r.vars)");
    // Detail rows derive from the filtered lead_attr, so View Leads excludes dummies too.
    expect(teamBody.indexOf("is_meta_dummy_phone_lead")).toBeLessThan(
      teamBody.indexOf("detail_base AS ("),
    );
  });

  it("never deletes, updates, or reprocesses leads — read-only analytics filter", () => {
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE meta_lead_submissions\b/i);
    expect(sql).not.toMatch(/\bUPDATE flow_runs\b/i);
  });

  it("acquisition RPCs still never read flow_runs or messages as a lead source", () => {
    // Convention (mirrors the 155/157 contract tests): flow_runs may
    // only appear in JOINs for assignment attribution (agent/team),
    // never as a FROM lead source; the owner RPC reads neither.
    const ownerFn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.get_meta_leads_analytics("),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.get_meta_leads_agent_analytics("),
    );
    expect(ownerFn).not.toMatch(/\bfrom\s+messages\b/i);
    expect(ownerFn).not.toMatch(/\bfrom\s+flow_runs\b/i);
    expect(ownerFn).not.toMatch(/\bjoin\s+flow_runs\b/i);
    const agentFn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.get_meta_leads_agent_analytics("),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.get_meta_leads_team_performance("),
    );
    expect(agentFn).not.toMatch(/\bfrom\s+messages\b/i);
    expect(agentFn).not.toMatch(/\bfrom\s+flow_runs\b/i);
  });
});
