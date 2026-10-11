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
  it("shows identity, current phone number, and current WhatsApp choice", () => {
    const html = openHtml();
    expect(html).toContain("Vikas Sahni");
    expect(html).toContain("vikas@example.com");
    expect(html).toContain("+91 89530 65369");
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

  it("labels WhatsApp sources with a safe fallback", () => {
    expect(whatsappSourceLabel("whatsapp")).toBe("WhatsApp");
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

  it("role editing and member removal are untouched", () => {
    expect(viewSrc).toContain("handleRoleChange");
    expect(viewSrc).toContain("handleRemove");
    expect(viewSrc).toContain("setRemovingMember(member)");
  });
});
