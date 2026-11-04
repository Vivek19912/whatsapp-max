// Migration contract for 156_meta_leads_team_performance.sql.
// No live-DB harness here, so the SQL text is pinned: single
// aggregation entry point, account isolation, the exact lead
// population, one-row-per-submission attribution, and the
// exclusion of every non-assignment data source (messages,
// conversations-as-source, flow_runs-as-source, calls,
// recordings, email/SMTP).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "156_meta_leads_team_performance.sql"),
  "utf8"
);

describe("meta leads team performance RPC contract (156)", () => {
  it("creates get_meta_leads_team_performance with the documented signature", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_meta_leads_team_performance\(/);
    expect(sql).toContain("p_form_id TEXT");
    expect(sql).toContain("p_from DATE");
    expect(sql).toContain("p_to DATE");
    expect(sql).toContain("p_member TEXT");
    expect(sql).toContain("p_page INT");
  });

  it("keeps the SECURITY INVOKER, account-derived, authenticated-only posture", () => {
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("Caller has no account");
    expect(sql).toContain("GRANT EXECUTE");
    expect(sql).toContain("TO authenticated");
    expect(sql).toContain("REVOKE ALL");
  });

  it("counts DISTINCT Meta leads with the acquisition status set", () => {
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("meta_lead_id");
    expect(sql).toContain("status IN ('received', 'processed', 'failed')");
    // DISTINCT ON dedupes duplicate webhook deliveries per account.
    expect(sql).toContain("DISTINCT ON");
  });

  it("reports at Meta's submission instant with created_at fallback", () => {
    expect(sql).toContain("COALESCE(meta_created_time, created_at)");
  });

  it("resolves fields by canonical name per flow, never by field id", () => {
    expect(sql).toContain("btrim(lower(");
    expect(sql).toContain("'assigned to'");
    expect(sql).toContain("'stage'");
    expect(sql).toContain("'lead type'");
  });

  it("identifies assignees by stable user id with an assignable-role check", () => {
    expect(sql).toContain("p.account_role IN ('owner', 'admin', 'agent')");
    expect(sql).not.toMatch(/full_name\s*=\s*btrim\(av\.value_text\)/);
  });

  it("never drops submissions without runs, contacts, or values", () => {
    // Every enrichment join is a LEFT JOIN.
    const joins = sql.match(/LEFT JOIN/g) ?? [];
    expect(joins.length).toBeGreaterThanOrEqual(5);
    expect(sql).not.toMatch(/FROM flow_runs/);
  });

  it("never reads messages, conversations-as-source, flow_runs-as-source, or call/recording tables", () => {
    const body = sql.slice(sql.indexOf("BEGIN"));
    expect(body).not.toMatch(/\bfrom\s+messages\b/i);
    expect(body).not.toMatch(/\bjoin\s+messages\b/i);
    expect(body).not.toMatch(/\bfrom\s+conversations\b/i);
    expect(body).not.toMatch(/\bfrom\s+flow_runs\b/i);
    expect(body).not.toContain("whatsapp_followups");
    expect(body).not.toContain("call_recordings");
    expect(body).not.toContain("Call Status");
    expect(body).not.toContain("Recording");
  });

  it("adds a reporting index without touching existing objects", () => {
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_team_perf");
    expect(sql).not.toMatch(/DROP TABLE|ALTER TABLE.*DROP|DELETE FROM/i);
  });

  it("returns aggregates plus an optional paginated lead list", () => {
    expect(sql).toContain("'members'");
    expect(sql).toContain("'unassigned'");
    expect(sql).toContain("'summary'");
    expect(sql).toContain("'forms'");
    expect(sql).toContain("'leads'");
    expect(sql).toContain("LIMIT v_limit OFFSET v_offset");
  });
});
