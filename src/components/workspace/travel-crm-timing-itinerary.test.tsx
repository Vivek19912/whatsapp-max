import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildTravelTimingPayload,
  clearInactiveTravelTiming,
  currentTravelYear,
  DepartureSearchSelect,
  destinationOptionLabel,
  filterDestinationOptions,
  groupDestinationOptionsByCountry,
  ItineraryDestinationList,
  ItineraryDestinationSelect,
  itineraryDialogRowsToOverrides,
  toggleCountryExpanded,
  TRAVEL_DATE_REQUIRED_ERROR,
  TRAVEL_MONTH_NAMES,
  TravelTimingSelect,
  travelYearOptions,
  validateItineraryRows,
  validateTravelTiming,
} from "./travel-crm-action";

// ---------------------------------------------------------------------------
// Phase 1: Exact/Month travel timing + country-grouped itinerary
// destination selection (WACRM-side only). Month/year payload shapes
// are prepared and unit-tested here but never transmitted: the
// current Travel CRM integration contract accepts exact dates only.
// ---------------------------------------------------------------------------

const SRC = () =>
  readFileSync(
    `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
    "utf8",
  );

describe("travel timing modes", () => {
  it("Exact Date keeps the existing presence validation and payload shape", () => {
    expect(
      validateTravelTiming({
        mode: "exact",
        travelStartDate: "2026-05-01",
        travelMonth: "",
        travelYear: "",
      }),
    ).toBeNull();
    expect(
      validateTravelTiming({
        mode: "exact",
        travelStartDate: "  ",
        travelMonth: "",
        travelYear: "",
      }),
    ).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(
      buildTravelTimingPayload({
        mode: "exact",
        travelStartDate: " 2026-05-01 ",
        travelMonth: "",
        travelYear: "",
      }),
    ).toEqual({ mode: "exact", travelStartDate: "2026-05-01" });
  });

  it("Month mode renders month and year selectors (no date input)", () => {
    const html = renderToStaticMarkup(
      <TravelTimingSelect
        label="Travel Date"
        mode="month"
        travelStartDate=""
        travelMonth=""
        travelYear={String(currentTravelYear())}
        error={null}
        onModeChange={() => {}}
        onDateChange={() => {}}
        onMonthChange={() => {}}
        onYearChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Travel Timing"');
    expect(html).toContain('aria-label="Travel month"');
    expect(html).toContain('aria-label="Travel year"');
    expect(TRAVEL_MONTH_NAMES).toHaveLength(12);
    expect(TRAVEL_MONTH_NAMES[0]).toBe("January");
    expect(TRAVEL_MONTH_NAMES[11]).toBe("December");
    // Year range mirrors native Travel CRM (current−2 … current+10).
    const years = travelYearOptions();
    const current = currentTravelYear();
    expect(years[0]).toBe(String(current - 2));
    expect(years[years.length - 1]).toBe(String(current + 10));
    expect(years).toContain(String(current));
  });

  it("Exact mode renders the unchanged date input", () => {
    const html = renderToStaticMarkup(
      <TravelTimingSelect
        label="Travel Date"
        mode="exact"
        travelStartDate="2026-05-01"
        travelMonth=""
        travelYear=""
        error={null}
        onModeChange={() => {}}
        onDateChange={() => {}}
        onMonthChange={() => {}}
        onYearChange={() => {}}
      />,
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('aria-label="Travel Date"');
    expect(html).not.toContain('aria-label="Travel month"');
  });

  it("inline errors render inside the timing selector", () => {
    const html = renderToStaticMarkup(
      <TravelTimingSelect
        label="Travel Date"
        mode="month"
        travelStartDate=""
        travelMonth=""
        travelYear=""
        error="Select a travel month and year."
        onModeChange={() => {}}
        onDateChange={() => {}}
        onMonthChange={() => {}}
        onYearChange={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Select a travel month and year.");
  });
});

describe("travel timing validation", () => {
  it("month and year are validated together", () => {
    const base = { mode: "month" as const, travelStartDate: "" };
    expect(validateTravelTiming({ ...base, travelMonth: "", travelYear: "" })).toBe(
      "Select a travel month and year.",
    );
    expect(validateTravelTiming({ ...base, travelMonth: "5", travelYear: "" })).toBe(
      "Select both a travel month and year.",
    );
    expect(validateTravelTiming({ ...base, travelMonth: "", travelYear: "2027" })).toBe(
      "Select both a travel month and year.",
    );
    expect(validateTravelTiming({ ...base, travelMonth: "5", travelYear: "2027" })).toBeNull();
  });

  it("month/year ranges mirror native Travel CRM (1–12, 1900–2100)", () => {
    const base = { mode: "month" as const, travelStartDate: "", travelYear: "2027" };
    expect(validateTravelTiming({ ...base, travelMonth: "0" })).toBe(
      "Travel month must be between 1 and 12.",
    );
    expect(validateTravelTiming({ ...base, travelMonth: "13" })).toBe(
      "Travel month must be between 1 and 12.",
    );
    expect(
      validateTravelTiming({ mode: "month", travelStartDate: "", travelMonth: "5", travelYear: "1899" }),
    ).toBe("Travel year must be between 1900 and 2100.");
    expect(
      validateTravelTiming({ mode: "month", travelStartDate: "", travelMonth: "5", travelYear: "2101" }),
    ).toBe("Travel year must be between 1900 and 2100.");
  });

  it("switching modes clears the inactive representation", () => {
    expect(
      clearInactiveTravelTiming("month", {
        travelStartDate: "2026-05-01",
        travelMonth: "5",
        travelYear: "2027",
      }),
    ).toEqual({ travelStartDate: "", travelMonth: "5", travelYear: "2027" });
    expect(
      clearInactiveTravelTiming("exact", {
        travelStartDate: "",
        travelMonth: "5",
        travelYear: "2027",
      }),
    ).toEqual({ travelStartDate: "", travelMonth: "", travelYear: "" });
  });
});

describe("travel timing payload preparation (Phase-2 ready, unsent)", () => {
  it("never invents a day for month-based travel", () => {
    const payload = buildTravelTimingPayload({
      mode: "month",
      travelStartDate: "",
      travelMonth: "5",
      travelYear: "2027",
    });
    expect(payload).toEqual({ mode: "month", travelMonth: 5, travelYear: 2027 });
    expect(payload).not.toHaveProperty("travelStartDate");
  });

  it("month payloads never enter backend overrides in this phase", () => {
    const src = SRC();
    // The submit gate validates the active mode, then stops month
    // submissions with an explicit Phase 2 notice.
    expect(src).toContain('travelTiming === "month"');
    expect(src).toContain("Phase 2");
    expect(src).not.toContain("overrides.travelMonth");
    expect(src).not.toContain("overrides.travelYear");
    // Exact-date request format and behavior preserved.
    expect(src).toContain("validateTravelDateValue");
    expect(src).toContain("TRAVEL_DATE_REQUIRED_ERROR");
  });
});

describe("destination option labels (native convention)", () => {
  it("combines public and private names with an em dash", () => {
    expect(destinationOptionLabel("Thailand", "Thai Private")).toBe(
      "Thailand — Thai Private",
    );
  });

  it("never repeats duplicated public/private names", () => {
    expect(destinationOptionLabel("Goa", "")).toBe("Goa");
    expect(destinationOptionLabel("Goa", null)).toBe("Goa");
    expect(destinationOptionLabel("Goa", "Goa")).toBe("Goa");
    expect(destinationOptionLabel("Goa", "  goa  ")).toBe("Goa");
  });
});

describe("country grouping without fabricated data", () => {
  const enriched = [
    { value: "d-th", label: "Thailand", privateName: "Thai Private", countryName: "Thailand" },
    { value: "d-ph", label: "Phuket", privateName: null, countryName: "Thailand" },
    { value: "d-goa", label: "Goa", privateName: null, countryName: "India" },
    { value: "d-x", label: "Mystery", privateName: null, countryName: "" },
  ];

  it("groups by country and pins blank-country options under Other last", () => {
    const groups = groupDestinationOptionsByCountry(enriched);
    expect(groups.map((g) => g.country)).toEqual(["Thailand", "India", "Other"]);
    expect(groups[0].options.map((o) => o.value)).toEqual(["d-th", "d-ph"]);
    expect(groups[2].options.map((o) => o.value)).toEqual(["d-x"]);
  });

  it("renders flat with zero invented data when the feed has no metadata", () => {
    const flat = [
      { value: "d1", label: "Bali" },
      { value: "d2", label: "Dubai" },
    ];
    const groups = groupDestinationOptionsByCountry(flat);
    expect(groups).toEqual([{ country: null, options: flat }]);
  });
});

describe("destination search and selection", () => {
  const options = [
    { value: "d-th", label: "Thailand", privateName: "Thai Private", countryName: "Thailand" },
    { value: "d-goa", label: "Goa", privateName: null, countryName: "India" },
  ];

  it("matches public and private names without submitting them", () => {
    expect(filterDestinationOptions(options, "thai").map((o) => o.value)).toEqual([
      "d-th",
    ]);
    // Private-name fragment matches although no public name contains it.
    expect(filterDestinationOptions(options, "private").map((o) => o.value)).toEqual([
      "d-th",
    ]);
    expect(filterDestinationOptions(options, "goa").map((o) => o.value)).toEqual([
      "d-goa",
    ]);
    expect(filterDestinationOptions(options, "")).toHaveLength(2);
    expect(filterDestinationOptions(options, "zzz")).toHaveLength(0);
  });

  it("the committed field displays the public destination name only", () => {
    const html = renderToStaticMarkup(
      <ItineraryDestinationSelect
        value="d-th"
        options={options}
        inputId="lead-itin-dest-0"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Thailand");
    expect(html).not.toContain("Thai Private");
    expect(html).toContain('aria-label="Destination"');
  });

  it("selection passes the master ID (private names never submitted)", () => {
    // The dropdown commits option.value (stable master ID) through
    // pick(); labels (incl. private names) render as text only and
    // never travel. Verified at the wiring level:
    const src = SRC();
    expect(src).toContain("onClick={() => pick(o.value)}");
    expect(src).toContain("{destinationOptionLabel(o.label, o.privateName)}");
    expect(src).not.toContain("pick(o.label)");
  });

  it("renders expandable country headings when metadata is available", () => {
    // The open dropdown content renders through the shared
    // presentational list (the exact output both dropdowns show):
    // headings first in feed order with counts, collapsed by
    // default (options hidden until expanded).
    const html = renderToStaticMarkup(
      <ItineraryDestinationList
        groups={groupDestinationOptionsByCountry([
          { value: "d-th", label: "Thailand", privateName: null, countryName: "Thailand" },
          { value: "d-goa", label: "Goa", privateName: null, countryName: "India" },
        ])}
        grouped
        searching={false}
        expanded={new Set()}
        highlight={-1}
        selectedValue=""
        onToggleCountry={() => {}}
        onPick={() => {}}
        onHighlight={() => {}}
        listRef={{ current: null }}
      />,
    );
    const thailandAt = html.indexOf("Thailand");
    const indiaAt = html.indexOf(">India<");
    expect(thailandAt).toBeGreaterThan(-1);
    expect(indiaAt).toBeGreaterThan(thailandAt);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">1<");
    expect(html).not.toContain("No matching options.");
    // Collapsed sections hide their rows (nothing invented, nothing
    // leaked before expansion).
    expect(html).not.toContain(">Goa<");
    const src = SRC();
    // Headings toggle one country's section; searching shows all
    // matching groups open; the flat fallback has no headings.
    expect(src).toContain("aria-expanded={isOpen}");
    expect(src).toContain("onClick={() => onToggleCountry(key)}");
    expect(src).toContain("onToggleCountry={toggleCountry}");
    expect(src).toContain("const isOpen = searching || expanded.has(key)");
  });

  it("open grouped dropdown shows private-name labels and selection", () => {
    const html = renderToStaticMarkup(
      <ItineraryDestinationList
        groups={groupDestinationOptionsByCountry([
          { value: "d-th", label: "Thailand", privateName: "Thai Private", countryName: "Thailand" },
          { value: "d-goa", label: "Goa", privateName: null, countryName: "India" },
        ])}
        grouped
        searching={false}
        expanded={new Set(["Thailand"])}
        highlight={0}
        selectedValue="d-th"
        onToggleCountry={() => {}}
        onPick={() => {}}
        onHighlight={() => {}}
        listRef={{ current: null }}
      />,
    );
    // Expanded option rows use the native `Destination — Private`
    // convention with the selection marked…
    expect(html).toContain("Thailand — Thai Private");
    expect(html).toContain('aria-selected="true"');
    // …while collapsed India's rows stay hidden.
    expect(html).not.toContain(">Goa<");
  });

  it("toggleCountryExpanded expands and collapses one country at a time", () => {
    expect(toggleCountryExpanded(new Set(), "India")).toEqual(new Set(["India"]));
    expect(toggleCountryExpanded(new Set(["India"]), "India")).toEqual(new Set());
    // Other countries untouched; input never mutated.
    const prev = new Set(["India"]);
    expect(toggleCountryExpanded(prev, "Singapore")).toEqual(
      new Set(["India", "Singapore"]),
    );
    expect(prev).toEqual(new Set(["India"]));
  });

  it("both dropdown locations render the shared grouped selector", () => {
    const action = SRC();
    expect(action).toContain("<ItineraryDestinationSelect");
    const settings = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    expect(settings).toContain("<ItineraryDestinationSelect");
  });

  it("flat metadata-free lists render with no invented countries", () => {
    const flat = [
      { value: "d1", label: "Bali" },
      { value: "d2", label: "Dubai" },
    ];
    const html = renderToStaticMarkup(
      <ItineraryDestinationList
        groups={groupDestinationOptionsByCountry(flat)}
        grouped={false}
        searching={false}
        expanded={new Set()}
        highlight={-1}
        selectedValue="d1"
        onToggleCountry={() => {}}
        onPick={() => {}}
        onHighlight={() => {}}
        listRef={{ current: null }}
      />,
    );
    expect(html).toContain("Bali");
    expect(html).toContain("Dubai");
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("Other");
    expect(html).not.toContain("aria-expanded");
  });
});

describe("city dependencies", () => {
  it("city selection stays disabled until a destination is picked", () => {
    const src = SRC();
    expect(src).toContain("disabled={!row.destination}");
    expect(src).toContain('"Pick destination first"');
  });

  it("destination changes keep compatible cities and clear the rest", () => {
    const src = SRC();
    expect(src).toContain("updateItineraryDialogDestination(prev, i, v ?? \"\", allCities)");
  });
});

describe("incomplete itinerary rows block submission", () => {
  it("fully-empty rows stay skippable (flow-defaults path preserved)", () => {
    expect(validateItineraryRows([])).toBeNull();
    expect(
      validateItineraryRows([{ destination: "", city: "", nights: "  " }]),
    ).toBeNull();
  });

  it("partial rows name the row instead of being discarded", () => {
    expect(
      validateItineraryRows([{ destination: "d", city: "", nights: "" }]),
    ).toBe("Itinerary row 1 needs a destination and a city. Select both or clear the row.");
    expect(
      validateItineraryRows([
        { destination: "d", city: "c", nights: "3" },
        { destination: "", city: "c", nights: "" },
      ]),
    ).toBe("Itinerary row 2 needs a destination and a city. Select both or clear the row.");
  });

  it("bad nights surface row-numbered without losing entered data", () => {
    const rows = [{ destination: "d", city: "c", nights: "0" }];
    const message = validateItineraryRows(rows);
    expect(message).toContain("Itinerary row 1:");
    expect(message).toContain("nights");
    // Input untouched — the agent corrects in place.
    expect(rows).toEqual([{ destination: "d", city: "c", nights: "0" }]);
  });

  it("valid multi-row itineraries keep their existing submission behavior", () => {
    const rows = [
      { destination: "d1", city: "c1", nights: "3" },
      { destination: "d2", city: "c2", nights: "4" },
    ];
    expect(validateItineraryRows(rows)).toBeNull();
    expect(itineraryDialogRowsToOverrides(rows)).toEqual([
      { destination: "d1", city: "c1", nights: 3 },
      { destination: "d2", city: "c2", nights: 4 },
    ]);
  });

  it("submit() validates rows before building overrides", () => {
    const src = SRC();
    expect(src).toContain("validateItineraryRows(itineraryRows)");
  });
});

describe("Phase 1 regression guards", () => {
  it("exact-date creation path is unchanged", () => {
    const src = SRC();
    // Generic override loop still carries a non-empty exact date.
    expect(src).toContain("overrides[input.field");
    expect(src).toContain('input.field === "travelStartDate"');
  });

  it("no traveler-name or Assigned To changes introduced", () => {
    const src = SRC();
    expect(src).not.toContain("adultNames");
    // Assignment override renaming untouched.
    expect(src).toContain('"assignedUserId"');
  });

  it("departure, services, counts, and phone mapping untouched", () => {
    const src = SRC();
    expect(src).toContain("DepartureSearchSelect");
    expect(src).toContain("joinServiceLabels");
    expect(src).toContain("travelerFormToOverrides");
    // Phone edits resolve verbatim without inventing a country code.
    expect(src).toContain("resolveDialogPhoneForSubmit");
  });
});

describe("Month mode defaults the year to the current year", () => {
  it("switching to Month auto-selects the current year as a real value", () => {
    const src = SRC();
    // The mode switch fills an empty year with the current calendar
    // year (a valid selected value, never placeholder text) while
    // preserving an explicitly picked year.
    expect(src).toContain("setTravelYear((prev)");
    expect(src).toContain("String(currentTravelYear())");
    expect(currentTravelYear()).toBe(new Date().getFullYear());
    const current = String(currentTravelYear());
    expect(travelYearOptions()).toContain(current);
    // Empty year + picked month is incomplete (must be selected).
    expect(
      validateTravelTiming({ mode: "month", travelStartDate: "", travelMonth: "5", travelYear: "" }),
    ).toBe("Select both a travel month and year.");
    expect(
      validateTravelTiming({ mode: "month", travelStartDate: "", travelMonth: "5", travelYear: current }),
    ).toBeNull();
  });

  it("mutual exclusion and the Month submission gate are preserved", () => {
    const src = SRC();
    expect(src).toContain("clearInactiveTravelTiming");
    expect(src).toContain('travelTiming === "month"');
    expect(src).toContain("Phase 2");
    expect(src).not.toContain("overrides.travelMonth");
    expect(src).not.toContain("overrides.travelYear");
  });
});

describe("infant ages are months (native parity)", () => {
  it("infant age inputs are labeled in Months; CWB/CWOB stay plain ages", () => {
    const src = SRC();
    expect(src).toContain("{ageRows(\"infantAges\", infantCount, \"Infant\", \"Months\")}");
    expect(src).toContain("Age (${unit})");
    // Only infants carry a unit — CWB/CWOB keep the plain label.
    expect(src).toContain('{ageRows("cwbAges", cwbCount, "CWB")}');
    expect(src).toContain('{ageRows("cwobAges", cwobCount, "CWOB")}');
  });

  it("entering 6 submits 6 months into infantAges (never another field)", () => {
    // The infantAges group feeds overrides.infantAges verbatim via
    // the shared ages pipeline (same as CWB/CWOB groups).
    const src = SRC();
    expect(src).toContain("infantAges: agesOf(form.infantAges)");
    expect(src).toContain("overrides.infantAges = t.infantAges");
  });
});

describe("departure combobox keyboard behavior", () => {
  const comboBlock = () => {
    const src = SRC();
    const start = src.indexOf("export function DepartureSearchSelect");
    const end = src.indexOf("export function TravelTimingSelect");
    return src.slice(start, end);
  };

  it("owns arrow/Enter navigation with stable scroll (no popup typeahead)", () => {
    const block = comboBlock();
    // Arrow/Home/End move a component-owned highlight; Enter
    // selects it (else the first visible option).
    expect(block).toContain('"ArrowDown"');
    expect(block).toContain('"ArrowUp"');
    expect(block).toContain('"Enter"');
    // Scroll-into-view fires only from keyboard navigation, never
    // while typing (query changes only reset the highlight).
    expect(block).toContain('scrollIntoView({ block: "nearest" })');
    expect(block).toContain("setHighlight(-1)");
  });

  it("Escape and Tab keep working (dismiss + focus out)", () => {
    const block = comboBlock();
    // Neither key is intercepted or compared in the search handler,
    // so the Popover dismisses on Escape and focus leaves on Tab.
    expect(block).not.toContain('e.key === "Escape"');
    expect(block).not.toContain('e.key === "Tab"');
  });

  it("selecting shows the picked label and preserves the India default", () => {
    const html = renderToStaticMarkup(
      <DepartureSearchSelect
        label="Departure Country"
        value="India"
        options={[
          { value: "India", label: "India" },
          { value: "France", label: "France" },
        ]}
        placeholder="Select Departure Country"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("India");
    expect(html).toContain('aria-label="Departure Country"');
  });
});
