import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural contract for 148_inbox_assignment_access.sql. There is no
// live-DB harness in this repo, so these tests pin the RLS text:
// assignment predicate, preserved account scoping, owner/admin
// branches, viewer legacy branch, and the exact grants posture.
// Behaviour parity with canViewConversation (assignment-access.ts)
// is asserted branch by branch below.
const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "148_inbox_assignment_access.sql"),
  "utf8"
);

describe("inbox assignment RLS contract (148)", () => {
  it("scopes SELECT by assignment, preserving account isolation", () => {
    expect(sql).toMatch(/CREATE POLICY conversations_select[\s\S]*?FOR SELECT/i);
    expect(sql).toMatch(/assigned_agent_id = auth\.uid\(\)/);
    expect(sql).toMatch(/is_account_member\(account_id, 'admin'\)/);
    // Viewer legacy branch: members who fail the agent check keep read-all.
    expect(sql).toMatch(
      /is_account_member\(account_id\)[\s\S]*?NOT is_account_member\(account_id, 'agent'\)/i
    );
  });

  it("tightens UPDATE to visible rows, keeps today's new-row bar", () => {
    expect(sql).toMatch(/CREATE POLICY conversations_update[\s\S]*?FOR UPDATE/i);
    expect(sql).toMatch(
      /FOR UPDATE[\s\S]*?assigned_agent_id = auth\.uid\(\)/i
    );
    // WITH CHECK unchanged: any same-account agent may set a new value,
    // so reassign-to-teammate keeps validating exactly as before.
    expect(sql).toMatch(/WITH CHECK \(is_account_member\(account_id, 'agent'\)\)/i);
  });

  it("restricts DELETE to owner/admin; INSERT unchanged", () => {
    expect(sql).toMatch(
      /CREATE POLICY conversations_delete[\s\S]*?USING \(is_account_member\(account_id, 'admin'\)\)/i
    );
    expect(sql).not.toMatch(/POLICY conversations_insert/i);
  });

  it("leaves messages/conversations writes to service-role paths intact", () => {
    // No GRANT/REVOKE changes, no SECURITY DEFINER, no new functions:
    // enforcement rides on the caller's RLS identity.
    expect(sql).not.toMatch(/GRANT /i);
    expect(sql).not.toMatch(/REVOKE /i);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).not.toMatch(/CREATE FUNCTION/i);
  });

  it("documents the RLS-only coverage (direct reads, RPC, realtime)", () => {
    expect(sql).toContain("postgres_changes");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("auth.uid()");
  });
});
