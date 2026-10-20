// Meta Lead Ads — custom header names (pure model).
//
// Pins the Meta-only scoping contract:
//   * only Instant Form question columns are renamable (never system
//     columns, never the fixed Source column);
//   * overrides key by the stable column identity, never the label;
//   * overrides apply on Meta Lead Ads tables only — every other
//     flow kind always renders the original label;
//   * empty/blank/overlong names are rejected, never stored.

import { describe, expect, it } from "vitest";

import { flowColumnVisId } from "@/lib/flows/workspace-visibility";

import {
  META_HEADER_LABEL_MAX,
  isRenamableMetaColumn,
  metaDefaultHiddenColumnIds,
  metaHeaderLabelKey,
  normalizeHeaderLabel,
  resolveMetaHeaderDisplayLabel,
  resolveMetaHeaderLabel,
} from "./header-labels";

describe("isRenamableMetaColumn", () => {
  it("allows dynamically generated question columns", () => {
    expect(isRenamableMetaColumn({ key: "experience", system: false })).toBe(true);
  });

  it("rejects system columns", () => {
    expect(isRenamableMetaColumn({ key: "name", system: true })).toBe(false);
    expect(isRenamableMetaColumn({ key: "submission_time", system: true })).toBe(false);
  });

  it("rejects the fixed Source column", () => {
    expect(
      isRenamableMetaColumn({ key: "meta_lead_source", system: false }),
    ).toBe(false);
  });
});

describe("metaHeaderLabelKey", () => {
  it("uses the shared visibility-id identity (never the label)", () => {
    expect(metaHeaderLabelKey("experience")).toBe("flow:experience");
    // Parity with the workspace visibility system (kept in sync by
    // hand: header-labels must stay server-safe, so it cannot import
    // the React module where flowColumnVisId lives).
    expect(metaHeaderLabelKey("phone_number")).toBe(flowColumnVisId("phone_number"));
  });
});

describe("normalizeHeaderLabel", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeHeaderLabel("  Experience  ")).toBe("Experience");
  });

  it("rejects empty and whitespace-only names", () => {
    for (const bad of ["", "   ", "\n\t "]) {
      expect(() => normalizeHeaderLabel(bad)).toThrow(/empty/i);
    }
  });

  it("rejects non-text input", () => {
    expect(() => normalizeHeaderLabel(null)).toThrow(/text/i);
    expect(() => normalizeHeaderLabel(42)).toThrow(/text/i);
  });

  it("rejects overlong names", () => {
    expect(() => normalizeHeaderLabel("x".repeat(META_HEADER_LABEL_MAX + 1))).toThrow(
      /120/,
    );
  });
});

describe("resolveMetaHeaderLabel", () => {
  it("applies the stored override verbatim on Meta Lead Ads tables", () => {
    expect(
      resolveMetaHeaderLabel({
        flowKind: "meta_lead_ads",
        column: { key: "experience", system: false, label: "How much experience?" },
        labels: { "flow:experience": "Experience" },
      }),
    ).toBe("Experience");
  });

  it("falls back to the original question when no override exists", () => {
    expect(
      resolveMetaHeaderLabel({
        flowKind: "meta_lead_ads",
        column: { key: "experience", system: false, label: "How much experience?" },
        labels: {},
      }),
    ).toBe("How much experience?");
  });

  it("ignores overrides on system columns", () => {
    expect(
      resolveMetaHeaderLabel({
        flowKind: "meta_lead_ads",
        column: { key: "name", system: true, label: "Name" },
        labels: { "flow:name": "Custom" },
      }),
    ).toBe("Name");
  });

  it("leaves sibling columns untouched when one is renamed", () => {
    const labels = { "flow:experience": "Experience" };
    expect(
      resolveMetaHeaderLabel({
        flowKind: "meta_lead_ads",
        column: { key: "experience", system: false, label: "How much experience?" },
        labels,
      }),
    ).toBe("Experience");
    expect(
      resolveMetaHeaderLabel({
        flowKind: "meta_lead_ads",
        column: { key: "budget", system: false, label: "What is your budget?" },
        labels,
      }),
    ).toBe("What is your budget?");
  });

  it("ignores every override on Flow Tables (other kinds untouched)", () => {
    for (const kind of ["whatsapp_flow", null, undefined]) {
      expect(
        resolveMetaHeaderLabel({
          flowKind: kind,
          column: { key: "experience", system: false, label: "How much experience?" },
          labels: { "flow:experience": "Experience" },
        }),
      ).toBe("How much experience?");
    }
  });
});

