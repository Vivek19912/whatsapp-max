// Migration contract for 169_meta_leads_agent_dashboard.sql.
// Same posture as 155 (SECURITY INVOKER, account derived from
// auth.uid(), authenticated-only) plus self-scoping: the member is
// derived from auth.uid() inside the RPC — no member param — so an
// agent cannot request another member's data. Assignment
// resolution mirrors 156/157 (Assigned To UUID text, uuid guard,
// assignable roles only); unassigned leads never match `mine`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "169_meta_leads_agent_dashboard.sql"),
  "utf8",
);

describe("meta leads agent dashboard RPC contract (169)", () => {
  it("creates get_meta_leads_agent_analytics with the owner-dashboard signature", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_meta_leads_agent_analytics\(/);
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

  it("derives the member from auth.uid() with no member param", () => {
    expect(sql).toContain("v_member_id");
    expect(sql).not.toMatch(/p_member\b/);
    expect(sql).toContain("assignee_id = v_member_id");
  });

  it("counts distinct Meta lead ids with the acquisition status set", () => {
    expect(sql).toContain("status IN ('received', 'processed', 'failed')");
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("meta_lead_id");
    const counted = sql.match(/status IN \([^)]*\)/g) ?? [];
    expect(counted.length).toBeGreaterThan(0);
    for (const clause of counted) {
      expect(clause).not.toContain("ignored");
    }
  });

  it("resolves assignment from the Assigned To cell with the uuid guard", () => {
    expect(sql).toContain("assigned to");
    expect(sql).toContain("p.user_id::text = btrim(av.value_text)");
    expect(sql).toContain("'owner', 'admin', 'agent'");
    expect(sql).toContain("Unassigned");
  });

  it("returns assignedTotal plus daily/monthly/stages for the caller", () => {
    expect(sql).toContain("assignedTotal");
    expect(sql).toContain("'daily'");
    expect(sql).toContain("'monthly'");
    expect(sql).toContain("'stages'");
  });

  it("never reads WhatsApp-side tables", () => {
    const body = sql.slice(sql.indexOf("BEGIN"));
    expect(body).not.toMatch(/\bfrom\s+messages\b/i);
    expect(body).not.toMatch(/\bjoin\s+messages\b/i);
    expect(body).not.toMatch(/\bconversations\b/i);
    expect(body).not.toMatch(/\bfrom\s+contacts\b/i);
    expect(body).not.toMatch(/\bjoin\s+contacts\b/i);
  });
});
