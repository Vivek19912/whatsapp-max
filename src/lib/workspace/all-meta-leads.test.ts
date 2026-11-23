import { describe, expect, it } from "vitest";

import {
  ALL_META_LEADS_ID,
  ALL_META_ANSWERS_EXCLUDED_KEYS,
  buildAllMetaFormAnswers,
  buildAllMetaUnionColumns,
  findUnionFieldDef,
  humanizeAnswerKey,
  defaultAllMetaColumnOrder,
  buildAllMetaLeadsQuery,
  isAllMetaLeadsId,
} from "./all-meta-leads";

describe("all-meta-leads — virtual id", () => {
  it("uses a non-UUID id that cannot collide with flow ids", () => {
    expect(ALL_META_LEADS_ID).toBe("all-meta-leads");
    expect(isAllMetaLeadsId(ALL_META_LEADS_ID)).toBe(true);
    expect(isAllMetaLeadsId("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isAllMetaLeadsId(null)).toBe(false);
  });

  it("excludes identity + source keys from Form Answers", () => {
    expect(ALL_META_ANSWERS_EXCLUDED_KEYS.has("full_name")).toBe(true);
    expect(ALL_META_ANSWERS_EXCLUDED_KEYS.has("phone_number")).toBe(true);
    expect(ALL_META_ANSWERS_EXCLUDED_KEYS.has("meta_lead_source")).toBe(true);
    // Email has its own dedicated handling — it stays in Form Answers.
    expect(ALL_META_ANSWERS_EXCLUDED_KEYS.has("email")).toBe(false);
  });
});

describe("all-meta-leads — Form Answers mapping", () => {
  it("maps each answer through its own form in order, skipping empties", () => {
    const answers = buildAllMetaFormAnswers({
      vars: {
        full_name: "Dheeraj Yadav",
        phone_number: "9695432312",
        budget: "₹60,000–₹80,000",
        travelling_with: "Friends",
        hotel: "3 Star",
        month: "December",
        meta_lead_source: "Facebook",
      },
      questions: [
        { key: "full_name", label: "Full name", type: "FULL_NAME" },
        { key: "phone_number", label: "Phone", type: "PHONE_NUMBER" },
        { key: "budget", label: "What is your budget?", type: "CUSTOM" },
        { key: "travelling_with", label: "Who will be travelling with you?", type: "CUSTOM" },
        { key: "hotel", label: "Which hotel category?", type: "CUSTOM" },
        { key: "month", label: "Which month?", type: "CUSTOM" },
      ],
      questionKeys: [
        "full_name",
        "phone_number",
        "budget",
        "travelling_with",
        "hotel",
        "month",
      ],
    });
    // Identity + source excluded; custom answers in form order.
    expect(answers.map((a) => a.answer)).toEqual([
      "₹60,000–₹80,000",
      "Friends",
      "3 Star",
      "December",
    ]);
    expect(answers[0].question).toBe("What is your budget?");
    expect(answers.every((a) => a.legacy === false)).toBe(true);
  });

  it("preserves legacy/unmapped answers with a fallback question", () => {
    const answers = buildAllMetaFormAnswers({
      vars: { budget: "₹20,000–₹40,000", old_question: "kept value", full_name: "A" },
      questions: [{ key: "budget", label: "Budget?", type: "CUSTOM" }],
      questionKeys: ["budget"],
    });
    expect(answers.map((a) => a.key)).toEqual(["budget", "old_question"]);
    expect(answers[1].legacy).toBe(true);
    expect(answers[1].question).toBe("old question");
    expect(answers[1].answer).toBe("kept value");
  });

  it("applies per-form display mapping without leaking across forms", () => {
    const answers = buildAllMetaFormAnswers({
      vars: { choice: "opt_a" },
      questions: [{ key: "choice", label: "Pick?", type: "CUSTOM" }],
      questionKeys: ["choice"],
      displayFor: (key, raw) => (key === "choice" && raw === "opt_a" ? "Option A" : raw),
    });
    expect(answers[0].answer).toBe("Option A");
  });

  it("humanizes fallback keys", () => {
    expect(humanizeAnswerKey("old_question")).toBe("old question");
    expect(humanizeAnswerKey("  ")).toBe("  ");
  });
});

describe("all-meta-leads — columns + query", () => {
  it("has a single Form Answers column in the default order", () => {
    const order = defaultAllMetaColumnOrder();
    // Visibility ids reuse the shared Workspace scheme so the
    // Columns menu, pastel header paint, and prefs behave exactly
    // like individual tables.
    expect(order).toContain("flow:form_answers");
    expect(order.filter((id) => id === "flow:form_answers")).toHaveLength(1);
  });

  it("builds the table query with table + stage filters", () => {
    const qs = buildAllMetaLeadsQuery({
      search: "dheeraj",
      page: 1,
      pageSize: 25,
      tableId: "flow-1",
      stage: ["New Lead"],
      leadType: ["Fresh"],
    });
    expect(qs).toContain("search=dheeraj");
    expect(qs).toContain("tableId=flow-1");
    expect(qs).toContain("stage=New+Lead");
    expect(qs).toContain("leadType=Fresh");
  });
});

describe("all-meta-leads — dynamic column union", () => {
  const tables = [{ flowId: "flow-a" }, { flowId: "flow-b" }];
  const defs = {
    "flow-a": [
      { id: "a1", name: "Assigned To", field_type: "single_select", position: 0 },
      { id: "a2", name: "Customer Response", field_type: "text", position: 1 },
      { id: "a3", name: "Call Status", field_type: "single_select", position: 2 },
      { id: "a4", name: "Next Action", field_type: "text", position: 3 },
      { id: "a5", name: "Final Remark", field_type: "text", position: 4 },
    ],
    "flow-b": [
      { id: "b1", name: "Customer Response", field_type: "text", position: 0 },
      { id: "b2", name: "Reason for Lost Lead", field_type: "single_select", position: 1 },
      { id: "b3", name: "Lead Type", field_type: "single_select", position: 2 },
      { id: "b4", name: "Stage", field_type: "single_select", position: 3 },
      { id: "b5", name: "Follow-Up Status", field_type: "single_select", position: 4 },
      { id: "b6", name: "No. of Calls Tried", field_type: "single_select", position: 5 },
      { id: "b7", name: "Last Contact Date", field_type: "date", position: 6 },
      { id: "b8", name: "Next Follow-up Date & Time", field_type: "datetime", position: 7 },
    ],
  };

  it("includes every operational field while skipping dedicated columns", () => {
    const cols = buildAllMetaUnionColumns(tables, defs);
    const labels = cols.map((c) => c.label);
    for (const expected of [
      "Customer Response",
      "Next Action",
      "Final Remark",
      "Reason for Lost Lead",
      "Follow-Up Status",
      "No. of Calls Tried",
      "Last Contact Date",
    ]) {
      expect(labels).toContain(expected);
    }
    // Dedicated slots are never duplicated.
    for (const dedicated of [
      "Assigned To",
      "Call Status",
      "Lead Type",
      "Stage",
      "Next Follow-up Date & Time",
    ]) {
      expect(labels).not.toContain(dedicated);
    }
  });

  it("deduplicates genuinely shared columns across flows", () => {
    const cols = buildAllMetaUnionColumns(tables, defs);
    expect(cols.filter((c) => c.label === "Customer Response")).toHaveLength(1);
  });

  it("keeps unrelated same-label fields of different types separate", () => {
    const cols = buildAllMetaUnionColumns(
      [{ flowId: "flow-a" }, { flowId: "flow-c" }],
      {
        ...defs,
        "flow-c": [{ id: "c1", name: "Customer Response", field_type: "single_select", position: 0 }],
      },
    );
    const matches = cols.filter((c) => c.label === "Customer Response");
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((c) => c.key)).size).toBe(2);
    expect(new Set(matches.map((c) => c.fieldType)).size).toBe(2);
  });

  it("orders deterministically: flow order, then field position", () => {
    const cols = buildAllMetaUnionColumns(tables, defs);
    expect(cols.map((c) => c.label)).toEqual([
      "Customer Response",
      "Next Action",
      "Final Remark",
      "Reason for Lost Lead",
      "Follow-Up Status",
      "No. of Calls Tried",
      "Last Contact Date",
    ]);
  });

  it("discovers newly added custom fields without code changes", () => {
    const cols = buildAllMetaUnionColumns([{ flowId: "flow-a" }], {
      "flow-a": [
        { id: "a9", name: "Preferred Language", field_type: "single_select", position: 9 },
      ],
    });
    expect(cols.map((c) => c.label)).toEqual(["Preferred Language"]);
  });

  it("resolves each row to its own flow field, or null when absent", () => {
    const cols = buildAllMetaUnionColumns(tables, defs);
    const customer = cols.find((c) => c.label === "Customer Response")!;
    const action = cols.find((c) => c.label === "Next Action")!;
    expect(findUnionFieldDef(defs["flow-a"], customer)?.id).toBe("a2");
    expect(findUnionFieldDef(defs["flow-b"], customer)?.id).toBe("b1");
    // flow-b has no Next Action → blank cell, never flow-a's value.
    expect(findUnionFieldDef(defs["flow-b"], action)).toBeNull();
  });

  it("produces stable visibility keys", () => {
    const first = buildAllMetaUnionColumns(tables, defs).map((c) => c.key);
    const second = buildAllMetaUnionColumns(tables, defs).map((c) => c.key);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    for (const key of first) expect(key.startsWith("all_union_")).toBe(true);
  });
});
