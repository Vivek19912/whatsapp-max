// Meta Sheets selectable forms + columns — pure mapping tests.
// Covers: exact custom headers in order, dynamic question mapping,
// union across forms with blanks, rename-safe mapping, legacy
// defaults, and validation.

import { describe, expect, it } from "vitest";

import {
  answerFieldKey,
  buildDynamicFieldOptions,
  computeManagedLayout,
  dedupeEquivalentColumns,
  dedupeSheetsColumns,
  DEFAULT_SHEETS_COLUMNS,
  defaultSheetsColumns,
  equivalentStandardKey,
  META_LEAD_ID_FIELD_KEY,
  projectRowValues,
  resolveEffectiveColumns,
  validateColumnConfig,
  withoutShadowedDynamicColumns,
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
  it("produces exactly the requested visible headers in order, ID last when hidden", () => {
    const columns = [
      { key: "name", label: "Lead Name" },
      { key: "answer:budget", label: "Budget" },
      { key: "stage", label: "Stage" },
    ];
    const layout = computeManagedLayout(columns);
    // A deselected Meta Lead ID is still written (hidden via the
    // API) after the last visible column so matching keeps working.
    expect(layout.headers).toEqual(["Lead Name", "Budget", "Stage", "Meta Lead ID"]);
    expect(layout.idVisible).toBe(false);
    expect(layout.idColumnIndex).toBe(3);
  });

  it("keeps a legacy ID-first selection at column A", () => {
    const columns = [
      { key: "meta_lead_id", label: "Meta Lead ID" },
      { key: "phone", label: "Phone" },
    ];
    const layout = computeManagedLayout(columns);
    expect(layout.headers).toEqual(["Meta Lead ID", "Phone"]);
    expect(layout.idVisible).toBe(true);
    expect(layout.idColumnIndex).toBe(0);
  });

  it("keeps a visible ID column in its configured place with its custom label", () => {
    const columns = [
      { key: "phone", label: "Phone" },
      { key: "meta_lead_id", label: "Lead Ref" },
    ];
    const layout = computeManagedLayout(columns);
    expect(layout.headers).toEqual(["Phone", "Lead Ref"]);
    expect(layout.idVisible).toBe(true);
    expect(layout.idColumnIndex).toBe(1);
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
    expect(row).toEqual(["Asha", "5L", "", "lead-1"]);
  });

  it("projects the ID at its configured position", () => {
    const fieldMap = { [META_LEAD_ID_FIELD_KEY]: "L", name: "Asha", phone: "P" };
    expect(
      projectRowValues(fieldMap, [
        { key: "meta_lead_id", label: "Meta Lead ID" },
        { key: "name", label: "Name" },
      ]),
    ).toEqual(["L", "Asha"]);
    expect(
      projectRowValues(fieldMap, [
        { key: "name", label: "Name" },
        { key: "meta_lead_id", label: "Meta Lead ID" },
      ]),
    ).toEqual(["Asha", "L"]);
    expect(
      projectRowValues(fieldMap, [{ key: "phone", label: "Phone" }]),
    ).toEqual(["P", "L"]);
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

describe("dedupeSheetsColumns", () => {
  it("keeps the first occurrence of each key in order", () => {
    expect(
      dedupeSheetsColumns([
        { key: "name", label: "Name" },
        { key: "phone", label: "Phone" },
        { key: "name", label: "Name Again" },
        { key: "stage", label: "Stage" },
        { key: "phone", label: "Phone Again" },
      ]),
    ).toEqual([
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone" },
      { key: "stage", label: "Stage" },
    ]);
  });

  it("passes unique selections through untouched", () => {
    const cols = [
      { key: "meta_lead_id", label: "Meta Lead ID" },
      { key: "name", label: "Name" },
    ];
    expect(dedupeSheetsColumns(cols)).toEqual(cols);
    expect(dedupeSheetsColumns([])).toEqual([]);
  });
});

describe("defaultSheetsColumns", () => {
  const workspace = [
    { key: "submitted_at", label: "Submitted At" },
    { key: "name", label: "Lead Name" },
    { key: "answer:budget", label: "Budget" },
    { key: "assignee", label: "Assigned To" },
  ];
  const standard = [
    { key: "meta_lead_id", label: "Meta Lead ID" },
    { key: "form_name", label: "Form Name" },
  ];
  const dynamic = [{ key: "answer:budget", label: "Budget" }];

  it("selects every Workspace header in table order with the ID last, exactly once", () => {
    const out = defaultSheetsColumns({ workspace, standard, dynamic });
    expect(out).toEqual([
      { key: "submitted_at", label: "Submitted At" },
      { key: "name", label: "Lead Name" },
      { key: "answer:budget", label: "Budget" },
      { key: "assignee", label: "Assigned To" },
      { key: "meta_lead_id", label: "Meta Lead ID" },
    ]);
    // The default layout reports the ID at its trailing position so
    // scans, visibility, and matching follow it there.
    const layout = computeManagedLayout(out);
    expect(layout.idColumnIndex).toBe(out.length - 1);
    expect(layout.headers.at(-1)).toBe("Meta Lead ID");
    expect(layout.idVisible).toBe(true);
  });

  it("never duplicates the ID when the Workspace list contains it", () => {
    const withId = [
      ...workspace,
      { key: "meta_lead_id", label: "Meta Lead ID" },
    ];
    const out = defaultSheetsColumns({ workspace: withId, standard, dynamic });
    expect(out.filter((c) => c.key === "meta_lead_id")).toHaveLength(1);
    expect(out.at(-1)).toEqual({ key: "meta_lead_id", label: "Meta Lead ID" });
  });

  it("falls back to standard + dynamic order (ID last) when no Workspace headers are available", () => {
    expect(
      defaultSheetsColumns({ workspace: [], standard, dynamic }).map((c) => c.key),
    ).toEqual(["form_name", "answer:budget", "meta_lead_id"]);
  });

  it("collapses Workspace twins (Name/Full name) in defaults, keeps twins without a counterpart", () => {
    const withTwins = [
      ...workspace,
      { key: "answer:full_name", label: "Full name" },
      // No `phone` in this Workspace list, so the phone twin stays:
      // offering something beats offering nothing.
      { key: "answer:phone_number", label: "Phone number" },
    ];
    expect(
      defaultSheetsColumns({ workspace: withTwins, standard, dynamic }).map((c) => c.key),
    ).toEqual([
      "submitted_at",
      "name",
      "answer:budget",
      "assignee",
      "answer:phone_number",
      "meta_lead_id",
    ]);
  });
});

describe("equivalentStandardKey", () => {
  it("maps identity answer keys to their standard field by key, never label", () => {
    expect(equivalentStandardKey("answer:full_name")).toBe("name");
    expect(equivalentStandardKey("answer:name")).toBe("name");
    expect(equivalentStandardKey("answer:phone_number")).toBe("phone");
    expect(equivalentStandardKey("answer:phone")).toBe("phone");
    expect(equivalentStandardKey("answer:mobile")).toBe("phone");
    expect(equivalentStandardKey("answer:email")).toBe("email");
    expect(equivalentStandardKey("answer:email_address")).toBe("email");
  });

  it("leaves distinct custom questions and standard keys alone", () => {
    expect(equivalentStandardKey("answer:budget")).toBeNull();
    expect(equivalentStandardKey("answer:city")).toBeNull();
    expect(equivalentStandardKey("answer:phone_ext")).toBeNull();
    expect(equivalentStandardKey("name")).toBeNull();
    expect(equivalentStandardKey("phone")).toBeNull();
    expect(equivalentStandardKey("meta_lead_id")).toBeNull();
  });
});

describe("withoutShadowedDynamicColumns", () => {
  const offered = [
    { key: "name", label: "Name" },
    { key: "phone", label: "Phone Number" },
    { key: "email", label: "Email" },
  ];

  it("hides Full name / Phone number twins when Name / Phone are offered", () => {
    expect(
      withoutShadowedDynamicColumns(
        [
          { key: "answer:full_name", label: "Full name" },
          { key: "answer:phone_number", label: "Phone number" },
          { key: "answer:budget", label: "Budget" },
        ],
        offered,
      ),
    ).toEqual([{ key: "answer:budget", label: "Budget" }]);
  });

  it("keeps a twin when its standard counterpart is absent", () => {
    expect(
      withoutShadowedDynamicColumns(
        [{ key: "answer:full_name", label: "Full name" }],
        [{ key: "phone", label: "Phone" }],
      ),
    ).toEqual([{ key: "answer:full_name", label: "Full name" }]);
  });
});

describe("dedupeEquivalentColumns", () => {
  it("prefers the standard key when both it and a twin are selected", () => {
    expect(
      dedupeEquivalentColumns([
        { key: "answer:full_name", label: "Full name" },
        { key: "name", label: "Name" },
        { key: "answer:phone_number", label: "Phone number" },
        { key: "phone", label: "Phone Number" },
      ]),
    ).toEqual([
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone Number" },
    ]);
  });

  it("keeps distinct custom fields and exact-order otherwise", () => {
    expect(
      dedupeEquivalentColumns([
        { key: "name", label: "Name" },
        { key: "answer:budget", label: "Budget" },
        { key: "answer:city", label: "City" },
      ]),
    ).toEqual([
      { key: "name", label: "Name" },
      { key: "answer:budget", label: "Budget" },
      { key: "answer:city", label: "City" },
    ]);
  });
});

describe("answer key namespace", () => {
  it("prefixes dynamic keys so they never collide with standard keys", () => {
    expect(answerFieldKey("full_name")).toBe("answer:full_name");
    expect(answerFieldKey("meta_lead_id")).toBe("answer:meta_lead_id");
  });
});
