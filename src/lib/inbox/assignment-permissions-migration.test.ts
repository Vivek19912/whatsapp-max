import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: 149_agent_inbox_permissions.sql introduces the
// agent_inbox_permissions table with owner-only management, a
// SECURITY DEFINER permission helper, and wires View All into the
// conversations read policy. Additive only — 148 and everything
// before it are untouched.
const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "149_agent_inbox_permissions.sql"),
  "utf8"
);

describe("agent inbox permissions migration (149)", () => {
  it("creates the permissions table with a per-account, per-agent primary key", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.agent_inbox_permissions/i);
    expect(sql).toMatch(/PRIMARY KEY \(account_id, user_id\)/i);
    expect(sql).toMatch(/can_manage_assignments BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(sql).toMatch(/can_view_all BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(sql).toContain("REFERENCES accounts(id)");
    expect(sql).toContain("REFERENCES auth.users(id)");
  });

  it("restricts table access: owners manage, agents read only their own row", () => {
    expect(sql).toMatch(/CREATE POLICY agent_inbox_permissions_update[\s\S]*?USING \(is_account_member\(account_id, 'owner'\)\)/i);
    expect(sql).toMatch(/CREATE POLICY agent_inbox_permissions_delete[\s\S]*?USING \(is_account_member\(account_id, 'owner'\)\)/i);
    expect(sql).toMatch(/WITH CHECK \(is_account_member\(account_id, 'owner'\)\)/i);
    // No GRANT to anon; execute grants stay authenticated-only.
    expect(sql).not.toMatch(/TO anon/i);
    expect(sql).not.toMatch(/TO public/i);
  });

  it("provides a SECURITY DEFINER permission helper usable in RLS", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.has_inbox_permission\(/i);
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/SET search_path = public/i);
    // Unknown permission names match nothing (fail closed).
    expect(sql).toMatch(/\(perm = 'manage_assignments' AND p\.can_manage_assignments\)/i);
    expect(sql).toMatch(/\(perm = 'view_all' AND p\.can_view_all\)/i);
    // Stale rows never grant: the subject must still be an agent.
    expect(sql).toMatch(/account_role = 'agent'/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.has_inbox_permission/i);
  });

  it("extends the conversations read policy with the View All branch", () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS conversations_select/i);
    expect(sql).toMatch(/CREATE POLICY conversations_select[\s\S]*?FOR SELECT/i);
    expect(sql).toMatch(/has_inbox_permission\(account_id, 'view_all'\)/i);
    // Owner/admin/own-assignment/viewer branches are preserved.
    expect(sql).toMatch(/is_account_member\(account_id, 'admin'\)/i);
    expect(sql).toMatch(/assigned_agent_id = auth\.uid\(\)/i);
  });

  it("is additive and re-runnable", () => {
    // No changes to workspace_values, messages, contacts, pins, or
    // existing assignment tables — only the two named objects.
    expect(sql).not.toMatch(/workspace_values/);
    expect(sql).not.toMatch(/meta_lead_submissions/);
    expect(sql).not.toMatch(/agent_inbox_conversations/i);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/i);
    expect(sql).toContain("IF NOT EXISTS");
  });
});
