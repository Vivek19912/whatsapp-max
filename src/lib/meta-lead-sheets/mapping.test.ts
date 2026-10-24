// Meta Sheets row mapping — pure unit tests.

import { describe, expect, it } from "vitest";

import {
  META_SHEETS_HEADERS,
  META_SHEETS_LEAD_ID_COL,
  sheetsRetryDelayMs,
} from "./constants";
import { projectRowValues } from "./columns";
import {
  buildLeadFieldMap,
  buildSheetsRow,
  resolveBusinessDisplays,
  sheetsSourceLabel,
} from "./mapping";

describe("meta sheets headers", () => {
  it("owns a fixed 12-column range with the stable lead id first", () => {
    expect(META_SHEETS_HEADERS[0]).toBe("Meta Lead ID");
    expect(META_SHEETS_HEADERS).toHaveLength(12);
    expect(META_SHEETS_LEAD_ID_COL).toBe(0);
    expect(META_SHEETS_HEADERS).toContain("Form Name");
    expect(META_SHEETS_HEADERS).toContain("Assigned To");
    expect(META_SHEETS_HEADERS).toContain("Lead Type");
    expect(META_SHEETS_HEADERS).toContain("Stage");
  });

  it("backs off with bounded exponential delays", () => {
    expect(sheetsRetryDelayMs(1)).toBe(60_000);
    expect(sheetsRetryDelayMs(2)).toBe(120_000);
    expect(sheetsRetryDelayMs(10)).toBe(30 * 60_000);
  });
});

describe("buildSheetsRow", () => {
  it("maps a lead to one row keyed by the stable Meta lead id", () => {
    const row = buildSheetsRow({
      metaLeadId: "lead-123",
      submittedAt: "2026-03-01T10:00:00.000Z",
      answers: { full_name: "Asha", phone_number: "+911234567890", email: "a@example.com" },
      formName: "Form A",
      campaignName: "Camp",
      adName: "Ad 1",
      source: "Facebook",
      assigneeDisplay: "Ravi",
      leadType: "Hot",
      stage: "Qualified",
    });
    expect(row).toHaveLength(12);
    expect(row[0]).toBe("lead-123");
    expect(row[2]).toBe("Asha");
    expect(row[3]).toBe("+911234567890");
    expect(row[5]).toBe("Form A");
    expect(row[9]).toBe("Ravi");
    expect(row[10]).toBe("Hot");
    expect(row[11]).toBe("Qualified");
    // Submitted At is IST formatted, never the raw ISO passthrough.
    expect(row[1]).not.toBe("2026-03-01T10:00:00.000Z");
    expect(row[1].length).toBeGreaterThan(0);
  });

  it("falls back to Fresh / New Lead display defaults", () => {
    const row = buildSheetsRow({
      metaLeadId: "lead-9",
      submittedAt: null,
      answers: {},
      formName: null,
      campaignName: null,
      adName: null,
      source: null,
      assigneeDisplay: null,
      leadType: null,
      stage: null,
    });
    expect(row[10]).toBe("Fresh");
    expect(row[11]).toBe("New Lead");
  });

  it("never uses phone or name as the identity", () => {
    const a = buildSheetsRow({
      metaLeadId: "id-A",
      submittedAt: null,
      answers: { phone_number: "+911111111111", full_name: "Same" },
      formName: null,
      campaignName: null,
      adName: null,
      source: null,
      assigneeDisplay: null,
      leadType: null,
      stage: null,
    });
    const b = buildSheetsRow({
      metaLeadId: "id-B",
      submittedAt: null,
      answers: { phone_number: "+911111111111", full_name: "Same" },
      formName: null,
      campaignName: null,
      adName: null,
      source: null,
      assigneeDisplay: null,
      leadType: null,
      stage: null,
    });
    expect(a[0]).not.toBe(b[0]);
    expect(a[3]).toBe(b[3]);
  });
});

describe("twin selections map to the same correct values", () => {
  const input = {
    metaLeadId: "lead-1",
    submittedAt: null,
    answers: {
      full_name: "Asha Rao",
      phone_number: "+919876543210",
      budget: "5L",
      city: "Mumbai",
    },
    formName: null,
    campaignName: null,
    adName: null,
    source: null,
    assigneeDisplay: null,
    leadType: null,
    stage: null,
  };

  it("standard Name/Phone and their dynamic twins project identical values", () => {
    const map = buildLeadFieldMap(input);
    expect(map.name).toBe("Asha Rao");
    expect(map.phone).toBe("+919876543210");
    // The twins carry the same underlying Workspace data.
    expect(map["answer:full_name"]).toBe("Asha Rao");
    expect(map["answer:phone_number"]).toBe("+919876543210");
    expect(
      projectRowValues(map, [{ key: "name", label: "Name" }]),
    ).toEqual(
      projectRowValues(map, [{ key: "answer:full_name", label: "Full name" }]),
    );
  });

  it("distinct custom answers keep their own values", () => {
    const map = buildLeadFieldMap(input);
    // Values follow the configured column order; the deselected
    // ID is written last so matching keeps working.
    expect(
      projectRowValues(map, [
        { key: "answer:budget", label: "Budget" },
        { key: "answer:city", label: "City" },
      ]),
    ).toEqual(["5L", "Mumbai", "lead-1"]);
  });
});

describe("sheetsSourceLabel", () => {
  it("labels known sources and defaults unknown to Other", () => {
    expect(sheetsSourceLabel("facebook")).toBe("Facebook");
    expect(sheetsSourceLabel("instagram")).toBe("Instagram");
    expect(sheetsSourceLabel("unknown")).toBe("Other");
    expect(sheetsSourceLabel(null)).toBe("Other");
  });
});

describe("resolveBusinessDisplays", () => {
  const fields = [
    { id: "f-assign", name: "Assigned To" },
    { id: "f-type", name: "Lead Type" },
    { id: "f-stage", name: "Stage" },
  ];
  const roster = [{ user_id: "u-1", full_name: "Ravi Kumar" }];

  it("resolves member names and business defaults", () => {
    const out = resolveBusinessDisplays({
      fields,
      values: [
        { field_id: "f-assign", value_text: "u-1" },
        { field_id: "f-type", value_text: "Hot" },
        { field_id: "f-stage", value_text: "Qualified" },
      ],
      roster,
    });
    expect(out).toEqual({ assigneeDisplay: "Ravi Kumar", leadType: "Hot", stage: "Qualified" });
  });

  it("keeps Unassigned and falls back to Fresh / New Lead", () => {
    const out = resolveBusinessDisplays({
      fields,
      values: [{ field_id: "f-assign", value_text: "Unassigned" }],
      roster,
    });
    expect(out.assigneeDisplay).toBe("Unassigned");
    expect(out.leadType).toBe("Fresh");
    expect(out.stage).toBe("New Lead");
  });
});
