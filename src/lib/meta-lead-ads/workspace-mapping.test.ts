// ============================================================
// Regression: a Meta Instant Form lead must reach the Workspace
// with the fields Meta actually supplied.
//
// Composes the real pipeline pieces in order:
//   Graph field_data → normalizeLeadFieldData → virtual-flow
//   columns → toFlowTableRow (with the route's identity fallback).
//
// Uses the exact payload Meta's Lead Ads Testing Tool returned in
// production for the "Travel Agency Customers" form (two dummy
// placeholders for full_name/phone_number, no `platform`). A test
// lead with no usable phone has no contact row, so the system
// Name/Phone columns must fall back to Meta's own values instead of
// rendering blank. Nothing is invented when Meta omits a field.
// ============================================================

import { describe, expect, it } from "vitest";

import {
  buildFlowTableColumns,
  toFlowTableRow,
} from "@/lib/flows/flow-tables";

import { normalizeLeadFieldData, sourceFromPlatform, sourceLabel, standardContactFromAnswers } from "./normalize";
import { buildVirtualFlowNodes, META_SOURCE_COLUMN_KEY, type MetaQuestionInput } from "./virtual-flow";

const FORM_QUESTIONS: MetaQuestionInput[] = [
  { key: "when_are_you_planning_for_kedarnath_yatra?", label: "When are you planning for Kedarnath Yatra?" },
  { key: "how_many_people_will_travel?", label: "How many people will travel?" },
  { key: "your_budget_per_person_(approx)?", label: "Your budget per Person (approx)?" },
  { key: "what_types_of_package_are_you_looking_for?", label: "What types of package are you looking for?" },
  { key: "when_should_we_call_you?", label: "When should we call you?" },
  { key: "email", label: "Email" },
  { key: "full_name", label: "Full name" },
  { key: "phone_number", label: "Phone number" },
];

/** Exact `field_data` Meta returned for the production test lead. */
const TEST_LEAD_FIELD_DATA = [
  { name: "when_are_you_planning_for_kedarnath_yatra?", values: ["<test lead: dummy data for when_are_you_planning_for_kedarnath_yatra?>"] },
  { name: "how_many_people_will_travel?", values: ["<test lead: dummy data for how_many_people_will_travel?>"] },
  { name: "your_budget_per_person_(approx)?", values: ["<test lead: dummy data for your_budget_per_person_(approx)?>"] },
  { name: "what_types_of_package_are_you_looking_for?", values: ["<test lead: dummy data for what_types_of_package_are_you_looking_for?>"] },
  { name: "when_should_we_call_you?", values: ["<test lead: dummy data for when_should_we_call_you?>"] },
  { name: "email", values: ["test@meta.com"] },
  { name: "full_name", values: ["<test lead: dummy data for full_name>"] },
  { name: "phone_number", values: ["<test lead: dummy data for phone_number>"] },
];

function columns() {
  const { nodes, entryNodeKey } = buildVirtualFlowNodes(FORM_QUESTIONS);
  return buildFlowTableColumns(nodes, entryNodeKey);
}

describe("Meta test lead → Workspace mapping", () => {
  it("surfaces the dummy name/phone Meta supplied and every answer column", () => {
    const row = toFlowTableRow(
      {
        run_id: "run-1",
        contact_id: null,
        contact_name: null,
        contact_phone: null,
        conversation_id: null,
        status: "completed",
        started_at: "2026-10-19T20:10:33.000Z",
        last_advanced_at: null,
        ended_at: "2026-10-19T20:10:33.000Z",
        reached_at: null,
        is_completed: true,
        vars: {
          ...normalizeLeadFieldData(TEST_LEAD_FIELD_DATA).answers,
          [META_SOURCE_COLUMN_KEY]: sourceLabel(sourceFromPlatform(null)),
        },
      },
      null,
      null,
      columns().answerKeys,
      standardContactFromAnswers(
        normalizeLeadFieldData(TEST_LEAD_FIELD_DATA).answers,
      ),
    );

    expect(row.name).toBe("<test lead: dummy data for full_name>");
    expect(row.phone).toBe("<test lead: dummy data for phone_number>");
    expect(row.answers.email).toBe("test@meta.com");
    expect(row.answers[`when_should_we_call_you`]).toContain("test lead");
    // Meta omitted `platform` for the test lead — never guessed.
    expect(row.answers[META_SOURCE_COLUMN_KEY]).toBe("Other");
  });

  it("attributes Facebook and Instagram short codes, contact data wins", () => {
    const fieldData = [
      { name: "full_name", values: ["Rahul Sharma"] },
      { name: "phone_number", values: ["+919999999999"] },
      { name: "email", values: ["rahul@example.com"] },
    ];
    for (const [platform, label] of [
      ["fb", "Facebook"],
      ["ig", "Instagram"],
    ] as const) {
      const normalized = normalizeLeadFieldData(fieldData);
      const vars = {
        ...normalized.answers,
        [META_SOURCE_COLUMN_KEY]: sourceLabel(sourceFromPlatform(platform)),
      };
      const row = toFlowTableRow(
        {
          run_id: `run-${platform}`,
          contact_id: "c-1",
          contact_name: "Rahul (WhatsApp)",
          contact_phone: "+919999999999",
          conversation_id: null,
          status: "completed",
          started_at: "2026-10-19T20:10:33.000Z",
          last_advanced_at: null,
          ended_at: "2026-10-19T20:10:33.000Z",
          reached_at: null,
          is_completed: true,
          vars,
        },
        null,
        null,
        columns().answerKeys,
        standardContactFromAnswers(vars),
      );
      expect(row.answers[META_SOURCE_COLUMN_KEY]).toBe(label);
      expect(row.name).toBe("Rahul (WhatsApp)");
      expect(row.phone).toBe("+919999999999");
      expect(row.answers.email).toBe("rahul@example.com");
    }
  });

  it("leaves absent optional fields empty instead of inventing values", () => {
    const normalized = normalizeLeadFieldData([
      { name: "full_name", values: ["Only Name"] },
    ]);
    expect(normalized.standard).toEqual({
      name: "Only Name",
      phone: null,
      email: null,
    });
    const row = toFlowTableRow(
      {
        run_id: "run-min",
        contact_id: null,
        contact_name: null,
        contact_phone: null,
        conversation_id: null,
        status: "completed",
        started_at: "2026-10-19T20:10:33.000Z",
        last_advanced_at: null,
        ended_at: "2026-10-19T20:10:33.000Z",
        reached_at: null,
        is_completed: true,
        vars: normalized.answers,
      },
      null,
      null,
      columns().answerKeys,
      standardContactFromAnswers(normalized.answers),
    );
    expect(row.name).toBe("Only Name");
    expect(row.phone).toBeNull();
    expect(row.answers.email).toBeNull();
    expect(row.answers.phone_number).toBeNull();
  });
});
