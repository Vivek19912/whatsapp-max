import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AllMetaAnswersCell } from "./all-meta-answers-cell";

const root = process.cwd();
const src = () => readFileSync(`${root}/src/components/workspace/all-meta-answers-cell.tsx`, "utf8");

function sampleAnswers() {
  return [
    { key: "budget", question: "What is your budget?", answer: "₹60,000–₹80,000", legacy: false },
    { key: "travelling_with", question: "Who will be travelling with you?", answer: "Friends", legacy: false },
    { key: "hotel", question: "Which hotel category?", answer: "3 Star", legacy: false },
    { key: "month", question: "Which month?", answer: "December", legacy: false },
  ];
}

describe("all-meta-answers-cell — Form Answers single column, full values", () => {
  it("renders every actual answer in full, one per item, with no question labels as visible cell text", () => {
    const html = renderToStaticMarkup(
      <AllMetaAnswersCell answers={sampleAnswers()} tableName="Final Spiti Valley Instant Form 17 NOV" />,
    );
    for (const a of sampleAnswers()) {
      // Visible answer text (inside the answer span).
      expect(html).toContain(`>${a.answer}</span>`);
      // Questions must not render as visible cell text (they live in
      // aria-label/title for a11y + tooltip content client-side).
      expect(html).not.toContain(`>${a.question}</span>`);
    }
  });

  it("never truncates: no ellipsis CSS, no line-clamp, no truncate class, wraps and expands", () => {
    const s = src();
    expect(s).not.toContain("text-overflow");
    expect(s).not.toContain("line-clamp-");
    // No Tailwind truncate class (word in comments is fine).
    expect(s).not.toMatch(/["'\s]truncate["'\s]/);
    // No generic "N Answers" link in the rendered cell (comment mentions are fine).
    const html = renderToStaticMarkup(<AllMetaAnswersCell answers={sampleAnswers()} />);
    expect(html).not.toContain("5 Answers");
    expect(html).not.toMatch(/\d+ Answers/);
    // Wrapping + row expansion.
    expect(s).toContain("whitespace-normal");
    expect(s).toContain("break-words");
    expect(s).toContain("overflowWrap");
  });

  it("each answer has its own hover tooltip with its own question + complete answer", () => {
    const s = src();
    // One tooltip per answer (mapped, not whole-form).
    expect(s).toContain("TooltipProvider");
    expect(s).toContain("TooltipTrigger");
    expect(s).toContain("TooltipContent");
    // Tooltip shows the individual question + complete answer.
    expect(s).toContain("Q. {a.question}");
    expect(s).toContain("Answer:");
    expect(s).toContain("{a.answer}");
    // Touch/focus equivalents.
    expect(s).toContain("onFocus");
    expect(s).toContain("onBlur");
    expect(s).toContain("onClick");
  });

  it("tooltip supports long Q&A, stays in viewport, readable in light/dark", () => {
    const s = src();
    expect(s).toContain("whitespace-normal");
    expect(s).toContain("break-words");
    expect(s).toContain("max-w");
    expect(s).toContain("dark:");
    // Viewport collision handling comes from the shared Tooltip (Base UI).
    expect(s).toContain('side="top"');
    expect(s).toContain('align="start"');
  });

  it("long answers wrap and increase row height (no fixed cell height)", () => {
    const longAnswer = "This is a very long customer description that should wrap onto multiple lines and expand the row height instead of being cut off with ellipsis. ".repeat(5);
    const html = renderToStaticMarkup(
      <AllMetaAnswersCell
        answers={[{ key: "notes", question: "Tell us more?", answer: longAnswer, legacy: false }]}
      />,
    );
    expect(html).toContain(longAnswer.slice(0, 50));
    const s = src();
    // No fixed heights that cut off answers.
    expect(s).not.toMatch(/h-\d+\s.*overflow-hidden/);
    expect(s).not.toContain("max-h-");
  });

  it("empty answers render a dash, never a fake value", () => {
    const html = renderToStaticMarkup(<AllMetaAnswersCell answers={[]} />);
    expect(html).toContain("—");
  });
});
