// Contract for 171: per-member/per-unassigned form splits.
// 156 stays immutable; 157 the uuid-guard baseline; 170 added
// `tables[]` + form-aware detail. 171 adds `forms[]` to every
// `members[]` entry and to `unassigned` without changing the
// signature, security posture, lead population, or existing keys.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "171_meta_leads_team_performance_member_forms.sql"),
  "utf8"
);

describe("171 team performance member-form splits additive contract", () => {
  it("keeps the same function signature and security posture", () => {
    for (const needle of [
      "CREATE OR REPLACE FUNCTION public.get_meta_leads_team_performance(",
      "p_form_id TEXT",
      "p_from DATE",
      "p_to DATE",
      "RETURNS JSONB",
      "SECURITY INVOKER",
      "auth.uid()",
      "GRANT EXECUTE",
      "TO authenticated",
    ]) {
      expect(sql).toContain(needle);
    }
  });

  it("preserves countable statuses, DISTINCT dedup, uuid guard, and detail rules", () => {
    expect(sql).toContain("status IN ('received', 'processed', 'failed')");
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("p.user_id::text = btrim(av.value_text)");
    expect(sql).toContain("v_detail := p_member IS NOT NULL OR p_form_id IS NOT NULL");
  });

  it("adds member_form_agg grouped by assignee and form", () => {
    expect(sql).toContain("member_form_agg");
    expect(sql).toContain("GROUP BY la.assignee_id, la.form_id");
  });

  it("emits forms[] on members and unassigned with formId/formName/leads", () => {
    const matches = sql.match(/'forms'/g) ?? [];
    // members + unassigned (+ tables, pre-existing)
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("'formId'");
    expect(sql).toContain("'formName'");
    expect(sql).toContain("IS NOT DISTINCT FROM r.user_id::text");
    expect(sql).toContain("mfa.assignee_id IS NULL");
  });

  it("never reads messages or flow_runs as a lead source", () => {
    const body = sql.slice(sql.indexOf("BEGIN"));
    expect(body).not.toMatch(/\bfrom\s+messages\b/i);
    expect(body).not.toMatch(/\bfrom\s+flow_runs\b/i);
  });
});
