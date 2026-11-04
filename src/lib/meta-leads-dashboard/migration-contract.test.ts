// Migration contract for 155_meta_leads_dashboard.sql. No live-DB
// harness exists here, so the SQL text is pinned: function name +
// signature, SECURITY INVOKER posture, account derivation, the
// exact acquisition counting rules, and the exclusion of every
// WhatsApp-side table.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "155_meta_leads_dashboard.sql"),
  "utf8"
);

describe("meta leads dashboard RPC contract (155)", () => {
  it("creates get_meta_leads_analytics with the documented signature", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_meta_leads_analytics\(/);
    expect(sql).toContain("p_today_start TIMESTAMPTZ");
    expect(sql).toContain("p_today_end TIMESTAMPTZ");
    expect(sql).toContain("p_yest_start TIMESTAMPTZ");
    expect(sql).toContain("p_yest_end TIMESTAMPTZ");
    expect(sql).toContain("p_year INT");
  });

  it("keeps the SECURITY INVOKER, account-derived, authenticated-only posture", () => {
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("Caller has no account");
    expect(sql).toContain("GRANT EXECUTE");
    expect(sql).toContain("TO authenticated");
    expect(sql).toContain("REVOKE ALL");
  });

  it("counts distinct Meta lead ids with the acquisition status set", () => {
    // received + processed + failed count; ignored never does.
    expect(sql).toContain("status IN ('received', 'processed', 'failed')");
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("meta_lead_id");
    // Ignored appears only inside the exclusion documentation/status
    // list context — never as a counted status.
    const counted = sql.match(/status IN \([^)]*\)/g) ?? [];
    expect(counted.length).toBeGreaterThan(0);
    for (const clause of counted) {
      expect(clause).not.toContain("ignored");
    }
  });

  it("reports at Meta's submission instant with created_at fallback", () => {
    expect(sql).toContain("COALESCE(meta_created_time, created_at)");
  });

  it("never reads WhatsApp-side tables", () => {
    // No messages, no flow_runs, no conversations, no contacts —
    // the acquisition dashboard cannot drift with messaging activity.
    const body = sql.slice(sql.indexOf("BEGIN"));
    expect(body).not.toMatch(/\bfrom\s+messages\b/i);
    expect(body).not.toMatch(/\bjoin\s+messages\b/i);
    expect(body).not.toMatch(/\bflow_runs\b/i);
    expect(body).not.toMatch(/\bconversations\b/i);
    expect(body).not.toMatch(/\bfrom\s+contacts\b/i);
    expect(body).not.toMatch(/\bjoin\s+contacts\b/i);
  });

  it("buckets days and months in the caller timezone with zero-fill", () => {
    expect(sql).toContain("AT TIME ZONE v_tz");
    expect(sql).toContain("generate_series");
    expect(sql).toContain("LEFT JOIN");
  });

  it("adds a reporting index without touching existing objects", () => {
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_meta_lead_submissions_reporting");
    expect(sql).not.toMatch(/DROP TABLE|ALTER TABLE.*DROP|DELETE FROM/i);
  });
});

describe("existing WhatsApp dashboard untouched", () => {
  const dashboardSql = [
    "074_dashboard_analytics.sql",
    "075_dashboard_monthly_flows.sql",
    "079_dashboard_flow_contacts.sql",
    "080_dashboard_daily_contacts.sql",
    "081_dashboard_contacts_by_ad.sql",
    "082_dashboard_daily_flows.sql",
    "083_dashboard_daily_range.sql",
  ]
    .map((f) =>
      readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8")
    )
    .join("\n");

  it("no WhatsApp dashboard migration reads lead submissions", () => {
    expect(dashboardSql).not.toContain("meta_lead_submissions");
  });

  it("the Meta dashboard reads no message/flow/contact tables anywhere", () => {
    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "meta-lead-ads", "dashboard", "route.ts"),
      "utf8"
    );
    expect(route).toContain("get_meta_leads_analytics");
    expect(route).not.toContain("get_dashboard_analytics");
    expect(route).not.toContain("whatsapp_followups");
  });
});
