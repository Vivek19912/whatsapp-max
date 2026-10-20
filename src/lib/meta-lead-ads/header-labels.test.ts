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

import {
  isRenamableMetaColumn,
  metaHeaderLabelKey,
  normalizeHeaderLabel,
  resolveMetaHeaderLabel,
  META_HEADER_LABEL_MAX,
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
