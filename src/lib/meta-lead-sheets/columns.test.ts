// Meta Sheets selectable forms + columns — pure mapping tests.
// Covers: exact custom headers in order, dynamic question mapping,
// union across forms with blanks, rename-safe mapping, legacy
// defaults, and validation.

import { describe, expect, it } from "vitest";

import {
  answerFieldKey,
  buildDynamicFieldOptions,
  computeManagedLayout,
  DEFAULT_SHEETS_COLUMNS,
  META_LEAD_ID_FIELD_KEY,
  projectRowValues,
  resolveEffectiveColumns,
  validateColumnConfig,
} from "./columns";

describe("legacy default layout", () => {
  it("reproduces the historical 12 headers with the ID pinned at A", () => {
    const columns = resolveEffectiveColumns(null);
    expect(columns).toEqual(DEFAULT_SHEETS_COLUMNS);
    const layout = computeManagedLayout(columns);
    expect(layout.headers).toEqual([
      "Meta Lead ID",
      "Submitted At",
      "Name",
      "Phone",
      "Email",
      "Form Name",
      "Campaign",
      "Ad",
      "Source",
      "Assigned To",
      "Lead Type",
      "Stage",
    ]);
    expect(layout.idVisible).toBe(true);
  });

  it("falls back to the default on malformed saved configs", () => {
    expect(resolveEffectiveColumns(undefined)).toEqual(DEFAULT_SHEETS_COLUMNS);
    expect(resolveEffectiveColumns("nope")).toEqual(DEFAULT_SHEETS_COLUMNS);
    expect(resolveEffectiveColumns([{ key: "", label: "x" }])).toEqual(DEFAULT_SHEETS_COLUMNS);
    expect(resolveEffectiveColumns([{ key: "name", label: "" }])).toEqual(DEFAULT_SHEETS_COLUMNS);
    expect(
      resolveEffectiveColumns([
        { key: "name", label: "Name" },
        { key: "name", label: "Name 2" },
      ]),
    ).toEqual(DEFAULT_SHEETS_COLUMNS);
  });
});

describe("custom column selection", () => {
  it("produces exactly the requested visible headers in order", () => {
    const columns = [
      { key: "name", label: "Lead Name" },
      { key: "answer:budget", label: "Budget" },
      { key: "stage", label: "Stage" },
    ];
    const layout = computeManagedLayout(columns);
    // Meta Lead ID is pinned to column A even when hidden.
    expect(layout.headers).toEqual(["Meta Lead ID", "Lead Name", "Budget", "Stage"]);
    expect(layout.idVisible).toBe(false);
  });

  it("keeps a visible ID column in place with its custom label", () => {
    const columns = [
      { key: "phone", label: "Phone" },
      { key: "meta_lead_id", label: "Lead Ref" },
    ];
    const layout = computeManagedLayout(columns);
    expect(layout.headers).toEqual(["Lead Ref", "Phone"]);
    expect(layout.idVisible).toBe(true);
  });

  it("projects rows by key, leaving missing fields blank", () => {
    const columns = [
      { key: "name", label: "Lead Name" },
      { key: "answer:budget", label: "Budget" },
      { key: "answer:hotel_category", label: "Hotel" },
    ];
    const row = projectRowValues(
      {
        [META_LEAD_ID_FIELD_KEY]: "lead-1",
        name: "Asha",
        "answer:budget": "5L",
      },
      columns,
    );
    expect(row).toEqual(["lead-1", "Asha", "5L", ""]);
  });

  it("renaming a label never changes the mapped values", () => {
    const before = projectRowValues({ meta_lead_id: "L", name: "Asha" }, [
      { key: "name", label: "Name" },
    ]);
    const after = projectRowValues({ meta_lead_id: "L", name: "Asha" }, [
      { key: "name", label: "Completely Different" },
    ]);
    expect(after).toEqual(before);
  });
});

describe("dynamic question fields", () => {
  const forms = [
    {
      form_name: "Singapore Lead Ad",
      questions: [
        { key: "budget", label: "Budget" },
        { key: "passport", label: "Do you have a passport" },
      ],
    },
    {
      form_name: "Cruise Lead Ad",
      questions: [
        { key: "budget", label: "Budget" },
        { key: "travellers", label: "No. of Travellers" },
      ],
    },
  ];

  it("unions question keys across forms with form attribution", () => {
    const options = buildDynamicFieldOptions(forms);
    // Stored keys win over labels (same rule ingestion uses).
    expect(options.map((o) => o.key).sort()).toEqual(
      ["answer:budget", "answer:travellers", "answer:passport"].sort(),
    );
    const budget = options.find((o) => o.key === "answer:budget")!;
    expect(budget.label).toBe("Budget");
    expect(budget.formNames).toEqual(["Singapore Lead Ad", "Cruise Lead Ad"]);
  });

  it("uses the same sanitization as ingestion for mapping", () => {
    const options = buildDynamicFieldOptions([
      { form_name: "F", questions: [{ key: null, label: "No. of Travellers" }] },
    ]);
    expect(options[0].key).toBe("answer:no_of_travellers");
  });
});

describe("validateColumnConfig", () => {
  const allowed = new Set(["name", "answer:budget", "meta_lead_id"]);

  it("accepts a valid ordered list", () => {
    const result = validateColumnConfig(
      [
        { key: "name", label: "Lead Name" },
        { key: "answer:budget", label: "Budget" },
      ],
      allowed,
    );
    expect(result).toEqual({
      columns: [
        { key: "name", label: "Lead Name" },
        { key: "answer:budget", label: "Budget" },
      ],
    });
  });

  it("rejects empty, unknown, duplicate, and bad labels", () => {
    expect(validateColumnConfig([], allowed)).toHaveProperty("error");
    expect(validateColumnConfig([{ key: "nope", label: "X" }], allowed)).toHaveProperty("error");
    expect(
      validateColumnConfig(
        [
          { key: "name", label: "A" },
          { key: "name", label: "B" },
        ],
        allowed,
      ),
    ).toHaveProperty("error");
    expect(validateColumnConfig([{ key: "name", label: "" }], allowed)).toHaveProperty("error");
    expect(validateColumnConfig([{ key: "name", label: "x".repeat(101) }], allowed)).toHaveProperty(
      "error",
    );
  });
});

describe("answer key namespace", () => {
  it("prefixes dynamic keys so they never collide with standard keys", () => {
    expect(answerFieldKey("full_name")).toBe("answer:full_name");
    expect(answerFieldKey("meta_lead_id")).toBe("answer:meta_lead_id");
  });
});
