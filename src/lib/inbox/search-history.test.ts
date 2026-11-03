import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Regression coverage for migration 085 (historical message search).
//
// There is no live-DB harness in this repo (all vitest suites are pure
// unit tests), so the RPC itself cannot be executed here. These tests
// pin the migration's structural contract instead: the EXISTS branch,
// account scoping, preserved filters/pagination/ordering, and the
// unchanged security posture. A behavioural matrix lives in the
// migration header; execute it against a real database on deploy.

function loadSearchMigrations(): { file: string; sql: string }[] {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => /inbox_search/.test(f))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), "utf8") }));
}

function latestSearchMigration(): { file: string; sql: string } {
  const all = loadSearchMigrations();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

describe("inbox search history migration", () => {
  it("a newer search migration exists on top of 078", () => {
    const all = loadSearchMigrations();
    expect(all.map((m) => m.file)).toContain("078_inbox_search.sql");
    const latest = all[all.length - 1];
    expect(latest.file).not.toBe("078_inbox_search.sql");
    // 078 itself is untouched: still last-message-only, no messages branch.
    const base = all.find((m) => m.file === "078_inbox_search.sql")!;
    expect(base.sql).not.toMatch(/FROM messages/i);
  });

  it("adds an EXISTS branch over messages.content_text", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM messages m[\s\S]*?m\.content_text ILIKE '%' \|\| v_qesc \|\| '%' ESCAPE '\\'/i,
    );
  });

  it("correlates messages via the conversation (no messages.account_id)", () => {
    // messages carries no account_id column (see 074) — scoping must
    // ride on m.conversation_id = c.id under the outer account filter.
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/m\.conversation_id\s*=\s*c\.id/i);
    expect(sql).not.toMatch(/m\.account_id/i);
    expect(sql).not.toMatch(/messages\s*\(\s*account_id/i);
  });

  it("retains every existing text branch", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/c\.last_message_text ILIKE/i);
    expect(sql).toMatch(/ct\.name ILIKE/i);
    expect(sql).toMatch(/ct\.phone ILIKE/i);
    expect(sql).toMatch(/ct\.phone_normalized ILIKE/i);
  });

  it("reuses the escaped LIKE variable (%, _, \\ safe; ? literal)", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/v_qesc\s*:=.*replace.*%.*\\%/i);
    // The messages branch must use the escaped variable, not raw input.
    expect(sql).not.toMatch(/m\.content_text ILIKE '%' \|\| v_q \|\| '%'/i);
  });

  it("keeps SECURITY INVOKER and never DEFINER", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/SECURITY INVOKER/i);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it("keeps grants: authenticated only, revoked from PUBLIC", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_inbox_conversations[\s\S]*?TO authenticated/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.search_inbox_conversations/i);
  });

  it("preserves signature, filters, ordering, and keyset pagination", () => {
    const { sql } = latestSearchMigration();
    // Signature: the 11 original params in the same order, plus the
    // trailing p_source Lead Source facet (DEFAULT 'all', so every
    // existing caller keeps working unchanged).
    expect(sql).toMatch(
      /search_inbox_conversations\(\s*p_search TEXT,\s*p_status TEXT[^)]*p_limit INT DEFAULT 25\s*,\s*p_source TEXT DEFAULT 'all'\s*\)/i,
    );
    for (const facet of [
      "p_status",
      "p_tag_ids",
      "p_company",
      "p_flow_id",
      "p_member_ids",
      "p_from",
      "p_to",
      "p_source",
    ]) {
      expect(sql).toContain(facet);
    }
    expect(sql).toMatch(
      /ORDER BY c\.last_message_at DESC NULLS FIRST, c\.id DESC/i,
    );
    expect(sql).toMatch(/LIMIT v_limit \+ 1/i);
    expect(sql).toMatch(/p_cur_id IS NULL/i);
  });

  it("enables pg_trgm and adds a GIN trigram index on content_text", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_messages_content_text_trgm\s+ON messages USING gin\s*\(\s*content_text gin_trgm_ops\s*\)/i,
    );
  });

  it("uses EXISTS (dedup-safe) rather than a messages JOIN", () => {
    const { sql } = latestSearchMigration();
    expect(sql).not.toMatch(/JOIN messages/i);
    expect(sql).not.toMatch(/FROM messages m,/i);
  });
});

describe("inbox search Lead Source facet (147)", () => {
  it("replaces the 11-arg overload instead of leaving an ambiguous one", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.search_inbox_conversations\(\s*TEXT,\s*TEXT,\s*UUID\[\],\s*TEXT,\s*TEXT,\s*TEXT\[\],\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*UUID,\s*INT\s*\)/i,
    );
  });

  it("keeps grants on the 12-arg signature: authenticated only, revoked from PUBLIC", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.search_inbox_conversations\(\s*TEXT,\s*TEXT,\s*UUID\[\],\s*TEXT,\s*TEXT,\s*TEXT\[\],\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*UUID,\s*INT,\s*TEXT\s*\)[\s\S]*?TO authenticated/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.search_inbox_conversations\(\s*TEXT,\s*TEXT,\s*UUID\[\],\s*TEXT,\s*TEXT,\s*TEXT\[\],\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*TIMESTAMPTZ,\s*UUID,\s*INT,\s*TEXT\s*\)[\s\S]*?FROM PUBLIC/i,
    );
  });

  it("matches Instant Form via processed-submission EXISTS (dedup-safe)", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/p_source = 'instant_form'/i);
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM meta_lead_submissions s[\s\S]*?s\.contact_id = c\.contact_id[\s\S]*?s\.status = 'processed'/i,
    );
    // Account-scoped twice: explicit submission predicate on top of the
    // contact join.
    expect(sql).toMatch(/s\.account_id = v_account_id/i);
    // No JOIN — repeat submissions from one contact never duplicate rows.
    expect(sql).not.toMatch(/JOIN meta_lead_submissions/i);
  });

  it("matches CTWA via non-blank source_url OR ctwa_clid (btrim parity)", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/p_source = 'ctwa'/i);
    expect(sql).toMatch(
      /btrim\(ct\.source_url\) <> ''/i,
    );
    expect(sql).toMatch(
      /btrim\(ct\.ctwa_clid\) <> ''/i,
    );
  });

  it("matches Other only when NEITHER signal exists", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/p_source = 'other'/i);
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM meta_lead_submissions s/i);
    expect(sql).toMatch(
      /NOT\s*\(\s*\(ct\.source_url IS NOT NULL AND btrim\(ct\.source_url\) <> ''\)/i,
    );
  });

  it("is fail-closed: unknown source values match nothing, all/null disables", () => {
    const { sql } = latestSearchMigration();
    expect(sql).toMatch(/p_source IS NULL OR p_source = 'all'/i);
    // No ELSE branch — any other non-null value falls through every OR.
    expect(sql).not.toMatch(/ELSE\s+TRUE/i);
  });

  it("does not touch attribution data or historical records", () => {
    const { sql } = latestSearchMigration();
    expect(sql).not.toMatch(/UPDATE\s+(contacts|meta_lead_submissions)/i);
    expect(sql).not.toMatch(/INSERT INTO\s+(contacts|meta_lead_submissions)/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });
});
