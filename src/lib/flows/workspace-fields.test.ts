import { describe, expect, it } from "vitest";
import {
  displayWorkspaceValue,
  isWorkspaceFieldType,
  parseMultiSelectValue,
  resolveWorkspaceCurrency,
  validateWorkspaceFieldDef,
  validateWorkspaceValue,
} from "./workspace-fields";
import { STAGE_OPTIONS } from "./workspace-defaults";
import { getSelectChip } from "./workspace-select-chips";

describe("workspace field definitions", () => {
  it("accepts all nine phase-1 types", () => {
    for (const t of [
      "text",
      "number",
      "currency",
      "date",
      "datetime",
      "single_select",
      "multi_select",
      "checkbox",
      "url",
    ] as const) {
      expect(isWorkspaceFieldType(t)).toBe(true);
      const def = validateWorkspaceFieldDef({
        name: `Col ${t}`,
        field_type: t,
        options: t.endsWith("select") ? ["A", "B"] : undefined,
      });
      expect(def.field_type).toBe(t);
    }
    expect(isWorkspaceFieldType("formula")).toBe(false);
  });

  it("rejects empty and overlong names", () => {
    for (const bad of ["", "   ", null, undefined]) {
      expect(() =>
        validateWorkspaceFieldDef({ name: bad, field_type: "text" }),
      ).toThrow(/required/i);
    }
    expect(() =>
      validateWorkspaceFieldDef({ name: "x".repeat(81), field_type: "text" }),
    ).toThrow(/80/);
  });

  it("trims names but preserves display capitalization", () => {
    const def = validateWorkspaceFieldDef({
      name: "  Follow-up Date  ",
      field_type: "date",
    });
    expect(def.name).toBe("Follow-up Date");
  });

  it("requires options for selects and validates them", () => {
    expect(() =>
      validateWorkspaceFieldDef({ name: "S", field_type: "single_select" }),
    ).toThrow(/at least one option/i);
    expect(() =>
      validateWorkspaceFieldDef({
        name: "S",
        field_type: "single_select",
        options: ["New", "new"],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateWorkspaceFieldDef({
        name: "S",
        field_type: "single_select",
        options: [""],
      }),
    ).toThrow();
    expect(() =>
      validateWorkspaceFieldDef({
        name: "T",
        field_type: "text",
        options: ["A"],
      }),
    ).toThrow(/only select/i);
  });

  it("stores defaults without applying them", () => {
    const def = validateWorkspaceFieldDef({
      name: "S",
      field_type: "single_select",
      options: ["New", "Contacted"],
      default_value: "New",
    });
    expect(def.default_value).toBe("New");
    // Default outside options is rejected, not coerced.
    expect(() =>
      validateWorkspaceFieldDef({
        name: "S",
        field_type: "single_select",
        options: ["New"],
        default_value: "Lost",
      }),
    ).toThrow(/one of the options/i);
  });

  it("falls back to null default when unset", () => {
    const def = validateWorkspaceFieldDef({ name: "T", field_type: "text" });
    expect(def.default_value).toBeNull();
    expect(def.options).toBeNull();
  });

  it("defaults currency columns to INR", () => {
    expect(
      validateWorkspaceFieldDef({ name: "Price", field_type: "currency" })
        .currency_code,
    ).toBe("INR");
    expect(
      validateWorkspaceFieldDef({
        name: "Price",
        field_type: "currency",
        currency_code: "",
      }).currency_code,
    ).toBe("INR");
    expect(
      validateWorkspaceFieldDef({
        name: "Price",
        field_type: "currency",
        currency_code: null,
      }).currency_code,
    ).toBe("INR");
  });

  it("accepts an explicit supported currency per column", () => {
    for (const code of ["INR", "USD", "EUR", "AED"]) {
      const def = validateWorkspaceFieldDef({
        name: "Price",
        field_type: "currency",
        currency_code: code,
      });
      expect(def.currency_code).toBe(code);
    }
    // Case-insensitive, whitespace-tolerant.
    expect(
      validateWorkspaceFieldDef({
        name: "Price",
        field_type: "currency",
        currency_code: "  aed ",
      }).currency_code,
    ).toBe("AED");
  });

  it("rejects unsupported currencies and non-currency usage", () => {
    expect(() =>
      validateWorkspaceFieldDef({
        name: "Price",
        field_type: "currency",
        currency_code: "USDX",
      }),
    ).toThrow(/currency/i);
    expect(() =>
      validateWorkspaceFieldDef({
        name: "Notes",
        field_type: "text",
        currency_code: "USD",
      }),
    ).toThrow(/only currency/i);
  });

  it("resolves legacy currency columns (no code) to INR", () => {
    expect(resolveWorkspaceCurrency({ currency_code: null })).toBe("INR");
    expect(resolveWorkspaceCurrency({ currency_code: "AED" })).toBe("AED");
  });

  it("keeps currency values numeric regardless of currency", () => {
    expect(validateWorkspaceValue("currency", null, "234234")).toBe("234234");
    const def = validateWorkspaceFieldDef({
      name: "Dubai Price",
      field_type: "currency",
      currency_code: "AED",
      default_value: "234234",
    });
    expect(def.default_value).toBe("234234");
    expect(def.currency_code).toBe("AED");
  });
});

describe("workspace cell values", () => {
  it("accepts plain text and rejects overlong input", () => {
    expect(validateWorkspaceValue("text", null, "Hot lead")).toBe("Hot lead");
    expect(validateWorkspaceValue("text", null, "  ")).toBeNull();
    expect(() => validateWorkspaceValue("text", null, "x".repeat(2001))).toThrow();
  });

  it("validates numbers and currency", () => {
    expect(validateWorkspaceValue("number", null, "42")).toBe("42");
    expect(validateWorkspaceValue("currency", null, "80000.5")).toBe("80000.5");
    expect(() => validateWorkspaceValue("number", null, "abc")).toThrow(/number/i);
    expect(validateWorkspaceValue("currency", null, "")).toBeNull();
  });

  it("validates dates and datetimes", () => {
    expect(validateWorkspaceValue("date", null, "2026-09-25")).toBe("2026-09-25");
    expect(() => validateWorkspaceValue("date", null, "2026-13-40")).toThrow(/date/i);
    expect(() => validateWorkspaceValue("date", null, "tomorrow")).toThrow();
    const dt = validateWorkspaceValue("datetime", null, "2026-09-25T10:30");
    expect(dt).toMatch(/2026-09-25/);
    expect(() => validateWorkspaceValue("datetime", null, "not a date")).toThrow();
  });

  it("restricts selects to configured options", () => {
    const opts = ["New", "Contacted"];
    expect(validateWorkspaceValue("single_select", opts, "New")).toBe("New");
    expect(() =>
      validateWorkspaceValue("single_select", opts, "Lost"),
    ).toThrow(/options/i);
    expect(validateWorkspaceValue("multi_select", opts, ["New", "Contacted"])).toBe(
      JSON.stringify(["New", "Contacted"]),
    );
    expect(() =>
      validateWorkspaceValue("multi_select", opts, ["New", "Lost"]),
    ).toThrow(/options/i);
  });

  it("accepts the Not connected stage and round-trips it verbatim", () => {
    const opts = [...STAGE_OPTIONS];
    expect(opts).toContain("Not connected");
    // Save path: exact-match validation passes for the new option.
    expect(validateWorkspaceValue("single_select", opts, "Not connected")).toBe("Not connected");
    // Refresh path: the stored value still matches the column options.
    expect(opts.some((o) => o === "Not connected")).toBe(true);
    // Badge path: a chip resolves (never null) with a distinct color.
    const chip = getSelectChip("Stage", "Not connected");
    expect(chip).not.toBeNull();
  });

  it("normalizes checkbox values", () => {
    expect(validateWorkspaceValue("checkbox", null, true)).toBe("true");
    expect(validateWorkspaceValue("checkbox", null, "false")).toBe("false");
    expect(() => validateWorkspaceValue("checkbox", null, "yes")).toThrow();
  });

  it("validates URLs", () => {
    expect(validateWorkspaceValue("url", null, "https://example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(() => validateWorkspaceValue("url", null, "not a url")).toThrow(/url/i);
    expect(() =>
      validateWorkspaceValue("url", null, "javascript:alert(1)"),
    ).toThrow();
  });

  it("round-trips multi-select storage", () => {
    expect(parseMultiSelectValue('["A","B"]')).toEqual(["A", "B"]);
    expect(parseMultiSelectValue(null)).toEqual([]);
    expect(parseMultiSelectValue("garbage{")).toEqual(["garbage{"]);
  });

  it("displays defaults only when no stored value exists", () => {
    const field = { default_value: "New" };
    expect(displayWorkspaceValue(field, null)).toBe("New");
    expect(displayWorkspaceValue(field, undefined)).toBe("New");
    // Existing records keep their own values — defaults never overwrite.
    expect(displayWorkspaceValue(field, "Contacted")).toBe("Contacted");
    expect(displayWorkspaceValue(field, "")).toBe("");
    expect(displayWorkspaceValue({ default_value: null }, null)).toBeNull();
  });
});
