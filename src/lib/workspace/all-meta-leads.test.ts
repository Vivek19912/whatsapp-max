import { describe, expect, it } from "vitest";

import {
  ALL_META_LEADS_ID,
  ALL_META_ANSWERS_EXCLUDED_KEYS,
  buildAllMetaFormAnswers,
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
    expect(order).toContain("all:form_answers");
    expect(order.filter((id) => id === "all:form_answers")).toHaveLength(1);
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
