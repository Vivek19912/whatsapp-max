import { describe, expect, it } from "vitest";

import {
  inferSourceFromQuestions,
  normalizeLeadFieldData,
  sanitizeQuestionKey,
  sourceFromPlatform,
  sourceLabel,
  standardContactFromAnswers,
} from "./normalize";

describe("sanitizeQuestionKey", () => {
  it("lowercases and snake-cases", () => {
    expect(sanitizeQuestionKey("Full Name", 0)).toBe("full_name");
    expect(sanitizeQuestionKey("  E-mail Address!  ", 0)).toBe("e_mail_address");
  });

  it("falls back to question_<index> when nothing usable remains", () => {
    expect(sanitizeQuestionKey("", 3)).toBe("question_3");
    expect(sanitizeQuestionKey("!!!", 1)).toBe("question_1");
    expect(sanitizeQuestionKey(null, 2)).toBe("question_2");
  });
});

describe("normalizeLeadFieldData", () => {
  it("derives standard fields from the response keys", () => {
    const { answers, standard } = normalizeLeadFieldData([
      { name: "full_name", values: ["Ada Lovelace"] },
      { name: "phone_number", values: ["+1 555 0100"] },
      { name: "email", values: ["ada@example.com"] },
    ]);
    expect(standard).toEqual({
      name: "Ada Lovelace",
      phone: "+1 555 0100",
      email: "ada@example.com",
    });
    expect(answers.full_name).toBe("Ada Lovelace");
  });

  it("combines split first/last names", () => {
    const { standard } = normalizeLeadFieldData([
      { name: "first_name", values: ["Grace"] },
      { name: "last_name", values: ["Hopper"] },
    ]);
    expect(standard.name).toBe("Grace Hopper");
  });

  it("joins multi-value answers and drops empties", () => {
    const { answers } = normalizeLeadFieldData([
      { name: "interest", values: ["Hotels", "  ", "Flights"] },
      { name: "empty", values: [" ", ""] },
    ]);
    expect(answers.interest).toBe("Hotels, Flights");
    expect("empty" in answers).toBe(false);
  });

  it("ignores malformed rows and keeps the first on key collisions", () => {
    const { answers } = normalizeLeadFieldData([
      { name: "Phone", values: ["111"] },
      { name: "phone", values: ["222"] },
      null as never,
      { name: "ok", values: ["yes"] },
    ]);
    expect(answers.phone).toBe("111");
    expect(answers.ok).toBe("yes");
  });

  it("handles null/undefined input", () => {
    expect(normalizeLeadFieldData(null)).toEqual({
      answers: {},
      standard: { name: null, phone: null, email: null },
    });
    expect(normalizeLeadFieldData(undefined).standard.phone).toBeNull();
  });
});

describe("standardContactFromAnswers", () => {
  it("resolves the same standard fields from an existing answer map", () => {
    expect(
      standardContactFromAnswers({
        full_name: "Ada Lovelace",
        phone_number: "+1 555 0100",
        email: "ada@example.com",
      }),
    ).toEqual({
      name: "Ada Lovelace",
      phone: "+1 555 0100",
      email: "ada@example.com",
    });
  });

  it("combines split names and leaves absent fields null (never invented)", () => {
    expect(
      standardContactFromAnswers({ first_name: "Grace", last_name: "Hopper" }),
    ).toEqual({ name: "Grace Hopper", phone: null, email: null });
    expect(standardContactFromAnswers({})).toEqual({
      name: null,
      phone: null,
      email: null,
    });
    expect(standardContactFromAnswers(null)).toEqual({
      name: null,
      phone: null,
      email: null,
    });
  });

  it("ignores blank and non-string values", () => {
    expect(
      standardContactFromAnswers({
        full_name: "   ",
        phone_number: null,
        email: 42 as unknown as string,
      }),
    ).toEqual({ name: null, phone: null, email: null });
  });
});

describe("source helpers", () => {
  it("maps the platform field, including Meta's fb/ig short codes", () => {
    expect(sourceFromPlatform("Facebook")).toBe("facebook");
    expect(sourceFromPlatform("instagram")).toBe("instagram");
    expect(sourceFromPlatform("fb")).toBe("facebook");
    expect(sourceFromPlatform("FB")).toBe("facebook");
    expect(sourceFromPlatform("ig")).toBe("instagram");
    expect(sourceFromPlatform("IG")).toBe("instagram");
    expect(sourceFromPlatform("audience_network")).toBe("unknown");
    expect(sourceFromPlatform(null)).toBe("unknown");
  });

  it("labels Facebook/Instagram and keeps missing platform unattributed", () => {
    expect(sourceLabel("facebook")).toBe("Facebook");
    expect(sourceLabel("instagram")).toBe("Instagram");
    expect(sourceLabel("unknown")).toBe("Other");
  });

  it("only infers instagram from explicit signals, never guesses facebook", () => {
    expect(inferSourceFromQuestions(["instagram_username"])).toBe("instagram");
    expect(inferSourceFromQuestions(["full_name", "phone_number"])).toBe("unknown");
  });
});
