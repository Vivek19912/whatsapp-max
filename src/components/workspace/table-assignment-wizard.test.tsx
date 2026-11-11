// Assignment 3-step wizard — behavior-level tests.
//
// Covers step validation (assign + notify gates), the stepper and
// review-summary presentation components (rendered output, not
// source strings), and the wizard state-management contract in the
// dialog source.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ASSIGNMENT_STEPS,
  AssignmentReviewSummary,
  AssignmentStepper,
  validateAssignStep,
  validateNotifyStep,
  type AssignmentStep,
} from "./table-assignment-dialog";

const draft = (over: Record<string, unknown> = {}) => ({
  display_name: "Mukesh Singh",
  user_id: "u-1",
  email: "mukesh@example.com",
  phone: "+911234567890",
  whatsapp_numbers: [],
  notify_email: true,
  sequence: null,
  sequenceDirty: false,
  ...over,
});

describe("wizard step validation — assign", () => {
  it("blocks continuing with no members", () => {
    expect(validateAssignStep([], "round_robin")).toMatch(/team member/i);
  });

  it("blocks continuing when no member receives new leads", () => {
    const problem = validateAssignStep(
      [{ key: "a", is_active: false, weight: "0" }],
      "round_robin",
    );
    expect(problem).toMatch(/receives new leads/i);
  });

  it("requires exactly 100% active allocation in percentage mode", () => {
    const drafts = [
      { key: "a", is_active: true, weight: "60" },
      { key: "b", is_active: true, weight: "30" },
    ];
    expect(validateAssignStep(drafts, "percentage")).toMatch(/100%/);
    expect(
      validateAssignStep(
        [...drafts, { key: "c", is_active: true, weight: "10" }],
        "percentage",
      ),
    ).toBeNull();
  });

  it("ignores inactive shares in the percentage total", () => {
    const drafts = [
      { key: "a", is_active: true, weight: "100" },
      { key: "b", is_active: false, weight: "50" },
    ];
    expect(validateAssignStep(drafts, "percentage")).toBeNull();
  });

  it("accepts eligible members in round robin mode", () => {
    expect(
      validateAssignStep([{ key: "a", is_active: true, weight: "0" }], "round_robin"),
    ).toBeNull();
  });
});

describe("wizard step validation — notifications", () => {
  const base = {
    notifyEnabled: false,
    templateName: "",
    templateStale: false,
    drafts: [draft()],
    rosterEmailFor: () => "",
    checkSequences: false,
  };

  it("requires a template when team notifications are enabled", () => {
    expect(
      validateNotifyStep({ ...base, notifyEnabled: true }),
    ).toMatch(/notification template/i);
  });

  it("blocks a stale saved template", () => {
    expect(
      validateNotifyStep({
        ...base,
        notifyEnabled: true,
        templateName: "old_tpl",
        templateStale: true,
      }),
    ).toMatch(/no longer approved/i);
  });

  it("blocks email alerts with no reachable recipient", () => {
    expect(
      validateNotifyStep({
        ...base,
        drafts: [draft({ email: "", user_id: null })],
      }),
    ).toMatch(/no email address/i);
  });

  it("falls back to the linked roster email", () => {
    expect(
      validateNotifyStep({
        ...base,
        drafts: [draft({ email: "" })],
        rosterEmailFor: () => "roster@example.com",
      }),
    ).toBeNull();
  });

  it("blocks malformed primary phone numbers", () => {
    expect(
      validateNotifyStep({ ...base, drafts: [draft({ phone: "12345" })] }),
    ).toMatch(/invalid/i);
  });

  it("blocks malformed customer-sequence delays", () => {
    expect(
      validateNotifyStep({
        ...base,
        checkSequences: true,
        drafts: [
          draft({
            sequenceDirty: true,
            sequence: { delay_seconds: "abc", items: [{ template_name: "t", template_language: "en_US", variable_mappings: {} }] },
          }),
        ],
      }),
    ).toMatch(/Delay must be/);
  });

  it("accepts a fully valid notification configuration", () => {
    expect(
      validateNotifyStep({
        ...base,
        notifyEnabled: true,
        templateName: "lead_assigned",
      }),
    ).toBeNull();
  });
});

describe("AssignmentStepper (rendered output)", () => {
  it("marks step 1 current with all three labels", () => {
    const html = renderToStaticMarkup(
      <AssignmentStepper step="assign" completedSteps={[]} />,
    );
    expect(html).toContain("Assign leads");
    expect(html).toContain("Notifications");
    expect(html).toContain("Review");
    expect(html).toContain("Step 1: Assign leads (current step)");
    expect(html).not.toContain("(completed)");
  });

  it("marks completed steps with a check and allows going back", () => {
    const html = renderToStaticMarkup(
      <AssignmentStepper
        step="review"
        completedSteps={["assign", "notifications"]}
        onStepClick={() => {}}
      />,
    );
    expect(html).toContain("Step 1: Assign leads (completed)");
    expect(html).toContain("Step 3: Review (current step)");
    expect(html).toContain("Go back to Step 1: Assign leads");
    // Upcoming steps are never clickable buttons.
    expect(html).not.toContain("Go back to Step 3");
  });

  it("exposes the step order contract", () => {
    expect(ASSIGNMENT_STEPS.map((s) => s.key)).toEqual([
      "assign",
      "notifications",
      "review",
    ]);
    const _type: AssignmentStep = "review";
    expect(_type).toBe("review");
  });
});

describe("AssignmentReviewSummary (rendered output)", () => {
  const drafts = [
    { display_name: "Mukesh Singh", weight: "60", is_active: true, notify_email: true, sequence: null },
    {
      display_name: "Aman Yadav",
      weight: "40",
      is_active: true,
      notify_email: false,
      sequence: {
        delay_seconds: "60",
        items: [{ template_name: "t", template_language: "en_US", variable_mappings: {} }],
      },
    },
  ];

  it("summarizes distribution, members, notifications, sequences, and activation", () => {
    const html = renderToStaticMarkup(
      <AssignmentReviewSummary
        mode="percentage"
        drafts={drafts}
        activeWeightTotal={100}
        notifyEnabled
        templateName="lead_assigned"
        templateLanguage="en_US"
        enabled
        isNew={false}
      />,
    );
    expect(html).toContain("Percentage-based");
    expect(html).toContain("Total allocation: 100%");
    expect(html).toContain("Mukesh Singh");
    expect(html).toContain("60%");
    expect(html).toContain("Team WhatsApp notifications: Enabled");
    expect(html).toContain("lead_assigned");
    expect(html).toContain("1 of 2 members");
    expect(html).toContain("No sequence configured");
    expect(html).toContain("1 message configured");
    expect(html).toContain("Status: Active");
  });

  it("hides percentages in round robin and reports a paused state", () => {
    const html = renderToStaticMarkup(
      <AssignmentReviewSummary
        mode="round_robin"
        drafts={drafts}
        activeWeightTotal={100}
        notifyEnabled={false}
        templateName=""
        templateLanguage=""
        enabled={false}
        isNew
      />,
    );
    expect(html).toContain("Round robin");
    expect(html).not.toContain("Total allocation");
    expect(html).toContain("Team WhatsApp notifications: Disabled");
    expect(html).toContain("Status: Paused");
  });
});
