import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  excludeHiddenRows,
  hiddenRowLabel,
  orderPinnedFirst,
  visibleWorkspaceRows,
} from "./workspace-row-prefs";

// ---------------------------------------------------------------------------
// Workspace row pin/hide — pure ordering/filtering (1/2/3/4/7/11).
//
// Pin/hide state is per user per flow (migration 117): the server
// persists it and the table RPC excludes hidden rows + sorts pinned
// rows first. These helpers are the client-side mirror (optimistic
// updates + graceful fallback), so they must partition stably and
// never mutate, drop, or reorder anything else.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(here, "../../../supabase/migrations/117_workspace_row_prefs.sql"),
  "utf8",
);

interface Row {
  runId: string;
  name: string | null;
}

function rows(): Row[] {
  return [
    { runId: "run-a", name: "Asha" },
    { runId: "run-b", name: "Rahul" },
    { runId: "run-c", name: "Nikita" },
  ];
}

describe("orderPinnedFirst — pinned rows float stably to the top", () => {
  it("1. pinning one row moves it first, preserving the rest", () => {
    expect(orderPinnedFirst(rows(), new Set(["run-c"])).map((r) => r.runId)).toEqual([
      "run-c",
      "run-a",
      "run-b",
    ]);
  });

  it("2. multiple pinned rows keep their relative order", () => {
    expect(
      orderPinnedFirst(rows(), new Set(["run-c", "run-a"])).map((r) => r.runId),
    ).toEqual(["run-a", "run-c", "run-b"]);
  });

  it("3. ordering is stable across repeated applications (refresh-safe)", () => {
    const pinned = new Set(["run-b"]);
    const once = orderPinnedFirst(rows(), pinned);
    // A refresh returns rows in server order; re-partitioning the
    // already-partitioned list must be a fixed point.
    expect(orderPinnedFirst(once, pinned).map((r) => r.runId)).toEqual([
      "run-b",
      "run-a",
      "run-c",
    ]);
  });

  it("unknown pinned ids never invent, drop, or reorder rows", () => {
    const input = rows();
    const out = orderPinnedFirst(input, new Set(["run-zzz"]));
    expect(out.map((r) => r.runId)).toEqual(["run-a", "run-b", "run-c"]);
    expect(out).not.toBe(input);
    expect(input.map((r) => r.runId)).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("empty pins return a copy in the same order", () => {
    const input = rows();
    const out = orderPinnedFirst(input, new Set());
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});

describe("excludeHiddenRows — hiding removes only that row (4/5)", () => {
  it("hiding one row removes it from normal results, nothing else", () => {
    const out = excludeHiddenRows(rows(), new Set(["run-b"]));
    expect(out.map((r) => r.runId)).toEqual(["run-a", "run-c"]);
  });

  it("hidden state composes across applications (persists after refresh)", () => {
    const hidden = new Set(["run-b"]);
    expect(excludeHiddenRows(excludeHiddenRows(rows(), hidden), hidden)).toEqual(
      excludeHiddenRows(rows(), hidden),
    );
  });

  it("restoring (removing the id) brings the row back with data intact", () => {
    const hidden = new Set(["run-b"]);
    expect(excludeHiddenRows(rows(), hidden)).toHaveLength(2);
    expect(excludeHiddenRows(rows(), new Set<string>())).toEqual(rows());
  });
});

describe("visibleWorkspaceRows — filter then pin-partition, like the server", () => {
  it("hidden rows never surface, pinned rows lead (7)", () => {
    const out = visibleWorkspaceRows(
      rows(),
      new Set(["run-c", "run-b"]),
      new Set(["run-b"]),
    );
    expect(out.map((r) => r.runId)).toEqual(["run-c", "run-a"]);
  });

  it("existing order is untouched when nothing is pinned or hidden (11)", () => {
    expect(
      visibleWorkspaceRows(rows(), new Set(), new Set()).map((r) => r.runId),
    ).toEqual(["run-a", "run-b", "run-c"]);
  });
});

describe("hiddenRowLabel — identify hidden rows without leaking ids", () => {
  it("shows name + phone, either alone, else a plain fallback", () => {
    expect(
      hiddenRowLabel({ flow_run_id: "x", name: "Asha", phone: "+91111" }),
    ).toBe("Asha · +91111");
    expect(hiddenRowLabel({ flow_run_id: "x", name: "Asha", phone: null })).toBe(
      "Asha",
    );
    expect(hiddenRowLabel({ flow_run_id: "x", name: null, phone: "+91111" })).toBe(
      "+91111",
    );
    expect(hiddenRowLabel({ flow_run_id: "x", name: null, phone: null })).toBe(
      "Lead",
    );
    expect(hiddenRowLabel({ flow_run_id: "run-a", name: "  ", phone: "" })).toBe(
      "Lead",
    );
  });
});

describe("migration 117 — persistence, RLS, RPC, and table-RPC wiring", () => {
  it("stores prefs per (user, flow, run) with a no-duplicates guarantee", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS workspace_row_prefs/);
    expect(MIGRATION).toMatch(/flow_run_id UUID NOT NULL REFERENCES flow_runs\(id\)/);
    expect(MIGRATION).toMatch(/user_id UUID NOT NULL REFERENCES auth\.users\(id\)/);
    expect(MIGRATION).toMatch(
      /CONSTRAINT workspace_row_prefs_user_flow_run_key\s+UNIQUE \(user_id, flow_id, flow_run_id\)/,
    );
    expect(MIGRATION).toMatch(/is_pinned BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(MIGRATION).toMatch(/is_hidden BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it("isolates prefs per user: clients read only their own rows, writes are RPC-only (8/9)", () => {
    expect(MIGRATION).toMatch(
      /FOR SELECT\s+USING \(user_id = auth\.uid\(\) AND is_account_member\(account_id\)\)/,
    );
    expect(MIGRATION).not.toMatch(/workspace_row_prefs_insert/);
    expect(MIGRATION).not.toMatch(/workspace_row_prefs_update/);
    expect(MIGRATION).not.toMatch(/workspace_row_prefs_delete/);
    expect(MIGRATION).toMatch(/SECURITY DEFINER/);
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_workspace_row_pref\(UUID, UUID, BOOLEAN, BOOLEAN\) TO authenticated/,
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.restore_workspace_hidden_rows\(UUID\) TO authenticated/,
    );
  });

  it("validates run/flow membership server-side without an existence oracle", () => {
    expect(MIGRATION).toMatch(/r\.flow_id = p_flow_id/);
    expect(MIGRATION).toMatch(/Row not found in this flow/);
    expect(MIGRATION).toMatch(/ON CONFLICT \(user_id, flow_id, flow_run_id\)/);
    // Restoring clears hides but keeps pins; emptied rows are deleted.
    expect(MIGRATION).toMatch(/SET is_hidden = FALSE/);
    expect(MIGRATION).toMatch(/AND NOT is_pinned/);
  });

  it("the table RPC keeps its signature and excludes hidden rows from total + pages", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_flow_table_rows\(\s+p_flow_id UUID,\s+p_view TEXT/,
    );
    expect(MIGRATION).toMatch(/p_assignee TEXT DEFAULT NULL/);
    expect(MIGRATION).toMatch(
      /AND \(rp\.is_hidden IS NULL OR rp\.is_hidden = FALSE\)/,
    );
    // The count still reads the filtered set — now hide-aware.
    expect(MIGRATION).toMatch(/'total', \(SELECT COUNT\(\*\)::INT FROM filtered\)/);
  });

  it("pinned rows sort first with existing ordering inside each group", () => {
    expect(MIGRATION).toMatch(/COALESCE\(rp\.is_pinned, FALSE\) AS is_pinned/);
    expect(MIGRATION).toMatch(/rp\.user_id = auth\.uid\(\)/);
    const blocks = MIGRATION.split(/(?=ORDER BY)/g).filter((c) =>
      c.startsWith("ORDER BY"),
    );
    // Page-selection ORDER BY + jsonb_agg ORDER BY, both pin-first.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toMatch(/is_pinned DESC|row_pinned DESC/);
      expect(block).toMatch(/completed_sort|row_completed/);
      expect(block).toMatch(/activity_sort|row_activity/);
      expect(block).toMatch(/row_id DESC|run_id DESC/);
    }
  });
});
