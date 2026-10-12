import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for the Workspace server-side ordering
// (migration 087). The ORDER BY lives in SQL, so these tests pin
// the migration text: page selection and row aggregation must use
// the same view-dependent ordering, or pagination silently
// re-sorts (the 084 bug: DESC page pick + ASC aggregate).

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(here, "../../../supabase/migrations/087_workspace_table_ordering.sql"),
  "utf8",
);
const PAGE = readFileSync(
  join(here, "../../app/(dashboard)/workspace/page.tsx"),
  "utf8",
);

function orderByBlocks(sql: string): string[] {
  return sql
    .split(/(?=ORDER BY)/g)
    .filter((chunk) => chunk.startsWith("ORDER BY"));
}

describe("workspace ordering migration", () => {
  it("1+2. completed view orders by the real completion timestamp DESC", () => {
    expect(MIGRATION).toMatch(
      /WHEN p_view = 'completed' THEN .*completed_sort/i,
    );
    // Custom point reach time, else the END-completion timestamp.
    expect(MIGRATION).toMatch(
      /WHEN v_flow\.completion_node_id IS NOT NULL THEN b\.reached_at\s+ELSE b\.ended_at/i,
    );
  });

  it("5. incomplete view orders by newest activity with submission fallback", () => {
    expect(MIGRATION).toMatch(
      /WHEN p_view = 'incomplete' THEN .*activity_sort/i,
    );
    expect(MIGRATION).toMatch(
      /COALESCE\(b\.last_advanced_at,\s*b\.started_at\) AS activity_sort/i,
    );
  });

  it("6+7. page selection and aggregation share one ordering (pagination-safe)", () => {
    const blocks = orderByBlocks(MIGRATION);
    // Page-selection ORDER BY + jsonb_agg ORDER BY.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toMatch(/completed_sort/i);
      expect(block).toMatch(/activity_sort/i);
      // Deterministic run-id tiebreak (row_id is its alias).
      expect(block).toMatch(/row_id DESC|run_id DESC/i);
      expect(block).toMatch(/NULLS LAST/i);
    }
  });

  it("10. equal timestamps fall back to deterministic run_id DESC", () => {
    const runIdDesc = (MIGRATION.match(/run_id DESC/gi) ?? []).length;
    expect(runIdDesc).toBeGreaterThanOrEqual(2);
  });

  it("does not order completed rows by started_at alone", () => {
    expect(MIGRATION).not.toMatch(/ORDER BY f\.started_at DESC, f\.run_id DESC/);
    expect(MIGRATION).not.toMatch(/ORDER BY row_started, row_id\)/);
  });

  it("keeps started_at ordering for the legacy all view", () => {
    expect(MIGRATION).toMatch(
      /WHEN p_view NOT IN \('completed', 'incomplete'\) THEN .*started_at/i,
    );
  });

  it("classification logic is untouched", () => {
    expect(MIGRATION).toMatch(
      /WHEN v_flow\.completion_node_id IS NOT NULL THEN \(b\.reached_at IS NOT NULL\)/,
    );
  });
});

describe("workspace page rendering", () => {
  it("11. introduces no client-side sort-after-fetch", () => {
    expect(PAGE).not.toMatch(/\.sort\s*\(/);
  });

  it("renders rows in server order with UI-only numbering", () => {
    // visibleRows = server-ordered payload rows minus hidden rows,
    // with pinned rows partitioned stably to the top (no .sort() —
    // see the no-sort test above): relative order within each group
    // is exactly the server's, and numbering stays UI-only.
    expect(PAGE).toMatch(/visibleRows\.map\(\(row, rowIndex\)/);
    expect(PAGE).toMatch(/workspaceRowNumber/);
  });
});
