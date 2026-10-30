import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALL_ASSIGNEES,
  buildAssigneeFilterOptions,
  buildWorkspaceTableQuery,
  hasActiveWorkspaceFilters,
  intersectFollowUpRanges,
  isWorkspaceDatePreset,
  parseAssigneeParam,
  resolveWorkspaceDateRange,
  serializeAssigneeSelection,
  validateWorkspaceDateRange,
  WORKSPACE_ASSIGNEE_ALL,
  WORKSPACE_ASSIGNEE_UNASSIGNED,
} from "./workspace-filters";

// ---------------------------------------------------------------------------
// Workspace filters — pure model tests (15 required behaviors).
//
// Date presets resolve against Submission Time in the viewer's LOCAL
// timezone (the same tz the table uses to display it). All date
// assertions below use local calendar components, so they hold in
// any timezone and across DST boundaries.
// ---------------------------------------------------------------------------

/** Fixed local noon — immune to midnight/DST edge flakiness. */
const NOW = new Date(2026, 8, 24, 12, 0, 0);

const M_A = { user_id: "11111111-1111-4111-8111-111111111111", full_name: "Asha Rao" };
const M_B = { user_id: "22222222-2222-4222-8222-222222222222", full_name: "Dev Patel" };

function parts(iso: string): [number, number, number] {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

describe("1. Today filter", () => {
  it("covers local today 00:00 → tomorrow 00:00", () => {
    const r = resolveWorkspaceDateRange("today", {}, NOW);
    expect(parts(r!.from)).toEqual([2026, 8, 24]);
    expect(parts(r!.to)).toEqual([2026, 8, 25]);
    expect(new Date(r!.from).getHours()).toBe(0);
  });
});

describe("2. Yesterday filter", () => {
  it("covers local yesterday 00:00 → today 00:00", () => {
    const r = resolveWorkspaceDateRange("yesterday", {}, NOW);
    expect(parts(r!.from)).toEqual([2026, 8, 23]);
    expect(parts(r!.to)).toEqual([2026, 8, 24]);
  });
});

describe("3. Last 7 days filter", () => {
  it("covers 7 local calendar days including today", () => {
    const r = resolveWorkspaceDateRange("last7", {}, NOW);
    expect(parts(r!.from)).toEqual([2026, 8, 18]);
    expect(parts(r!.to)).toEqual([2026, 8, 25]);
  });
});

describe("4. Last 30 days filter", () => {
  it("covers 30 local calendar days including today", () => {
    const r = resolveWorkspaceDateRange("last30", {}, NOW);
    expect(parts(r!.from)).toEqual([2026, 7, 26]);
    expect(parts(r!.to)).toEqual([2026, 8, 25]);
  });
});

describe("5. Custom date range", () => {
  it("is inclusive on both ends (to-date rolls to next midnight)", () => {
    const r = resolveWorkspaceDateRange(
      "custom",
      { from: "2026-09-01", to: "2026-09-10" },
      NOW,
    );
    expect(parts(r!.from)).toEqual([2026, 8, 1]);
    expect(parts(r!.to)).toEqual([2026, 8, 11]);
  });

  it("accepts a single-day range", () => {
    const r = resolveWorkspaceDateRange(
      "custom",
      { from: "2026-09-10", to: "2026-09-10" },
      NOW,
    );
    expect(parts(r!.from)).toEqual([2026, 8, 10]);
    expect(parts(r!.to)).toEqual([2026, 8, 11]);
  });

  it("rejects missing, malformed, non-calendar, and inverted ranges", () => {
    expect(() => resolveWorkspaceDateRange("custom", {}, NOW)).toThrow(/both/i);
    expect(() =>
      resolveWorkspaceDateRange("custom", { from: "09/01/2026", to: "2026-09-10" }, NOW),
    ).toThrow(/both/i);
    expect(() =>
      resolveWorkspaceDateRange("custom", { from: "2026-02-30", to: "2026-03-01" }, NOW),
    ).toThrow(/both/i);
    expect(() =>
      resolveWorkspaceDateRange("custom", { from: "2026-09-11", to: "2026-09-10" }, NOW),
    ).toThrow(/before/i);
  });

  it("validates ISO range shape server-side", () => {
    const good = validateWorkspaceDateRange({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-11T00:00:00.000Z",
    });
    expect(good.from).toContain("2026-09-01");
    expect(() =>
      validateWorkspaceDateRange({ from: "not-a-date", to: "2026-09-11T00:00:00.000Z" }),
    ).toThrow(/invalid date/i);
    expect(() =>
      validateWorkspaceDateRange({
        from: "2026-09-11T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow(/before/i);
  });
});

describe("6. Assigned To shows real account team members", () => {
  it("builds All + Unassigned + one row per current member", () => {
    const opts = buildAssigneeFilterOptions([M_A, M_B]);
    expect(opts.map((o) => o.kind)).toEqual(["all", "unassigned", "member", "member"]);
    expect(opts[0]).toMatchObject({ value: "all", label: "All" });
    expect(opts[1]).toMatchObject({ value: "unassigned", label: "Unassigned" });
    expect(opts.slice(2).map((o) => o.value)).toEqual([M_A.user_id, M_B.user_id]);
    expect(opts.slice(2).map((o) => o.label)).toEqual(["Asha Rao", "Dev Patel"]);
  });

  it("has no Clear item and no preserved entries (filter, not editor)", () => {
    const opts = buildAssigneeFilterOptions([M_A]);
    expect(opts.some((o) => o.label === "Clear")).toBe(false);
    expect(opts.some((o) => o.kind !== "all" && o.kind !== "unassigned" && o.kind !== "member")).toBe(false);
  });

  it("recognizes only the five known presets", () => {
    expect(isWorkspaceDatePreset("today")).toBe(true);
    expect(isWorkspaceDatePreset("custom")).toBe(true);
    expect(isWorkspaceDatePreset("all")).toBe(false);
    expect(isWorkspaceDatePreset("TARUN")).toBe(false);
  });
});

describe("7. Unassigned works", () => {
  it("round-trips the unassigned keyword", () => {
    expect(parseAssigneeParam("unassigned")).toEqual({ type: "unassigned" });
    expect(parseAssigneeParam("Unassigned")).toEqual({ type: "unassigned" });
    expect(serializeAssigneeSelection({ type: "unassigned" })).toBe("unassigned");
    expect(WORKSPACE_ASSIGNEE_UNASSIGNED).toBe("unassigned");
  });

  it("treats absent/blank/all as no filter", () => {
    expect(parseAssigneeParam(null)).toEqual(ALL_ASSIGNEES);
    expect(parseAssigneeParam(undefined)).toEqual(ALL_ASSIGNEES);
    expect(parseAssigneeParam("")).toEqual(ALL_ASSIGNEES);
    expect(parseAssigneeParam("all")).toEqual(ALL_ASSIGNEES);
    expect(serializeAssigneeSelection(ALL_ASSIGNEES)).toBe("all");
    expect(WORKSPACE_ASSIGNEE_ALL).toBe("all");
  });
});

describe("8. Team member filtering uses stable IDs", () => {
  it("serializes members to user_id and parses them back", () => {
    const sel = { type: "member", userId: M_A.user_id } as const;
    expect(serializeAssigneeSelection(sel)).toBe(M_A.user_id);
    expect(parseAssigneeParam(M_A.user_id)).toEqual({ type: "member", userId: M_A.user_id });
  });

  it("the table query carries the ID, never the display name", () => {
    const qs = buildWorkspaceTableQuery({
      view: "completed",
      page: 0,
      pageSize: 25,
      dateRange: null,
      assignee: { type: "member", userId: M_A.user_id },
    });
    expect(qs).toContain(`assignee=${M_A.user_id}`);
    expect(qs).not.toContain("Asha");
  });
});

describe("9. New team members automatically become filter options", () => {
  it("options derive from the input roster — no code change needed", () => {
    const before = buildAssigneeFilterOptions([M_A]).map((o) => o.value);
    const newcomer = {
      user_id: "33333333-3333-4333-8333-333333333333",
      full_name: "New Teammate",
    };
    const after = buildAssigneeFilterOptions([M_A, newcomer]).map((o) => o.value);
    expect(before).not.toContain(newcomer.user_id);
    expect(after).toContain(newcomer.user_id);
  });

  it("a removed member stops appearing (input-driven, nothing preserved)", () => {
    const opts = buildAssigneeFilterOptions([M_A]).map((o) => o.value);
    expect(opts).not.toContain(M_B.user_id);
  });
});

describe("10. Date + Assigned To combine", () => {
  it("one query carries both filters together", () => {
    const range = resolveWorkspaceDateRange("last7", {}, NOW)!;
    const qs = new URLSearchParams(
      buildWorkspaceTableQuery({
        view: "completed",
        search: "rahul",
        page: 2,
        pageSize: 50,
        dateRange: range,
        assignee: { type: "member", userId: M_A.user_id },
      }),
    );
    expect(qs.get("dateFrom")).toBe(range.from);
    expect(qs.get("dateTo")).toBe(range.to);
    expect(qs.get("assignee")).toBe(M_A.user_id);
    expect(qs.get("view")).toBe("completed");
    expect(qs.get("search")).toBe("rahul");
  });

  it("hasActiveWorkspaceFilters reflects either or both", () => {
    expect(hasActiveWorkspaceFilters({ dateRange: null, assignee: ALL_ASSIGNEES })).toBe(false);
    expect(
      hasActiveWorkspaceFilters({
        dateRange: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" },
        assignee: ALL_ASSIGNEES,
      }),
    ).toBe(true);
    expect(
      hasActiveWorkspaceFilters({ dateRange: null, assignee: { type: "unassigned" } }),
    ).toBe(true);
  });
});

describe("11. Filters work with pagination", () => {
  it("page/pageSize ride alongside filters (server paginates the filtered set)", () => {
    const range = resolveWorkspaceDateRange("today", {}, NOW)!;
    for (const page of [0, 1, 4]) {
      const qs = new URLSearchParams(
        buildWorkspaceTableQuery({
          view: "incomplete",
          page,
          pageSize: 25,
          dateRange: range,
          assignee: { type: "unassigned" },
        }),
      );
      expect(qs.get("page")).toBe(String(page));
      expect(qs.get("pageSize")).toBe("25");
      expect(qs.get("dateFrom")).toBe(range.from);
      expect(qs.get("assignee")).toBe("unassigned");
    }
  });

  it("inactive filters add no params (unfiltered reads are byte-identical)", () => {
    const qs = buildWorkspaceTableQuery({
      view: "completed",
      page: 0,
      pageSize: 25,
      dateRange: null,
      assignee: ALL_ASSIGNEES,
    });
    expect(qs).not.toContain("dateFrom");
    expect(qs).not.toContain("dateTo");
    expect(qs).not.toContain("assignee");
  });
});

describe("14. Google Sheets is unaffected", () => {
  const root = process.cwd();
  it("sheets read paths take no filter params", () => {
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${root}/${rel}`, "utf8");
      expect(src).not.toContain("dateFrom");
      expect(src).not.toContain("p_assignee");
    }
  });

  it("the filter model imports no sheets code", () => {
    const src = readFileSync(`${root}/src/lib/flows/workspace-filters.ts`, "utf8");
    expect(src.toLowerCase()).not.toContain("sheet");
  });
});

describe("15. No team member names/UUIDs are hardcoded", () => {
  const root = process.cwd();
  const files = [
    "src/lib/flows/workspace-filters.ts",
    "src/components/workspace/workspace-filters.tsx",
    "src/app/(dashboard)/workspace/page.tsx",
    "src/app/api/flows/[id]/table/route.ts",
    "supabase/migrations/094_workspace_table_filters.sql",
  ];
  const forbidden = ["travelenfield", "tarun sagar", "neha singh", "janak katyal"];

  it.each(files)("does not hardcode member names: %s", (rel) => {
    const src = readFileSync(`${root}/${rel}`, "utf8").toLowerCase();
    for (const name of forbidden) {
      expect(src).not.toContain(name);
    }
  });

  it("workspace-filters.ts contains no hardcoded UUIDs", () => {
    const src = readFileSync(`${root}/src/lib/flows/workspace-filters.ts`, "utf8");
    expect(src).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("filter options come from the Team Members endpoint data", () => {
    const page = readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
    expect(page).toContain("/api/account/members");
    const panel = readFileSync(
      `${root}/src/components/workspace/workspace-filters.tsx`,
      "utf8",
    );
    // Panel renders whatever roster it is given — options are mapped,
    // never listed.
    expect(panel).toContain("members.map");
  });
});

describe("16. KPI bucket × column-filter intersection (server-side AND)", () => {
  // Viewer-local midnights serialized as UTC ISO instants — plain
  // strings, so the max/min logic is pinned without timezone math.
  const T0 = "2026-09-24T00:00:00.000Z";
  const T1 = "2026-09-25T00:00:00.000Z";
  const T2 = "2026-09-26T00:00:00.000Z";
  const TODAY = { from: T0, to: T1 };

  it("passes the KPI window through when the user has no next-follow-up filter", () => {
    expect(intersectFollowUpRanges(null, TODAY)).toEqual(TODAY);
  });

  it("narrows to the overlap (max from, min to) when both bound the range", () => {
    expect(
      intersectFollowUpRanges({ from: "2026-09-24T12:00:00.000Z", to: null }, TODAY),
    ).toEqual({ from: "2026-09-24T12:00:00.000Z", to: T1 });
    expect(
      intersectFollowUpRanges({ from: null, to: "2026-09-24T12:00:00.000Z" }, TODAY),
    ).toEqual({ from: T0, to: "2026-09-24T12:00:00.000Z" });
  });

  it("clamps a disjoint intersection to from === to (matches nothing, API-accepted)", () => {
    // User filtered "after tomorrow" while the Overdue KPI is active.
    const empty = intersectFollowUpRanges({ from: T1, to: null }, { from: null, to: T0 });
    if (empty.from === null || empty.to === null) throw new Error("expected a clamped range");
    expect(empty.from).toBe(empty.to);
    // Never emits the API-rejected from > to shape.
    expect(empty.from <= empty.to).toBe(true);
  });

  it("keeps unbounded sides unbounded", () => {
    expect(intersectFollowUpRanges({ from: null, to: null }, { from: T1, to: null })).toEqual({
      from: T1,
      to: null,
    });
    expect(intersectFollowUpRanges(null, { from: null, to: null })).toEqual({
      from: null,
      to: null,
    });
  });

  it("pins the tomorrow/upcoming boundary used by the KPI ranges", () => {
    expect(
      intersectFollowUpRanges({ from: T1, to: null }, { from: T1, to: T2 }),
    ).toEqual({ from: T1, to: T2 });
  });
});
