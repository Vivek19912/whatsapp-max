// Assignment 4-step wizard — behavior-level tests.
//
// Covers step validation (assign + notify + sequences gates), the
// stepper and review-summary presentation components (rendered
// output, not source strings), and the wizard state-management
// contract in the dialog source.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ASSIGNMENT_STEPS,
  AssignmentReviewSummary,
  AssignmentStepper,
  maskContactEmail,
  maskContactPhone,
  resolveEnabledOnSave,
  validateAssignStep,
  validateMemberStep1,
  validateNotifyStep,
  validateSequencesStep,
  validateShareValue,
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
  it("allows continuing with an intentionally empty roster", () => {
    // An empty member list is a valid explicit configuration: new
    // leads stay unassigned until members are added. The table
    // engine keeps ownership (no-config is never returned), so the
    // legacy global rule cannot take over.
    expect(validateAssignStep([], "round_robin")).toBeNull();
    expect(validateAssignStep([], "percentage")).toBeNull();
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

  it("accepts non-standard manual shares; only the total must be 100%", () => {
    const drafts = [
      { key: "a", is_active: true, weight: "35" },
      { key: "b", is_active: true, weight: "65" },
    ];
    expect(validateAssignStep(drafts, "percentage")).toBeNull();
  });
});

describe("wizard share entry — typed or picked (validateShareValue)", () => {
  it("accepts manually typed values that are not multiples of 10", () => {
    for (const w of ["15", "25", "35", "45", "65", "0", "100", "5", "99"]) {
      expect(validateShareValue(w, "Asha")).toBeNull();
    }
  });

  it("accepts every quick-select preset", () => {
    for (const w of ["10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]) {
      expect(validateShareValue(w, "Asha")).toBeNull();
    }
  });

  it("rejects blank, non-numeric, and out-of-range values", () => {
    expect(validateShareValue("", "Asha")).toMatch(/between 0 and 100/);
    expect(validateShareValue("   ", "Asha")).toMatch(/between 0 and 100/);
    expect(validateShareValue("abc", "Asha")).toMatch(/between 0 and 100/);
    expect(validateShareValue("-1", "Asha")).toMatch(/between 0 and 100/);
    expect(validateShareValue("101", "Asha")).toMatch(/between 0 and 100/);
    expect(validateShareValue("1000", "Asha")).toMatch(/between 0 and 100/);
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
  it("marks step 1 current with all four labels", () => {
    const html = renderToStaticMarkup(
      <AssignmentStepper step="assign" completedSteps={[]} />,
    );
    expect(html).toContain("Team Members &amp; Allocation");
    expect(html).toContain("Salesperson Notifications");
    expect(html).toContain("WhatsApp Template to Lead");
    expect(html).toContain("Review &amp; Save");
    expect(html).toContain("Step 1: Team Members &amp; Allocation (current step)");
    expect(html).not.toContain("(completed)");
  });

  it("marks completed steps with a check and allows going back", () => {
    const html = renderToStaticMarkup(
      <AssignmentStepper
        step="review"
        completedSteps={["assign", "notify", "sequences"]}
        onStepClick={() => {}}
      />,
    );
    expect(html).toContain("Step 1: Team Members &amp; Allocation (completed)");
    expect(html).toContain("Step 4: Review &amp; Save (current step)");
    expect(html).toContain("Go back to Step 1: Team Members &amp; Allocation");
    // Upcoming steps are never clickable buttons.
    expect(html).not.toContain("Go back to Step 4");
  });

  it("exposes the step order contract", () => {
    expect(ASSIGNMENT_STEPS.map((s) => s.key)).toEqual([
      "assign",
      "notify",
      "sequences",
      "review",
    ]);
    const _type: AssignmentStep = "review";
    expect(_type).toBe("review");
  });
});

describe("AssignmentReviewSummary (rendered output)", () => { const drafts = [
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

describe("wizard step validation — sequences", () => {
  const full = (over: Record<string, unknown> = {}) => ({
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
  const seq = (delay_seconds: string) => ({
    delay_seconds,
    items: [{ template_name: "t", template_language: "en_US", variable_mappings: {} }],
  });

  it("accepts untouched and empty sequences", () => {
    expect(
      validateSequencesStep({ drafts: [], isMetaTable: true }),
    ).toBeNull();
    expect(
      validateSequencesStep({
        drafts: [full({ sequenceDirty: false, sequence: seq("abc") })],
        isMetaTable: true,
      }),
    ).toBeNull();
  });

  it("blocks malformed customer-sequence delays", () => {
    expect(
      validateSequencesStep({
        drafts: [full({ sequenceDirty: true, sequence: seq("abc") })],
        isMetaTable: true,
      }),
    ).toMatch(/Delay must be/);
    expect(
      validateSequencesStep({
        drafts: [full({ sequenceDirty: true, sequence: seq("99999") })],
        isMetaTable: true,
      }),
    ).toMatch(/Delay must be/);
    expect(
      validateSequencesStep({
        drafts: [full({ sequenceDirty: true, sequence: seq("60") })],
        isMetaTable: true,
      }),
    ).toBeNull();
  });

  it("skips sequence checks on non-Meta tables", () => {
    expect(
      validateSequencesStep({
        drafts: [full({ sequenceDirty: true, sequence: seq("abc") })],
        isMetaTable: false,
      }),
    ).toBeNull();
  });
});

describe("wizard step validation — step 1 member linking and naming", () => {
  it("allows linked members and flags duplicates only", () => {
    expect(
      validateMemberStep1({ key: "n", user_id: "u-1", display_name: "N" }, []),
    ).toBeNull();
    expect(
      validateMemberStep1({ key: "n", user_id: "u-1", display_name: "N" }, [
        { key: "a", user_id: "u-1" },
      ]),
    ).toMatch(/already on this table/i);
    expect(
      validateMemberStep1({ key: "a", user_id: "u-1", display_name: "A" }, [
        { key: "a", user_id: "u-1" },
      ]),
    ).toBeNull();
  });

  it("requires a display name for external contacts in step 1", () => {
    // Step 1 owns display names now that Step 2 no longer edits
    // them: linked members may inherit the roster name, external
    // contacts must be named here. Contact details still live in
    // Step 2, so they are never required here.
    expect(
      validateMemberStep1({ key: "n", user_id: null, display_name: "  " }, []),
    ).toMatch(/display name/i);
    expect(
      validateMemberStep1({ key: "n", user_id: null, display_name: "Walk-in" }, []),
    ).toBeNull();
  });
});

describe("wizard step validation — step 2 external identity", () => {
  const base = {
    notifyEnabled: false,
    templateName: "",
    templateStale: false,
    rosterEmailFor: () => "",
    checkSequences: false,
  };
  const ext = (over: Record<string, unknown> = {}) => ({
    display_name: "Walk-in",
    user_id: null,
    email: "",
    phone: "",
    whatsapp_numbers: [],
    notify_email: false,
    sequence: null,
    sequenceDirty: false,
    ...over,
  });

  it("requires a display name for external contacts (named in Step 1)", () => {
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext({ display_name: "  " })],
      }),
    ).toMatch(/Step 1/);
  });

  it("accepts named external contacts with channels off and no details", () => {
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext()],
      }),
    ).toBeNull();
  });

  it("still requires reachable details when a channel is on", () => {
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext({ notify_email: true })],
      }),
    ).toMatch(/no email address/i);
  });

  it("never auto-enables email from a roster address alone", () => {
    // OFF stays OFF: no email is required and nothing sends, even
    // when the roster could supply an address. Only an explicit
    // opt-in (notify_email true) activates the channel.
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext({ notify_email: false, email: "" })],
        rosterEmailFor: () => "roster@example.com",
      }),
    ).toBeNull();
  });

  it("preserves an explicitly saved email opt-in", () => {
    // A saved ON with a reachable recipient (typed or roster)
    // validates clean — reopening never resets it to OFF.
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext({ notify_email: true, email: "saved@example.com" })],
      }),
    ).toBeNull();
    expect(
      validateNotifyStep({
        ...base,
        drafts: [ext({ notify_email: true, email: "" })],
        rosterEmailFor: () => "roster@example.com",
      }),
    ).toBeNull();
  });
});

