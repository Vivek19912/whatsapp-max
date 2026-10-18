import { describe, expect, it } from "vitest";

import {
  inferSourceFromQuestions,
  normalizeLeadFieldData,
  sanitizeQuestionKey,
  sourceFromPlatform,
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

describe("source helpers", () => {
  it("maps the platform field", () => {
    expect(sourceFromPlatform("Facebook")).toBe("facebook");
    expect(sourceFromPlatform("instagram")).toBe("instagram");
    expect(sourceFromPlatform("audience_network")).toBe("unknown");
    expect(sourceFromPlatform(null)).toBe("unknown");
  });

  it("only infers instagram from explicit signals, never guesses facebook", () => {
    expect(inferSourceFromQuestions(["instagram_username"])).toBe("instagram");
    expect(inferSourceFromQuestions(["full_name", "phone_number"])).toBe("unknown");
  });
});
