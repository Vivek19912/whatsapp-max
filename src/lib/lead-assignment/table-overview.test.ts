// Table Assignments overview model — status/method/KPI/filter rules.

import { describe, expect, it } from "vitest";

import {
  allocationText,
  avatarToneFor,
  computeKpis,
  deriveMethodKey,
  deriveMethodLabel,
  deriveTableStatus,
  equalShareLabel,
  filterOverviewTables,
  hasConfiguredRecipients,
  initialsFor,
  type OverviewTableInput,
} from "./table-overview";

function table(
  overrides: Partial<OverviewTableInput> & { flowId: string },
): OverviewTableInput {
  return {
    tableName: `Table ${overrides.flowId}`,
    config: null,
    assignees: [],
    ...overrides,
  };
}

function assignee(name: string, weight = 0, extra: Record<string, unknown> = {}) {
  return {
    id: `a-${name}`,
    user_id: `u-${name.toLowerCase()}`,
    display_name: name,
    weight,
    is_active: true,
    ...extra,
  };
}

describe("deriveTableStatus", () => {
  it("marks enabled configs with recipients Active", () => {
    expect(
      deriveTableStatus({
        config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [assignee("Pooja", 100)],
      }),
    ).toBe("active");
  });

  it("marks disabled configs Paused even with recipients (explicit pause wins)", () => {
    expect(
      deriveTableStatus({
        config: { enabled: false, mode: "round_robin", whatsapp_template_name: null, updated_at: "x" },
        assignees: [assignee("Pooja")],
      }),
    ).toBe("paused");
  });

  it("marks missing configs Not Configured", () => {
    expect(deriveTableStatus({ config: null, assignees: [] })).toBe("not_configured");
  });

  it("marks recipient-less configs Not Configured (nothing can be assigned)", () => {
    expect(
      deriveTableStatus({
        config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [],
      }),
    ).toBe("not_configured");
  });
});

describe("deriveMethodLabel / deriveMethodKey", () => {
  const cfg = (mode: "percentage" | "round_robin", enabled: boolean) => ({
    config: { enabled, mode, whatsapp_template_name: null, updated_at: "x" },
    assignees: [assignee("Pooja", 100)],
  });
  it("shows the stored mode for enabled tables", () => {
    expect(deriveMethodLabel(cfg("percentage", true))).toBe("Percentage");
    expect(deriveMethodLabel(cfg("round_robin", true))).toBe("Round Robin");
  });
  it("shows Manual for paused tables (dialog Automatic/Manual convention), never infers from shares", () => {
    expect(deriveMethodLabel(cfg("percentage", false))).toBe("Manual");
    expect(deriveMethodKey(cfg("percentage", false))).toBe("manual");
  });
  it("shows a dash with no usable configuration", () => {
    expect(deriveMethodLabel({ config: null, assignees: [] })).toBe("—");
    expect(deriveMethodKey({ config: null, assignees: [] })).toBeNull();
  });
});

