import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RecordingConfigDialog,
  RecordingConfigForm,
  WHATSAPP_OPTIONS,
  displayRecordingNumber,
  isRecordingPhoneNumber,
  normalizeRecordingPhoneNumber,
  recordingMobileDigitsFromStored,
  resolveRecordingSaveNumber,
  sanitizeRecordingMobileInput,
  whatsappSourceLabel,
  type RecordingConfigMember,
} from "./recording-config-dialog";

// ---------------------------------------------------------------------------
// RecordingConfigDialog — SSR covers open-dialog markup (Base UI
// Dialog content renders deterministically for these assertions);
// pure helpers cover number validation; source patterns cover row
// wiring that needs interaction, which Base UI continues to own.
// ---------------------------------------------------------------------------

const root = process.cwd();
const viewSrc = readFileSync(
  `${root}/src/components/team-members/team-members-view.tsx`,
  "utf8",
);

function member(partial?: Record<string, unknown>): RecordingConfigMember {
  return {
    user_id: "u-1",
    full_name: "Vikas Sahni",
    email: "vikas@example.com",
    avatar_url: null,
    phone_recording_number: "918953065369",
    whatsapp_recording_source: "whatsapp_business",
    ...partial,
  };
}

function openHtml(m?: Record<string, unknown>) {
  return renderToStaticMarkup(
    <RecordingConfigForm member={member(m)} onClose={() => {}} onSaved={() => {}} />,
  );
}

describe("RecordingConfigDialog", () => {
  it("shows identity, fixed +91 prefix, subscriber digits, and current WhatsApp choice", () => {
    const html = openHtml();
    expect(html).toContain("Vikas Sahni");
    expect(html).toContain("vikas@example.com");
    // +91 is a fixed, non-editable adornment; only the 10 subscriber
    // digits live in the input value.
    expect(html).toContain("+91");
    expect(html).toContain('value="8953065369"');
    expect(html).not.toContain('value="+91');
    expect(html).toContain("WhatsApp Business");
  });

  it("renders no SIM slot dropdown and no subscription identifiers", () => {
    const html = openHtml();
    expect(html).not.toMatch(/SIM 1|SIM 2/);
    expect(html).not.toMatch(/subscription/i);
    expect(html).not.toMatch(/slot index/i);
    expect(html).not.toMatch(/phone_account/i);
  });

  it("has exactly the three WhatsApp options with one selected", () => {
    expect(WHATSAPP_OPTIONS.map((o) => o.value)).toEqual([
      'none',
      'whatsapp',
      'whatsapp_business',
    ]);
    const html = openHtml();
    for (const label of ["None", "WhatsApp", "WhatsApp Business"]) {
      expect(html).toContain(label);
    }
    const checked = html.match(/aria-checked="true"/g) ?? [];
    expect(checked).toHaveLength(1);
  });

  it("has phone enable/disable radios, input, Cancel and Save Changes", () => {
    const html = openHtml();
    expect(html).toContain("Phone number");
    expect(html).toContain("Enabled");
    expect(html).toContain("Disabled");
    expect(html).toContain("Cancel");
    expect(html).toContain("Save Changes");
  });

  it("renders nothing editable when closed", () => {
    const html = renderToStaticMarkup(
      <RecordingConfigDialog member={null} onClose={() => {}} onSaved={() => {}} />,
    );
    expect(html).not.toContain("Phone number");
    expect(html).not.toContain("Save Changes");
  });

  it("carries the dialog title and subtitle in source", () => {
    const src = readFileSync(
      `${root}/src/components/team-members/recording-config-dialog.tsx`,
      "utf8",
    );
    expect(src).toContain("Recording Configuration");
    expect(src).toContain("allowed to record");
  });

  it("shows None state for an unconfigured member", () => {
    const html = openHtml({
      phone_recording_number: null,
      whatsapp_recording_source: "none",
    });
    expect(html).toContain("No phone calls will be recorded.");
  });

  it("keeps the phone input disabled with an empty value when recording is off", () => {
    const html = openHtml({ phone_recording_number: null });
    expect(html).toContain("disabled");
    expect(html).toContain("+91");
    expect(html).toContain('value=""');
  });

  it("prefills plain 10-digit stored values without adding a prefix", () => {
    const html = openHtml({ phone_recording_number: "8953065369" });
    expect(html).toContain('value="8953065369"');
  });
});