describe("resolveMetaHeaderDisplayLabel", () => {
  // Stand-in for the workspace display formatting: proves which
  // path the resolver took without importing UI modules here.
  const formatOriginal = (label: string) => `formatted:${label}`;

  it("shows the custom header verbatim in the details sidebar", () => {
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: {
          key: "software",
          system: false,
          label: "Which software do you use for video editing?",
        },
        labels: { "flow:software": "Software" },
        formatOriginal,
      }),
    ).toBe("Software");
  });

  it("never formats a custom header (verbatim, like the table header)", () => {
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: { key: "city", system: false, label: "City" },
        labels: { "flow:city": "city lowercase" },
        formatOriginal,
      }),
    ).toBe("city lowercase");
  });

  it("shows the original question when no override exists", () => {
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: {
          key: "software",
          system: false,
          label: "Which software do you use for video editing?",
        },
        labels: {},
        formatOriginal,
      }),
    ).toBe("formatted:Which software do you use for video editing?");
  });

  it("restoring the header restores the formatted original label", () => {
    const column = {
      key: "software",
      system: false,
      label: "Which software do you use for video editing?",
    };
    // Before restore: custom wins.
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column,
        labels: { "flow:software": "Software" },
        formatOriginal,
      }),
    ).toBe("Software");
    // After restore the override row is gone (null/{}): original again.
    for (const labels of [{}, null, undefined]) {
      expect(
        resolveMetaHeaderDisplayLabel({
          flowKind: "meta_lead_ads",
          column,
          labels,
          formatOriginal,
        }),
      ).toBe("formatted:Which software do you use for video editing?");
    }
  });

  it("resolves by stable key, so siblings and same-text columns are untouched", () => {
    const labels = { "flow:software": "Software" };
    // Same visible text, different stable key: no override applies.
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: {
          key: "software_2",
          system: false,
          label: "Which software do you use for video editing?",
        },
        labels,
        formatOriginal,
      }),
    ).toBe("formatted:Which software do you use for video editing?");
    // Sibling question: untouched.
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: { key: "budget", system: false, label: "What is your budget?" },
        labels,
        formatOriginal,
      }),
    ).toBe("formatted:What is your budget?");
  });

  it("ignores overrides on system and Source columns", () => {
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: { key: "name", system: true, label: "Name" },
        labels: { "flow:name": "Custom" },
        formatOriginal,
      }),
    ).toBe("formatted:Name");
    expect(
      resolveMetaHeaderDisplayLabel({
        flowKind: "meta_lead_ads",
        column: { key: "meta_lead_source", system: false, label: "Source" },
        labels: { "flow:meta_lead_source": "Custom" },
        formatOriginal,
      }),
    ).toBe("formatted:Source");
  });

  it("leaves Flow Tables on the formatting path even with overrides stored", () => {
    for (const flowKind of ["whatsapp_flow", null, undefined]) {
      expect(
        resolveMetaHeaderDisplayLabel({
          flowKind,
          column: { key: "software", system: false, label: "experience?" },
          labels: { "flow:software": "Software" },
          formatOriginal,
        }),
      ).toBe("formatted:experience?");
    }
  });

  it("falls back safely on blank overrides or a missing map", () => {
    const column = { key: "software", system: false, label: "Original?" };
    for (const labels of [
      { "flow:software": "" },
      { "flow:software": "   " },
      null,
      undefined,
    ]) {
      expect(
        resolveMetaHeaderDisplayLabel({
          flowKind: "meta_lead_ads",
          column,
          labels,
          formatOriginal,
        }),
      ).toBe("formatted:Original?");
    }
  });
});

describe("metaDefaultHiddenColumnIds", () => {
  const COLUMNS = [
    { key: "submission_time", system: true },
    { key: "name", system: true },
    { key: "phone", system: true },
    { key: "full_name", system: false },
    { key: "phone_number", system: false },
    { key: "mobile", system: false },
    { key: "service", system: false },
  ];

  it("hides only dynamic identity columns on Meta tables", () => {
    expect(metaDefaultHiddenColumnIds(COLUMNS, true).sort()).toEqual([
      "flow:full_name",
      "flow:mobile",
      "flow:phone_number",
    ]);
  });

  it("returns nothing for Flow Tables, even with identity keys present", () => {
    expect(metaDefaultHiddenColumnIds(COLUMNS, false)).toEqual([]);
  });

  it("leaves non-identity dynamic columns visible", () => {
    const ids = metaDefaultHiddenColumnIds(
      [{ key: "service", system: false }],
      true,
    );
    expect(ids).toEqual([]);
  });
});
