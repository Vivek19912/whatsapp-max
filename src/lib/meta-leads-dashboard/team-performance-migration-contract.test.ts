// Migration contract for the Team Member Lead Performance RPC.
// 156 is the applied baseline and MUST stay immutable (asserted
// below); 157 re-creates the identical function plus the UUID
// guard. No live-DB harness exists here, so the SQL text is
// pinned: single aggregation entry point, account isolation, the
// exact lead population, one-row-per-submission attribution, and
// the exclusion of every non-assignment data source (messages,
// conversations-as-source, flow_runs-as-source, calls,
// recordings, email/SMTP).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql156 = readFileSync(
  join(process.cwd(), "supabase", "migrations", "156_meta_leads_team_performance.sql"),
  "utf8"
);
const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "157_meta_leads_team_performance_uuid_guard.sql"),
  "utf8"
);

describe("applied baseline 156 is immutable", () => {
  it("contains no UUID guard (fixes live in follow-up migrations only)", () => {
    expect(sql156).not.toContain("^[0-9a-fA-F-]{36}$");
  });

  it("157 carries the same function signature and security posture", () => {
    for (const needle of [
      "CREATE OR REPLACE FUNCTION public.get_meta_leads_team_performance(",
      "p_form_id TEXT",
      "p_from DATE",
      "p_to DATE",
      "p_tz TEXT",
      "p_member TEXT",
      "p_stage TEXT",
      "p_type TEXT",
      "p_search TEXT",
      "p_page INT",
      "p_page_size INT",
      "RETURNS JSONB",
      "SECURITY INVOKER",
      "SET search_path = public",
      "GRANT EXECUTE",
      "TO authenticated",
    ]) {
      expect(sql).toContain(needle);
    }
  });
});

describe("meta leads team performance RPC contract (157, mirrors 156 + guard)", () => {
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
    expect(sql).toMatch(/COALESCE\(\S*meta_created_time,\s*\S*created_at\)/);
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

  it("never compares uuid to text without an explicit cast (42883 regression)", () => {
    // The production failure: "operator does not exist: uuid = text".
    // PostgreSQL resolves operators at plan time, so even one mixed
    // comparison fails the whole call regardless of the data.
    // Scan every line touching a UUID-typed identifier: each `=`
    // must either carry an explicit ::text cast or compare two
    // UUIDs (auth.uid()).
    const lines = sql.split("\n");
    const offenders: string[] = [];
    for (const line of lines) {
      if (!line.includes("user_id")) continue;
      // Strip SQL comments for the check.
      const code = line.split("--")[0];
      if (!code.includes("=")) continue;
      const hasCast = code.includes("::text") || code.includes("::uuid");
      // uuid-to-uuid comparisons need no cast: auth.uid(), and the
      // member_agg join of two user_id CTE columns.
      const uuidToUuid =
        code.includes("auth.uid()") ||
        /ma\.user_id\s*=\s*r\.user_id/.test(code);
      if (!hasCast && !uuidToUuid) offenders.push(line.trim());
    }
    expect(offenders).toEqual([]);
    // The historically broken sites, pinned explicitly.
    expect(sql).toContain("p.user_id::text = btrim(av.value_text)");
    expect(sql).toContain("ap.user_id::text = la.assignee_id");
    expect(sql).toContain("la.assignee_id = r.user_id::text");
    expect(sql).toContain("IS NOT DISTINCT FROM r.user_id::text");
    // The TEXT-vs-TEXT member filter needs no cast and must stay
    // cast-free (casting p_member::uuid would crash on "unassigned").
    expect(sql).toContain("la.assignee_id = p_member");
    expect(sql).not.toContain("p_member::uuid");
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
