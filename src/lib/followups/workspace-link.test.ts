// Workspace follow-up → reminder link (pure helpers).
//
// Pins the association contract:
//   * exactly one linkage discriminator, shared by API + UI;
//   * the canonical follow-up column matches case-insensitively;
//   * default messages never leak undefined/null/template text;
//   * invalid instants never render "Invalid Date".

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_FOLLOWUP_FIELD_NAME,
  WORKSPACE_FOLLOWUP_SOURCE_KIND,
  buildWorkspaceFollowupMessage,
  formatWorkspaceFollowupDateTime,
  isWorkspaceFollowupFieldName,
} from "./workspace-link";

describe("workspace follow-up link identity", () => {
  it("exposes a single stable discriminator and field name", () => {
    expect(WORKSPACE_FOLLOWUP_SOURCE_KIND).toBe("meta_workspace_followup");
    expect(WORKSPACE_FOLLOWUP_FIELD_NAME).toBe("next follow-up date & time");
  });

  it("matches the canonical follow-up column case-insensitively", () => {
    expect(isWorkspaceFollowupFieldName("Next Follow-up Date & Time")).toBe(true);
    expect(
      isWorkspaceFollowupFieldName("  next FOLLOW-UP date & time  "),
    ).toBe(true);
    expect(isWorkspaceFollowupFieldName("Lead Source")).toBe(false);
    expect(isWorkspaceFollowupFieldName("")).toBe(false);
    expect(isWorkspaceFollowupFieldName(null)).toBe(false);
    expect(isWorkspaceFollowupFieldName(undefined)).toBe(false);
  });
});

describe("buildWorkspaceFollowupMessage", () => {
  it("generates the default message with lead name and phone", () => {
    expect(
      buildWorkspaceFollowupMessage({
        name: "Rahul Sharma",
        phone: "+919999999999",
      }),
    ).toBe(
      "Follow up with Rahul Sharma\nPhone: +919999999999\n\nRemember to contact this lead at the scheduled time.",
    );
  });

  it("handles a missing name gracefully", () => {
    const message = buildWorkspaceFollowupMessage({
      name: "   ",
      phone: "+91111",
    });
    expect(message).toContain("Follow up with this lead");
    expect(message).toContain("Phone: +91111");
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });

  it("omits the Phone line when the phone is missing", () => {
    const message = buildWorkspaceFollowupMessage({ name: "Asha", phone: null });
    expect(message).toBe(
      "Follow up with Asha\n\nRemember to contact this lead at the scheduled time.",
    );
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });

  it("handles both missing without leaking template variables", () => {
    const message = buildWorkspaceFollowupMessage({});
    expect(message).toBe(
      "Follow up with this lead\n\nRemember to contact this lead at the scheduled time.",
    );
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });
});

describe("formatWorkspaceFollowupDateTime", () => {
  it("renders a readable local instant", () => {
    const text = formatWorkspaceFollowupDateTime("2026-10-22T10:30:00.000Z");
    expect(text).not.toBe("—");
    expect(text).not.toMatch(/Invalid/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("falls back to an em dash for missing or invalid input", () => {
    expect(formatWorkspaceFollowupDateTime(null)).toBe("—");
    expect(formatWorkspaceFollowupDateTime(undefined)).toBe("—");
    expect(formatWorkspaceFollowupDateTime("")).toBe("—");
    expect(formatWorkspaceFollowupDateTime("not-a-date")).toBe("—");
  });
});