describe("recording dialog helpers", () => {
  it("validates numbers exactly like the server rule", () => {
    expect(normalizeRecordingPhoneNumber("+91 89530 65369")).toBe("918953065369");
    expect(normalizeRecordingPhoneNumber("+1 (202) 555-0173")).toBe("12025550173");
    expect(normalizeRecordingPhoneNumber(null)).toBeNull();
    expect(normalizeRecordingPhoneNumber("abc")).toBeNull();
    expect(normalizeRecordingPhoneNumber("123")).toBeNull();
    expect(isRecordingPhoneNumber(null)).toBe(true);
    expect(isRecordingPhoneNumber("")).toBe(true);
    expect(isRecordingPhoneNumber("+91 89530 65369")).toBe(true);
    expect(isRecordingPhoneNumber("xyz")).toBe(false);
  });

  it("derives the editable digits from stored values without corruption", () => {
    // Standard stored form: 91 + 10 digits (with or without formatting).
    expect(recordingMobileDigitsFromStored("918953065369")).toBe("8953065369");
    expect(recordingMobileDigitsFromStored("+91 89530 65369")).toBe("8953065369");
    expect(recordingMobileDigitsFromStored("+918953065369")).toBe("8953065369");
    // Bare 10-digit values pass through untouched.
    expect(recordingMobileDigitsFromStored("8953065369")).toBe("8953065369");
    // Empty/missing stays empty.
    expect(recordingMobileDigitsFromStored(null)).toBe("");
    expect(recordingMobileDigitsFromStored("")).toBe("");
    // Non-conforming legacy values are never mangled into the field.
    expect(recordingMobileDigitsFromStored("abc")).toBe("");
    expect(recordingMobileDigitsFromStored("123")).toBe("");
    expect(recordingMobileDigitsFromStored("12025550173")).toBe("");
  });

  it("sanitizes typed and pasted input to 10 digits, never doubling +91", () => {
    // Normal entry.
    expect(sanitizeRecordingMobileInput("8604012345")).toBe("8604012345");
    // Pasted full Indian numbers collapse to subscriber digits.
    expect(sanitizeRecordingMobileInput("+918604012345")).toBe("8604012345");
    expect(sanitizeRecordingMobileInput("918604012345")).toBe("8604012345");
    expect(sanitizeRecordingMobileInput("+91 86040 12345")).toBe("8604012345");
    // Typing +91 manually can never stick: "+" is stripped, and a
    // completed 91+10-digit entry reduces to its 10 digits.
    expect(sanitizeRecordingMobileInput("+91")).toBe("91");
    // Letters/symbols are dropped; over-length input is capped.
    expect(sanitizeRecordingMobileInput("86a040-12345")).toBe("8604012345");
    expect(sanitizeRecordingMobileInput("86040123456789")).toBe("8604012345");
    expect(sanitizeRecordingMobileInput("")).toBe("");
    // A genuine 10-digit number is never stripped, even when it
    // starts with 91.
    expect(sanitizeRecordingMobileInput("9198765432")).toBe("9198765432");
  });

  it("resolves save payloads without ever doubling the country code", () => {
    expect(resolveRecordingSaveNumber(true, "8604012345")).toEqual({
      number: "918604012345",
    });
    // Incomplete, empty, over-long, and already-prefixed entries are
    // rejected instead of being saved with a doubled prefix.
    for (const bad of ["86040123", "", "86040123456", "918604012345", "abcdefghij"]) {
      const resolved = resolveRecordingSaveNumber(true, bad);
      expect(resolved).toEqual({ error: "Enter a valid 10-digit mobile number." });
    }
    // Disabled recording always clears the number.
    expect(resolveRecordingSaveNumber(false, "8604012345")).toEqual({ number: null });
    expect(resolveRecordingSaveNumber(false, "")).toEqual({ number: null });
  });

  it("labels WhatsApp sources with a safe fallback", () => {    expect(whatsappSourceLabel("whatsapp")).toBe("WhatsApp");
    expect(whatsappSourceLabel("whatsapp_business")).toBe("WhatsApp Business");
    expect(whatsappSourceLabel("none")).toBe("None");
    expect(whatsappSourceLabel("bogus")).toBe("None");
    expect(whatsappSourceLabel(null)).toBe("None");
  });

  it("displays stored digits without inventing slot labels", () => {
    expect(displayRecordingNumber("918953065369")).toBe("+91 89530 65369");
    expect(displayRecordingNumber("12025550173")).toBe("+12025550173");
    expect(displayRecordingNumber(null)).toBe("None");
  });
});

describe("team-members-view recording wiring", () => {
  it("row has no inline phone editor, Save, or WhatsApp dropdown", () => {
    expect(viewSrc).not.toContain("PhoneNumberCell");
    expect(viewSrc).not.toContain("handleSourceChange");
    expect(viewSrc).not.toContain("setDraft(");
    expect(viewSrc).toContain("RecordingConfigDialog");
  });

  it("Configure opens the dialog; non-owners get summary only", () => {
    expect(viewSrc).toContain("setConfigMember(member)");
    expect(viewSrc).toContain("member={configMember}");
    // Configure affordance is owner-gated; the summary block is unconditional.
    expect(viewSrc).toMatch(/\{isOwner \? \(\s*<Button/);
    expect(viewSrc).toContain("Phone:{' '}");
    expect(viewSrc).toContain("WhatsApp:{' '}");
  });

  it("role is display-only; member removal is untouched", () => {
    expect(viewSrc).not.toContain("handleRoleChange");
    expect(viewSrc).not.toContain("EDITABLE_ROLES");
    expect(viewSrc).not.toContain("<Select");
    expect(viewSrc).not.toContain("SelectTrigger");
    expect(viewSrc).toContain("ROLE_META[member.role]");
    expect(viewSrc).toContain("roleMeta.label");
    expect(viewSrc).toContain("handleRemove");
    expect(viewSrc).toContain("setRemovingMember(member)");
  });
});
