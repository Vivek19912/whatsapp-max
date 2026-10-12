import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceTableQuery,
  columnFiltersRequestKey,
  countActiveColumnFilters,
  emptyColumnFilters,
  hasActiveWorkspaceFilters,
  isCalendarDateString,
  isCallsTriedOp,
  isColumnDateMode,
  isColumnFilterFieldName,
  isColumnFiltersActive,
  isDateTimeLocalString,
  isFollowUpMode,
  isoToLocalDateTime,
  isoToLocalDay,
  resolveCallsTriedFilter,
  resolveColumnDateFilter,
  resolveFollowUpFilter,
  sanitizeFilterValues,
  serializeColumnFilters,
  shiftCalendarDay,
  type WorkspaceColumnFilters,
} from "./workspace-filters";

// ---------------------------------------------------------------------------
// Workspace column filters — pure resolvers, serialization, and the
// migration-118 SQL contract. Server (RPC) + client (panel) agree on
// half-open [from, to) bounds; day-scoped modes resolve in the
// viewer's local tz (the tz cells display in).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(here, "../../../supabase/migrations/118_workspace_column_filters.sql"),
  "utf8",
);

// Fixed viewer-local "now" (month is 0-indexed: Oct 15 2026, noon).
const NOW = new Date(2026, 9, 15, 12, 0, 0);

function activeColumns(): WorkspaceColumnFilters {
  return {
    callStatus: ["Connected", "Busy"],
    callsTried: { op: "between", min: 2, max: 5 },
    followUpStatus: ["Booked"],
    lastContact: { mode: "range", from: "2026-10-01", to: "2026-11-01" },
    nextFollowUp: { mode: "overdue", from: null, to: NOW.toISOString() },
  };
}

describe("field identity (stable names, never positions)", () => {
  it("recognizes the five filterable columns case-insensitively", () => {
    for (const name of [
      "Call Status",
      "No. of Calls Tried",
      "Follow-Up Status",
      "Last Contact Date",
      "Next Follow-up Date & Time",
      "  call status  ",
      "FOLLOW-UP STATUS",
    ]) {
      expect(isColumnFilterFieldName(name)).toBe(true);
    }
    expect(isColumnFilterFieldName("Stage")).toBe(false);
    expect(isColumnFilterFieldName("CallStatus")).toBe(false);
    expect(isColumnFilterFieldName(null)).toBe(false);
  });

  it("guards operator and mode enums", () => {
    expect(isCallsTriedOp("between")).toBe(true);
    expect(isCallsTriedOp("gte")).toBe(false);
    expect(isColumnDateMode("before")).toBe(true);
    expect(isColumnDateMode("today")).toBe(false);
    expect(isFollowUpMode("overdue")).toBe(true);
    expect(isFollowUpMode("someday")).toBe(false);
  });
});

describe("calls-tried resolver (exact + eq/gt/lt/between)", () => {
  it("accepts each condition with valid integers", () => {
    expect(resolveCallsTriedFilter("eq", { value: 3 })).toEqual({ op: "eq", value: 3 });
    expect(resolveCallsTriedFilter("gt", { value: "0" })).toEqual({ op: "gt", value: 0 });
    expect(resolveCallsTriedFilter("lt", { value: 10 })).toEqual({ op: "lt", value: 10 });
    expect(resolveCallsTriedFilter("between", { min: 2, max: 5 })).toEqual({
      op: "between",
      min: 2,
      max: 5,
    });
  });

  it("rejects empty, non-numeric, fractional, and out-of-range inputs", () => {
    for (const bad of ["", "  ", "abc", "3.5", "-1", "1000", null, undefined]) {
      expect(() => resolveCallsTriedFilter("eq", { value: bad })).toThrow();
    }
    expect(() => resolveCallsTriedFilter("between", { min: 2 })).toThrow();
    expect(() => resolveCallsTriedFilter("between", { min: 6, max: 5 })).toThrow();
  });
});

