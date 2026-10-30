// Workspace Schedule Follow-up dialog — simplified default message.
//
// The Base UI dialog portal renders nothing in static markup, so the
// dialog's rendered DOM cannot be asserted in this environment.
// These tests lock the contract instead:
//   1. the prefilled "<name>, <phone>" default + merge rules (unit),
//   2. the dialog source structure (prefilled editable textarea,
//      no separate grey preview box, no old copy).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceFollowupMessage,
  mergeLinkedFollowupMessage,
} from "@/lib/followups/workspace-link";

const SRC = readFileSync(
  `${process.cwd()}/src/components/workspace/schedule-followup-dialog.tsx`,
  "utf8",
);

describe("new follow-up default message", () => {
  it("prefills the textarea with only '<Name>, <Phone>'", () => {
    expect(
      buildWorkspaceFollowupMessage({ name: "Arman Bhangu", phone: "9789454" }),
    ).toBe("Arman Bhangu, 9789454");
  });

  it("handles missing values without undefined, null, or stray commas", () => {
    expect(buildWorkspaceFollowupMessage({ name: "Mohan", phone: null })).toBe("Mohan");
    expect(buildWorkspaceFollowupMessage({ name: null, phone: "9876543210" })).toBe(
      "9876543210",
    );
    expect(buildWorkspaceFollowupMessage({ name: "  ", phone: "  " })).toBe("");
  });
});

describe("existing-reminder protection", () => {
  const def = "Arman Bhangu, 9789454";
  const saved = "Call Arman about the Dubai package.";

  it("editing an existing reminder loads its exact saved message", () => {
    expect(mergeLinkedFollowupMessage(def, def, saved)).toBe(saved);
  });

  it("rescheduling preserves saved text unless explicitly edited", () => {
    expect(mergeLinkedFollowupMessage("Edited text", def, saved)).toBe("Edited text");
    expect(mergeLinkedFollowupMessage("", def, saved)).toBe("");
  });

  it("historical message shapes are never rewritten by the merge", () => {
    const legacy =
      "Follow up with Arman Bhangu\nPhone: 9789454\n\nRemember to contact this lead at the scheduled time.";
    expect(mergeLinkedFollowupMessage(def, def, legacy)).toBe(legacy);
  });
});

describe("dialog structure (source contract)", () => {
  it("has no separate grey default-message preview box", () => {
    expect(SRC).not.toContain("Leave blank to use the default message below");
    expect(SRC).not.toContain("whitespace-pre-line");
    // Only one place renders the message text: the textarea itself.
    expect(SRC).not.toMatch(/\{preview\}/);
  });

  it("prefills an editable textarea with the computed default", () => {
    expect(SRC).toContain("setMessage(defaultMessage)");
    expect(SRC).toContain("value={message}");
    expect(SRC).toContain("onChange={(e) => setMessage(e.target.value)}");
  });

  it("layers the saved message over an untouched default without clobbering typing", () => {
    expect(SRC).toContain("mergeLinkedFollowupMessage(current, defaultMessage");
  });

  it("submits the actual textarea value, never a regenerated default", () => {
    expect(SRC).toContain("message: trimmedMessage === \"\" ? null : message");
  });
});

describe("per-reminder recipient field", () => {
  it("renders an editable recipient input below the lead card", () => {
    expect(SRC).toContain('Label htmlFor="fu-recipient">Send reminder to');
    expect(SRC).toContain('id="fu-recipient"');
    expect(SRC).toContain("value={recipient}");
    expect(SRC).toContain("maxLength={32}");
    // Prefilled from the saved recipient, else the Settings default —
    // never from the lead's own number.
    expect(SRC).toContain("setRecipient(savedRecipient)");
    expect(SRC).toContain("setRecipient(profileNumber)");
    expect(SRC).not.toContain("setRecipient(leadPhone");
    expect(SRC).not.toContain("normalizeAgentWhatsappNumber(leadPhone");
  });

  it("protects typed input from async prefills and cross-lead leaks", () => {
    expect(SRC).toContain("recipientDirtyRef.current = false");
    expect(SRC).toContain("if (recipientDirtyRef.current) return;");
  });

  it("validates inline and sends the normalized recipient with the request", () => {
    expect(SRC).toContain("normalizeAgentWhatsappNumber(recipient)");
    expect(SRC).toContain("Enter a valid WhatsApp number to receive this reminder.");
    expect(SRC).toContain("recipient_phone: normalizedRecipient");
  });
});
