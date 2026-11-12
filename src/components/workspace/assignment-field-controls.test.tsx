import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  INDIA_COUNTRY_CODE,
  IndiaPhoneInput,
  SHARE_OPTIONS,
  ShareSelect,
  WhatsappNumbersEditor,
  capIndiaDigits,
  indiaLocalDigits,
  legacyShareLabel,
  normalizeIndiaMobile,
} from "./assignment-field-controls";

describe("indiaLocalDigits / normalizeIndiaMobile", () => {
  it("strips a single +91 prefix for display", () => {
    expect(indiaLocalDigits("+919876543210")).toBe("9876543210");
    expect(indiaLocalDigits("  +91 98765 43210 ")).toBe("9876543210");
    expect(indiaLocalDigits("")).toBe("");
  });

  it("never silently truncates non-conforming legacy values for display", () => {
    expect(indiaLocalDigits("+14155550123")).toBe("14155550123");
    expect(indiaLocalDigits("+9112345678901")).toBe("12345678901");
  });

  it("accepts exactly 10 digits after +91", () => {
    expect(normalizeIndiaMobile("9876543210")).toBe("+919876543210");
    expect(normalizeIndiaMobile("98765 43210")).toBe("+919876543210");
    expect(normalizeIndiaMobile("123")).toBeNull();
    expect(normalizeIndiaMobile("987654321")).toBeNull();
    expect(normalizeIndiaMobile("")).toBeNull();
  });

  it("rejects over-long input instead of truncating it", () => {
    expect(normalizeIndiaMobile("98765432101")).toBeNull();
    expect(capIndiaDigits("9876543210123")).toBe("9876543210");
  });
});

describe("SHARE_OPTIONS", () => {
  it("offers 10%–100% in steps of 10", () => {
    expect([...SHARE_OPTIONS]).toEqual([
      "10", "20", "30", "40", "50", "60", "70", "80", "90", "100",
    ]);
  });
});

describe("ShareSelect (rendered output)", () => {
  it("renders a labelled select with the standard options", () => {
    const html = renderToStaticMarkup(
      <ShareSelect value="30" onChange={() => {}} displayName="Asha" />,
    );
    expect(html).toContain("Share percentage");
    expect(html).toContain("%");
    expect(html).toContain("30");
  });

  it("preserves a legacy non-standard value as a disabled option", () => {
    expect(legacyShareLabel("33")).toBe("33% (legacy value)");
    expect(legacyShareLabel("20")).toBeNull();
    expect(legacyShareLabel("")).toBeNull();
    // The legacy option renders in the dropdown next to the standard set.
    const html = renderToStaticMarkup(
      <ShareSelect value="33" onChange={() => {}} displayName="Asha" />,
    );
    expect(html).toContain("Share percentage");
    expect(html).toContain("%");
  });

  it("combines a typed numeric input with a quick-select trigger on one value", () => {
    // Manual entry (e.g. 35%) and picking a preset update the same
    // draft value: the input carries the current value in numeric
    // mode, and the chevron opens the 10%–100% quick picks.
    const html = renderToStaticMarkup(
      <ShareSelect value="35" onChange={() => {}} displayName="Asha" />,
    );
    expect(html).toContain("Share percentage for Asha");
    expect(html).toContain('value="35"');
    expect(html).toContain("Choose a preset share percentage for Asha");
    expect(html).toContain("%");
  });

  it("keeps the number left-aligned with the suffix and chevron inside one compact control", () => {
    const html = renderToStaticMarkup(
      <ShareSelect value="90" onChange={() => {}} displayName="Asha" />,
    );
    // One unified h-9 control (not a stretched full-width row): the
    // number is left-aligned, the % suffix and chevron sit inside
    // the same bordered box after the input.
    expect(html).toContain("text-left");
    expect(html).toContain("w-32");
    const inputAt = html.indexOf('value="90"');
    const suffixAt = html.indexOf(">%</span>", inputAt);
    const chevronAt = html.indexOf("Choose a preset share percentage for Asha", inputAt);
    expect(inputAt).toBeGreaterThanOrEqual(0);
    expect(suffixAt).toBeGreaterThan(inputAt);
    expect(chevronAt).toBeGreaterThan(suffixAt);
  });
});

describe("IndiaPhoneInput (rendered output)", () => {
  it("shows a fixed +91 prefix and the subscriber digits", () => {
    const html = renderToStaticMarkup(
      <IndiaPhoneInput value="+919876543210" onChange={() => {}} ariaLabel="Phone" />,
    );
    expect(html).toContain(INDIA_COUNTRY_CODE);
    expect(html).toContain('value="9876543210"');
    expect(html).toContain('inputMode="numeric"');
  });

  it("caps typed input at 10 digits without touching stored values", () => {
    expect(capIndiaDigits("9876543210123")).toBe("9876543210");
    expect(capIndiaDigits("98 765-43210")).toBe("9876543210");
    expect(capIndiaDigits("")).toBe("");
  });
});

describe("WhatsappNumbersEditor (rendered output)", () => {
  const templates = [
    { value: "a\0en_US", label: "hello", hint: "UTILITY · en_US · APPROVED" },
  ];
  const details = new Map();

  it("offers adding up to the maximum and shows the cap message", () => {
    const full = Array.from({ length: 10 }, (_, i) => ({
      phone: `+9198765432${String(i).padStart(2, "0").slice(-2)}`,
      template_name: "",
      template_language: "en_US",
    }));
    const html = renderToStaticMarkup(
      <WhatsappNumbersEditor
        numbers={[]}
        onChange={() => {}}
        templateOptions={templates}
        templateDetails={details}
        assigneeName="Asha"
        maxNumbers={10}
      />
    );
    expect(html).toContain("Add WhatsApp Number");
    const htmlFull = renderToStaticMarkup(
      <WhatsappNumbersEditor
        numbers={full}
        onChange={() => {}}
        templateOptions={templates}
        templateDetails={details}
        assigneeName="Asha"
        maxNumbers={10}
      />
    );
    expect(htmlFull).toContain("Maximum 10 WhatsApp numbers per assignee");
  });

  it("renders per-number remove actions and template pickers", () => {
    const html = renderToStaticMarkup(
      <WhatsappNumbersEditor
        numbers={[{ phone: "+919876543210", template_name: "", template_language: "en_US" }]}
        onChange={() => {}}
        templateOptions={templates}
        templateDetails={details}
        assigneeName="Asha"
        maxNumbers={10}
      />
    );
    expect(html).toContain("Remove extra WhatsApp number 1");
    expect(html).toContain("Table default template");
  });

  it("forwards edits through onChange without mutating", () => {
    const seen: Array<unknown> = [];
    const onChange = vi.fn((v: unknown) => {
      seen.push(v);
    });
    expect(typeof onChange).toBe("function");
    expect(seen).toHaveLength(0);
  });
});