describe("calendar-day validation and arithmetic (tz-free)", () => {
  it("accepts real calendar days, rejects the rest", () => {
    expect(isCalendarDateString("2026-10-15")).toBe(true);
    expect(isCalendarDateString("2024-02-29")).toBe(true);
    for (const bad of [
      "2026-13-01",
      "2026-02-30",
      "2023-02-29",
      "15-10-2026",
      "2026-10-15T00:00",
      "",
      null,
      undefined,
    ]) {
      expect(isCalendarDateString(bad)).toBe(false);
    }
  });

  it("shifts days across month and leap boundaries", () => {
    expect(shiftCalendarDay("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftCalendarDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftCalendarDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftCalendarDay("2026-10-15", 0)).toBe("2026-10-15");
  });
});

describe("last-contact resolver (half-open calendar days)", () => {
  it("maps each mode to [from, to) with inclusive UI semantics", () => {
    expect(resolveColumnDateFilter("date", { from: "2026-01-31" })).toEqual({
      mode: "date",
      from: "2026-01-31",
      to: "2026-02-01",
    });
    expect(
      resolveColumnDateFilter("range", { from: "2026-10-01", to: "2026-10-15" }),
    ).toEqual({ mode: "range", from: "2026-10-01", to: "2026-10-16" });
    expect(resolveColumnDateFilter("before", { to: "2026-10-15" })).toEqual({
      mode: "before",
      from: null,
      to: "2026-10-15",
    });
    expect(resolveColumnDateFilter("after", { from: "2026-10-15" })).toEqual({
      mode: "after",
      from: "2026-10-15",
      to: null,
    });
  });

  it("rejects missing, malformed, and inverted inputs", () => {
    expect(() => resolveColumnDateFilter("date", {})).toThrow();
    expect(() => resolveColumnDateFilter("date", { from: "2026-02-30" })).toThrow();
    expect(() => resolveColumnDateFilter("range", { from: "2026-10-15" })).toThrow();
    expect(() =>
      resolveColumnDateFilter("range", { from: "2026-10-16", to: "2026-10-15" }),
    ).toThrow();
    expect(() => resolveColumnDateFilter("before", {})).toThrow();
    expect(() => resolveColumnDateFilter("after", { from: "" })).toThrow();
  });
});

describe("follow-up resolver (UTC instants, viewer-local days)", () => {
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  it("validates datetime-local inputs", () => {
    expect(isDateTimeLocalString("2026-10-15T09:30")).toBe(true);
    for (const bad of ["2026-10-15", "2026-13-01T09:30", "09:30", "", null]) {
      expect(isDateTimeLocalString(bad)).toBe(false);
    }
  });

  it("maps date/range/before/after to canonical ISO bounds", () => {
    const specific = resolveFollowUpFilter("date", { from: "2026-10-15" }, NOW);
    expect(specific.from).toBe(new Date(2026, 9, 15).toISOString());
    expect(specific.to).toBe(new Date(2026, 9, 16).toISOString());

    const range = resolveFollowUpFilter(
      "range",
      { from: "2026-10-14", to: "2026-10-15" },
      NOW,
    );
    expect(range.from).toBe(new Date(2026, 9, 14).toISOString());
    expect(range.to).toBe(new Date(2026, 9, 16).toISOString());

    const before = resolveFollowUpFilter("before", { to: "2026-10-15T09:30" }, NOW);
    expect(before).toEqual({
      mode: "before",
      from: null,
      to: new Date(2026, 9, 15, 9, 30).toISOString(),
    });
    const after = resolveFollowUpFilter("after", { from: "2026-10-15T09:30" }, NOW);
    expect(after.from).toBe(new Date(2026, 9, 15, 9, 30).toISOString());
    expect(after.to).toBeNull();
  });

  it("defines today/overdue/upcoming off the same local basis cells display in", () => {
    const today = resolveFollowUpFilter("today", {}, NOW);
    expect(today.from).toBe(new Date(2026, 9, 15).toISOString());
    expect(today.to).toBe(new Date(2026, 9, 16).toISOString());
    expect(day(new Date(today.from!))).toBe(day(NOW));

    expect(resolveFollowUpFilter("overdue", {}, NOW)).toEqual({
      mode: "overdue",
      from: null,
      to: NOW.toISOString(),
    });
    expect(resolveFollowUpFilter("upcoming", {}, NOW)).toEqual({
      mode: "upcoming",
      from: NOW.toISOString(),
      to: null,
    });
  });

  it("rejects bad inputs and inverted ranges", () => {
    expect(() => resolveFollowUpFilter("date", {}, NOW)).toThrow();
    expect(() => resolveFollowUpFilter("range", { from: "2026-10-16", to: "2026-10-15" }, NOW)).toThrow();
    expect(() => resolveFollowUpFilter("before", { to: "not-a-date" }, NOW)).toThrow();
    expect(() => resolveFollowUpFilter("after", {}, NOW)).toThrow();
  });

  it("round-trips normalized bounds back to local inputs", () => {
    const iso = new Date(2026, 9, 15, 9, 30).toISOString();
    expect(isoToLocalDay(iso)).toBe("2026-10-15");
    expect(isoToLocalDateTime(iso)).toBe("2026-10-15T09:30");
    expect(shiftCalendarDay(isoToLocalDay(iso), 1)).toBe("2026-10-16");
  });
});

describe("applied state, counts, serialization, request keys", () => {
  it("empty filters are inactive; any section activates", () => {
    const empty = emptyColumnFilters();
    expect(isColumnFiltersActive(empty)).toBe(false);
    expect(countActiveColumnFilters(empty)).toBe(0);
    expect(countActiveColumnFilters(activeColumns())).toBe(5);
    expect(isColumnFiltersActive({ ...empty, callStatus: ["Busy"] })).toBe(true);
    expect(isColumnFiltersActive({ ...empty, nextFollowUp: { mode: "today", from: "x", to: "y" } })).toBe(true);
    // Fresh factories never share references.
    expect(emptyColumnFilters()).not.toBe(empty);
    expect(emptyColumnFilters().callStatus).not.toBe(empty.callStatus);
  });

  it("sanitizes categorical values (trim, dedupe, drop empties, guard)", () => {
    expect(sanitizeFilterValues([" Busy ", "Busy", "", "Connected"])).toEqual([
      "Busy",
      "Connected",
    ]);
    expect(() => sanitizeFilterValues(["x".repeat(81)])).toThrow();
    expect(() => sanitizeFilterValues(Array.from({ length: 51 }, (_, i) => `v${i}`))).toThrow();
  });

  it("serializes multi-selects as repeated keys; scalars set once", () => {
    const qs = serializeColumnFilters(activeColumns());
    expect(qs.getAll("callStatus")).toEqual(["Connected", "Busy"]);
    expect(qs.getAll("followUpStatus")).toEqual(["Booked"]);
    expect(qs.get("callsTriedOp")).toBe("between");
    expect(qs.get("callsTriedMin")).toBe("2");
    expect(qs.get("callsTriedMax")).toBe("5");
    expect(qs.get("lastContactFrom")).toBe("2026-10-01");
    expect(qs.get("lastContactTo")).toBe("2026-11-01");
    expect(qs.get("nextFollowUpTo")).toBe(NOW.toISOString());
    expect(qs.get("callsTriedValue")).toBeNull();
    // Inactive sections contribute nothing.
    expect([...serializeColumnFilters(emptyColumnFilters()).keys()]).toEqual([]);
  });

  it("request keys are deterministic and change with any selection", () => {
    const a = activeColumns();
    const b = activeColumns();
    expect(columnFiltersRequestKey(a)).toBe(columnFiltersRequestKey(b));
    expect(columnFiltersRequestKey(emptyColumnFilters())).toBe("");
    expect(columnFiltersRequestKey({ ...a, callStatus: ["Busy"] })).not.toBe(
      columnFiltersRequestKey(a),
    );
  });

  it("table query carries the new params; inactive filters stay absent", () => {
    const qs = buildWorkspaceTableQuery({
      view: "completed",
      page: 0,
      pageSize: 25,
      dateRange: null,
      assignee: { type: "all" },
      columns: activeColumns(),
    });
    expect(qs).toContain("callStatus=Connected");
    expect(qs).toContain("callsTriedOp=between");
    expect(qs).toContain("lastContactFrom=2026-10-01");
    expect(qs).toContain(`nextFollowUpTo=${encodeURIComponent(NOW.toISOString())}`);
    const bare = buildWorkspaceTableQuery({
      view: "all",
      page: 0,
      pageSize: 25,
      dateRange: null,
      assignee: { type: "all" },
      columns: emptyColumnFilters(),
    });
    expect(bare).not.toContain("callStatus");
    expect(bare).not.toContain("callsTried");
    expect(bare).not.toContain("lastContact");
    expect(bare).not.toContain("nextFollowUp");
  });

  it("hasActiveWorkspaceFilters counts the new sections (backward compatible)", () => {
    expect(
      hasActiveWorkspaceFilters({ dateRange: null, assignee: { type: "all" } }),
    ).toBe(false);
    expect(
      hasActiveWorkspaceFilters({
        dateRange: null,
        assignee: { type: "all" },
        columns: { ...emptyColumnFilters(), followUpStatus: ["Lost"] },
      }),
    ).toBe(true);
  });
});

describe("migration 118 — five server-side predicates (same signature +)", () => {
  it("adds optional backward-compatible params only", () => {
    for (const param of [
      "p_call_status TEXT[] DEFAULT NULL",
      "p_calls_tried_op TEXT DEFAULT NULL",
      "p_calls_tried_value INT DEFAULT NULL",
      "p_calls_tried_min INT DEFAULT NULL",
      "p_calls_tried_max INT DEFAULT NULL",
      "p_followup_status TEXT[] DEFAULT NULL",
      "p_last_contact_from DATE DEFAULT NULL",
      "p_last_contact_to DATE DEFAULT NULL",
      "p_next_followup_from TEXT DEFAULT NULL",
      "p_next_followup_to TEXT DEFAULT NULL",
    ]) {
      expect(MIGRATION).toContain(param);
    }
    // Existing params untouched.
    expect(MIGRATION).toContain("p_assignee TEXT DEFAULT NULL");
  });

  it("resolves all five fields by case-insensitive name", () => {
    for (const name of [
      "lower(btrim(wf.name)) = 'call status'",
      "lower(btrim(wf.name)) = 'no. of calls tried'",
      "lower(btrim(wf.name)) = 'follow-up status'",
      "lower(btrim(wf.name)) = 'last contact date'",
      "lower(btrim(wf.name)) = 'next follow-up date & time'",
    ]) {
      expect(MIGRATION).toContain(name);
    }
  });

  it("matches selects by stored-value equality (OR within section)", () => {
    expect(MIGRATION).toMatch(/v\.value_text = ANY\(v_call_status\)/);
    expect(MIGRATION).toMatch(/v\.value_text = ANY\(v_followup_status\)/);
  });

  it("guards numeric casts and validates the operator", () => {
    expect(MIGRATION).toContain("v.value_text ~ '^[0-9]+$'");
    expect(MIGRATION).toContain("v.value_text::INT = p_calls_tried_value");
    expect(MIGRATION).toContain("v.value_text::INT > p_calls_tried_value");
    expect(MIGRATION).toContain("v.value_text::INT < p_calls_tried_value");
    expect(MIGRATION).toContain("v.value_text::INT >= p_calls_tried_min");
    expect(MIGRATION).toContain("v.value_text::INT <= p_calls_tried_max");
    expect(MIGRATION).toMatch(/Invalid calls-tried operator/);
  });

  it("compares canonical date/datetime shapes half-open, garbage-safe", () => {
    expect(MIGRATION).toContain("v.value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(MIGRATION).toContain("v.value_text >= p_last_contact_from::TEXT");
    expect(MIGRATION).toContain("v.value_text < p_last_contact_to::TEXT");
    expect(MIGRATION).toContain(
      "v.value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'",
    );
    expect(MIGRATION).toContain("v.value_text >= p_next_followup_from");
    expect(MIGRATION).toContain("v.value_text < p_next_followup_to");
  });

  it("keeps counts, pin ordering, and hidden exclusion intact (interplay)", () => {
    // Total still reads the filtered set — now column-aware.
    expect(MIGRATION).toMatch(/'total', \(SELECT COUNT\(\*\)::INT FROM filtered\)/);
    // Pin-first ordering in both ORDER BY blocks.
    const blocks = MIGRATION.split(/(?=ORDER BY)/g).filter((c) =>
      c.startsWith("ORDER BY"),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toMatch(/is_pinned DESC|row_pinned DESC/);
    }
    // Hidden exclusion untouched.
    expect(MIGRATION).toContain("AND (rp.is_hidden IS NULL OR rp.is_hidden = FALSE)");
    // Prior signature/params byte-compatible.
    expect(MIGRATION).toContain("p_started_from TIMESTAMPTZ DEFAULT NULL");
  });
});
