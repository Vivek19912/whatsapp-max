// Meta Lead Ads — human-readable option labels (display-only).
//
// Pins the display contract:
//   * a stored raw answer renders as its option `value` on an exact
//     `key` match (preferred — the label the lead saw);
//   * for a KNOWN choice question (option metadata present OR
//     persisted type CUSTOM), an unmatched underscore-separated value
//     renders with spaces instead of underscores (`davinci_resolve`
//     → `davinci resolve`) — even when options were never synced;
//   * free text, answers without underscores, standard-typed
//     questions (FULL_NAME, PHONE_NUMBER, EMAIL, …), and unknown
//     question types render verbatim — never guessed;
//   * multi-select answers resolve per item; separators survive
//     byte-for-byte, unmatched items survive;
//   * stored answers and field identifiers are never modified.

import { describe, expect, it } from "vitest";

import { questionVarKeys } from "./virtual-flow";
import {
  applyOptionLabelsToAnswers,
  buildOptionLabelMap,
  choiceQuestionKeys,
  isChoiceQuestionType,
  mapAnswerValue,
  type StoredFormQuestion,
} from "./option-labels";

const QUESTIONS: StoredFormQuestion[] = [
  {
    key: "service",
    label: "Which service?",
    type: "CUSTOM",
    options: [
      { key: "adobe_premiere_pro", value: "Adobe Premiere Pro" },
      { key: "after_effects", value: "After Effects" },
    ],
  },
  { key: "full_name", label: "Full name", type: "FULL_NAME", options: [] },
];

const KEYS = ["service", "full_name"];

describe("buildOptionLabelMap", () => {
  it("indexes display labels by answer key and exact raw value", () => {
    const map = buildOptionLabelMap(QUESTIONS, KEYS);
    expect(map.get("service")?.get("adobe_premiere_pro")).toBe("Adobe Premiere Pro");
    expect(map.get("service")?.get("after_effects")).toBe("After Effects");
  });

  it("skips options without a usable key or label", () => {
    const map = buildOptionLabelMap(
      [{ key: "q", label: "Q?", options: [{ key: "", value: "X" }, { key: "k", value: "" }, { key: null, value: null }] }],
      ["q"],
    );
    expect(map.get("q")?.size ?? 0).toBe(0);
  });

  it("keeps the first label for duplicate keys (deterministic)", () => {
    const map = buildOptionLabelMap(
      [{ key: "q", options: [{ key: "k", value: "One" }, { key: "k", value: "Two" }] }],
      ["q"],
    );
    expect(map.get("q")?.get("k")).toBe("One");
  });
});

describe("mapAnswerValue", () => {
  const labels = new Map([["adobe_premiere_pro", "Adobe Premiere Pro"]]);

  it("maps an exact raw match to the human-readable label", () => {
    expect(mapAnswerValue(labels, "adobe_premiere_pro")).toBe("Adobe Premiere Pro");
  });

  it("leaves free text and underscore-free values verbatim", () => {
    expect(mapAnswerValue(labels, "Need help with editing")).toBe(
      "Need help with editing",
    );
    expect(mapAnswerValue(labels, "Custom Text")).toBe("Custom Text");
    expect(mapAnswerValue(labels, null)).toBe(null);
  });

  it("never guesses without option metadata (free text stays intact)", () => {
    expect(mapAnswerValue(new Map(), "adobe_premiere_pro")).toBe("adobe_premiere_pro");
    expect(mapAnswerValue(new Map(), "rahul_kumar@gmail.com")).toBe(
      "rahul_kumar@gmail.com",
    );
    expect(mapAnswerValue(undefined, "some_value")).toBe("some_value");
  });

  it("renders unmatched underscore values with spaces on choice questions", () => {
    expect(mapAnswerValue(labels, "davinci_resolve", true)).toBe("davinci resolve");
    expect(mapAnswerValue(labels, "2–3_years", true)).toBe("2–3 years");
    // Exact labels still win over the fallback.
    expect(mapAnswerValue(labels, "adobe_premiere_pro", true)).toBe(
      "Adobe Premiere Pro",
    );
  });

  it("renders verbatim when the question is not a known choice", () => {
    // Same labels, same values — but without choice eligibility the
    // fallback must not fire (this was the production bug: the old
    // code keyed the fallback off label presence instead).
    expect(mapAnswerValue(labels, "davinci_resolve")).toBe("davinci_resolve");
    expect(mapAnswerValue(labels, "davinci_resolve", false)).toBe("davinci_resolve");
    expect(mapAnswerValue(undefined, "davinci_resolve", false)).toBe(
      "davinci_resolve",
    );
  });

  it("resolves multi-select answers per item, keeping unmatched parts", () => {
    expect(mapAnswerValue(labels, "adobe_premiere_pro, custom text", true)).toBe(
      "Adobe Premiere Pro, custom text",
    );
    expect(mapAnswerValue(labels, "adobe_premiere_pro, davinci_resolve", true)).toBe(
      "Adobe Premiere Pro, davinci resolve",
    );
  });

  it("never alters separators or unmatched values (no space-padding changes)", () => {
    expect(mapAnswerValue(new Map(), "a,b")).toBe("a,b");
    expect(mapAnswerValue(labels, "a,b", true)).toBe("a,b");
    expect(mapAnswerValue(labels, "a_b,c", true)).toBe("a b,c");
    expect(mapAnswerValue(labels, "", true)).toBe("");
  });
});

