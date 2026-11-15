import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SECTION_META,
  SETTINGS_SECTIONS,
  resolveSection,
} from "./settings-sections";

const root = process.cwd();
const settingsPageSrc = readFileSync(
  join(root, "src/app/(dashboard)/settings/page.tsx"),
  "utf8",
);

describe("Settings → Workspace → Call Recorder entry", () => {
  it("is a standalone section immediately after WhatsApp", () => {
    const whatsappIdx = SETTINGS_SECTIONS.indexOf("whatsapp");
    expect(whatsappIdx).toBeGreaterThan(-1);
    expect(SETTINGS_SECTIONS[whatsappIdx + 1]).toBe("call-recorder");
  });

  it("is a Workspace sibling of WhatsApp, not nested inside it", () => {
    expect(SECTION_META["call-recorder"].group).toBe("workspace");
    expect(SECTION_META["call-recorder"].label).toBe("Call Recorder");
    expect(SECTION_META["whatsapp"].group).toBe("workspace");
  });

  it("deep-links via ?tab=call-recorder", () => {
    expect(resolveSection("call-recorder")).toBe("call-recorder");
  });

  it("renders the dedicated panel from the settings page", () => {
    expect(settingsPageSrc).toContain("CallRecorderPanel");
    expect(settingsPageSrc).toContain("'call-recorder': <CallRecorderPanel />");
  });
});