describe("review contact masking", () => {
  it("masks emails and phones, falling back to a dash", () => {
    expect(maskContactEmail("priya@example.com")).toBe("p***@example.com");
    expect(maskContactEmail("")).toBe("—");
    expect(maskContactEmail(undefined)).toBe("—");
    expect(maskContactPhone("+911234567890")).toBe("+91****7890");
    expect(maskContactPhone("")).toBe("—");
    expect(maskContactPhone(undefined)).toBe("—");
  });
});

describe("explicit empty assignment stays enabled (no legacy fallback)", () => {
  it("keeps the table engine in charge when the roster is emptied on purpose", () => {
    // An explicitly saved empty roster must not disable the table:
    // disabled/no-config would hand new leads to the legacy global
    // rule. Enabled + zero assignees yields no-eligible (unassigned).
    expect(
      resolveEnabledOnSave({
        isNew: false,
        persistedEnabled: true,
        hasActiveAssignee: false,
        weightInvalid: false,
        explicitEmpty: true,
      }),
    ).toBe(true);
    expect(
      resolveEnabledOnSave({
        isNew: true,
        persistedEnabled: false,
        hasActiveAssignee: false,
        weightInvalid: false,
        explicitEmpty: true,
      }),
    ).toBe(true);
  });

  it("preserves normal activation semantics otherwise", () => {
    expect(
      resolveEnabledOnSave({
        isNew: true,
        persistedEnabled: false,
        hasActiveAssignee: true,
        weightInvalid: false,
      }),
    ).toBe(true);
    expect(
      resolveEnabledOnSave({
        isNew: false,
        persistedEnabled: true,
        hasActiveAssignee: true,
        weightInvalid: false,
      }),
    ).toBe(true);
    expect(
      resolveEnabledOnSave({
        isNew: false,
        persistedEnabled: false,
        hasActiveAssignee: false,
        weightInvalid: false,
      }),
    ).toBe(false);
  });
});

describe("review shows full numbers for the authorized owner", () => {
  const baseDraft = {
    display_name: "Asha",
    weight: "100",
    is_active: true,
    notify_email: true,
    email: "asha@example.com",
    user_id: "u-1",
    notify_whatsapp: true,
    phone: "+919876543210",
    whatsapp_numbers: [
      { phone: "+919876543211", template_name: "hello", template_language: "en_US" },
    ],
    sequence: null,
    sequenceDirty: false,
  };
  it("renders complete primary and extra numbers without masking", () => {
    const html = renderToStaticMarkup(
      <AssignmentReviewSummary
        mode="percentage"
        drafts={[baseDraft]}
        activeWeightTotal={100}
        notifyEnabled
        templateName="hello_world"
        templateLanguage="en_US"
        enabled
        isNew={false}
      />,
    );
    expect(html).toContain("+919876543210");
    expect(html).toContain("+919876543211");
    expect(html).not.toContain("****");
    expect(html).toContain("asha@example.com");
  });
});