describe("applyOptionLabelsToAnswers", () => {
  it("maps only dynamic question answers and never mutates the input", () => {
    const answers = { service: "adobe_premiere_pro", note: "Call me" };
    const map = buildOptionLabelMap(QUESTIONS, KEYS);
    const out = applyOptionLabelsToAnswers(answers, map);
    expect(out).toEqual({ service: "Adobe Premiere Pro", note: "Call me" });
    expect(answers).toEqual({ service: "adobe_premiere_pro", note: "Call me" });
  });

  it("prefers labels, falls back to spaces, leaves free text alone", () => {
    const map = buildOptionLabelMap(QUESTIONS, KEYS);
    const choiceKeys = choiceQuestionKeys(QUESTIONS, KEYS);
    const out = applyOptionLabelsToAnswers(
      {
        service: "davinci_resolve",
        full_name: "rahul_kumar",
      },
      map,
      choiceKeys,
    );
    // `service` is a choice question: unmatched key prettified.
    expect(out.service).toBe("davinci resolve");
    // `full_name` (FULL_NAME, no options): free text verbatim, even
    // with underscores.
    expect(out.full_name).toBe("rahul_kumar");
  });

  it("without choice keys only exact labels apply", () => {
    const map = buildOptionLabelMap(QUESTIONS, KEYS);
    const out = applyOptionLabelsToAnswers({ service: "davinci_resolve" }, map);
    expect(out.service).toBe("davinci_resolve");
  });
});

describe("isChoiceQuestionType", () => {
  it("treats Meta custom questions as choice questions", () => {
    expect(isChoiceQuestionType("CUSTOM")).toBe(true);
    expect(isChoiceQuestionType(" custom ")).toBe(true);
  });

  it("never treats standard or unknown types as choices", () => {
    for (const type of [
      "FULL_NAME",
      "FIRST_NAME",
      "LAST_NAME",
      "PHONE_NUMBER",
      "EMAIL",
      "CITY",
      null,
      undefined,
      "",
    ]) {
      expect(isChoiceQuestionType(type)).toBe(false);
    }
  });
});

describe("choiceQuestionKeys", () => {
  it("marks questions with options and CUSTOM questions without options", () => {
    const questions: StoredFormQuestion[] = [
      {
        key: "software",
        label: "Software?",
        type: "CUSTOM",
        options: [{ key: "davinci_resolve", value: "DaVinci Resolve" }],
      },
      // No options synced (older enabled form) — still a choice.
      { key: "experience", label: "Experience?", type: "CUSTOM" },
      { key: "full_name", label: "Full name", type: "FULL_NAME" },
      { key: "email", label: "Email", type: "EMAIL" },
      { key: "mystery", label: "Mystery?" },
    ];
    const keys = ["software", "experience", "full_name", "email", "mystery"];
    expect(choiceQuestionKeys(questions, keys)).toEqual(
      new Set(["software", "experience"]),
    );
  });

  it("ignores unusable options and misaligned indexes safely", () => {
    const questions: StoredFormQuestion[] = [
      { key: "q", type: "CUSTOM", options: [{ key: "", value: "X" }] },
    ];
    // Empty option is unusable, but CUSTOM type still marks it.
    expect(choiceQuestionKeys(questions, ["q"])).toEqual(new Set(["q"]));
    expect(choiceQuestionKeys(questions, [])).toEqual(new Set());
    expect(choiceQuestionKeys(null, ["q"])).toEqual(new Set());
  });
});

describe("end to end: stored form questions to displayed answers", () => {
  it("newly imported leads resolve through the same keys the flow materializes", () => {
    const stored: StoredFormQuestion[] = [
      {
        key: "Which service do you need?",
        label: "Which service do you need?",
        type: "CUSTOM",
        options: [{ key: "video_editing", value: "Video Editing" }],
      },
      { key: "full_name", label: "Full name", type: "FULL_NAME", options: [] },
    ];
    // Identifiers are derived with the virtual-flow derivation, so the
    // display map always lines up with stored answers and node keys.
    const keys = questionVarKeys(stored);
    expect(keys[0]).toBe("which_service_do_you_need");
    const map = buildOptionLabelMap(stored, keys);
    const out = applyOptionLabelsToAnswers(
      { which_service_do_you_need: "video_editing", full_name: "Asha" },
      map,
    );
    expect(out).toEqual({
      which_service_do_you_need: "Video Editing",
      full_name: "Asha",
    });
  });
});
