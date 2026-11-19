// Contract for 170: per-table breakdown + form-aware detail.
// 156 stays immutable; 157 stays the uuid-guard baseline; 170 adds
// `tables[]` and form-only detail without changing the signature,
// security posture, lead population, or existing keys.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "170_meta_leads_team_performance_tables.sql"),
  "utf8"
);

describe("170 team performance tables additive contract", () => {
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

  it("preserves countable statuses, DISTINCT dedup, and uuid guard", () => {
    expect(sql).toContain("status IN ('received', 'processed', 'failed')");
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("p.user_id::text = btrim(av.value_text)");
  });

  it("adds a tables aggregation over the same filtered population", () => {
    expect(sql).toContain("'tables'");
    expect(sql).toContain("table_stage_agg");
    expect(sql).toContain("'formId'");
    expect(sql).toContain("'formName'");
    expect(sql).toContain("'assigned'");
    expect(sql).toContain("'unassigned'");
  });

  it("supports form-only detail without breaking aggregates-only calls", () => {
    expect(sql).toContain("v_detail := p_member IS NOT NULL OR p_form_id IS NOT NULL");
    expect(sql).toContain("p_member IS NULL");
  });

  it("never reads messages or flow_runs as a lead source", () => {
    const body = sql.slice(sql.indexOf("BEGIN"));
    expect(body).not.toMatch(/\bfrom\s+messages\b/i);
    expect(body).not.toMatch(/\bfrom\s+flow_runs\b/i);
  });
});