describe("allocationText", () => {
  it("lists actual saved shares for active percentage tables", () => {
    expect(
      allocationText({
        config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [assignee("Pooja", 40), assignee("Rishita", 30), assignee("Deepika", 30)],
      }),
    ).toBe("Pooja: 40% · Rishita: 30% · Deepika: 30%");
  });
  it("shows the equal share for active round robin tables", () => {
    const text = allocationText({
      config: { enabled: true, mode: "round_robin", whatsapp_template_name: null, updated_at: "x" },
      assignees: [assignee("A"), assignee("B")],
    });
    expect(text).toBe("Equal (50% each)");
  });
  it("shows No auto assignment for paused tables and a dash when unconfigured", () => {
    expect(
      allocationText({
        config: { enabled: false, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [assignee("Pooja", 40)],
      }),
    ).toBe("No auto assignment");
    expect(allocationText({ config: null, assignees: [] })).toBe("—");
  });
  it("equalShareLabel trims repeating decimals", () => {
    expect(equalShareLabel(2)).toBe("Equal (50% each)");
    expect(equalShareLabel(3)).toBe("Equal (33.3% each)");
    expect(equalShareLabel(4)).toBe("Equal (25% each)");
  });
});

describe("computeKpis", () => {
  it("reconciles Total = Assigned + Unassigned and dedupes assignees", () => {
    const tables = [
      table({ flowId: "f1", config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" }, assignees: [assignee("Pooja", 40), assignee("Rita", 60)] }),
      // Paused with recipients still counts as assigned.
      table({ flowId: "f2", config: { enabled: false, mode: "round_robin", whatsapp_template_name: null, updated_at: "x" }, assignees: [assignee("Pooja", 0)] }),
      table({ flowId: "f3", config: null, assignees: [] }),
      // External recipient (no user_id) counts via email identity.
      table({
        flowId: "f4",
        config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [{ id: "a-x", user_id: null, display_name: "Vendor", weight: 100, is_active: true, email: "V@x.com" }],
      }),
    ];
    const kpis = computeKpis(tables);
    expect(kpis).toEqual({ total: 4, assigned: 3, unassigned: 1, distinctAssignees: 3 });
  });

  it("hasConfiguredRecipients requires a config row plus at least one recipient", () => {
    expect(hasConfiguredRecipients({ config: null, assignees: [assignee("P")] })).toBe(false);
    expect(
      hasConfiguredRecipients({
        config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [],
      }),
    ).toBe(false);
    expect(
      hasConfiguredRecipients({
        config: { enabled: false, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
        assignees: [assignee("P")],
      }),
    ).toBe(true);
  });
});

describe("filterOverviewTables", () => {
  const rows = [
    table({
      flowId: "f1", tableName: "Rajasthan Instant Form", formName: "Rajasthan",
      config: { enabled: true, mode: "percentage", whatsapp_template_name: null, updated_at: "x" },
      assignees: [assignee("Pooja", 100)],
    }),
    table({
      flowId: "f2", tableName: "Kerala Instant Form",
      config: { enabled: false, mode: "round_robin", whatsapp_template_name: null, updated_at: "x" },
      assignees: [assignee("Rita")],
    }),
    table({ flowId: "f3", tableName: "Goa Holiday Form" }),
  ];
  it("searches by table and form name, case-insensitive", () => {
    expect(filterOverviewTables(rows, { search: "rajasthan", method: "all", status: "all" })).toHaveLength(1);
    expect(filterOverviewTables(rows, { search: "INSTANT", method: "all", status: "all" })).toHaveLength(2);
    expect(filterOverviewTables(rows, { search: "nomatch", method: "all", status: "all" })).toHaveLength(0);
  });
  it("filters by stored method (paused tables read as Manual)", () => {
    expect(filterOverviewTables(rows, { search: "", method: "percentage", status: "all" })).toHaveLength(1);
    expect(filterOverviewTables(rows, { search: "", method: "manual", status: "all" })[0].flowId).toBe("f2");
    expect(filterOverviewTables(rows, { search: "", method: "round_robin", status: "all" })).toHaveLength(0);
  });
  it("filters by status", () => {
    expect(filterOverviewTables(rows, { search: "", method: "all", status: "active" })[0].flowId).toBe("f1");
    expect(filterOverviewTables(rows, { search: "", method: "all", status: "paused" })[0].flowId).toBe("f2");
    expect(filterOverviewTables(rows, { search: "", method: "all", status: "not_configured" })[0].flowId).toBe("f3");
  });
});

describe("avatar helpers", () => {
  it("derives initials from the display name", () => {
    expect(initialsFor("Pooja")).toBe("PO");
    expect(initialsFor("Deepika Ghosh")).toBe("DG");
    expect(initialsFor("  ")).toBe("?");
  });
  it("assigns deterministic tones per identity", () => {
    expect(avatarToneFor("user:1")).toBe(avatarToneFor("user:1"));
    expect(typeof avatarToneFor("user:1")).toBe("string");
  });
});
