import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural contract for 165_workspace_values_realtime.sql. There
// is no live-DB harness in this repo, so these tests pin the
// migration text: idempotent publication add, Workspace table only,
// no policy/grant changes (realtime delivery rides on the
// existing workspace_values_select policy).
const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "165_workspace_values_realtime.sql"),
  "utf8"
);

describe("workspace_values realtime publication (165)", () => {
  it("adds the table to supabase_realtime idempotently", () => {
    expect(sql).toMatch(/pg_publication_tables/);
    expect(sql).toMatch(/pubname = 'supabase_realtime' AND tablename = 'workspace_values'/);
    expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE workspace_values/i);
    // Exactly one ADD — never duplicated.
    expect(sql.match(/ADD TABLE workspace_values/gi)).toHaveLength(1);
  });

  it("changes no authorization posture", () => {
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
    expect(sql).not.toMatch(/GRANT /i);
    expect(sql).not.toMatch(/REVOKE /i);
    expect(sql).not.toMatch(/RLS/i);
  });
});
