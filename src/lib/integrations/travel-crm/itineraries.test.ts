import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildItineraryLookups,
  citiesForDestination,
  cityLabelForValue,
  defaultsToDraftItinerary,
  destinationLabelForValue,
  draftToItineraryDefaults,
  extractCityOptions,
  extractDestinationOptions,
  isCompatibleCity,
  normalizeItineraryDefaults,
  resolveSelectValue,
  validateNightsInput,
} from "./itineraries";

// ---------------------------------------------------------------------------
// Focused tests: Travel CRM Itinerary Defaults (lib layer).
// Covers: normalize/save shape, nights validation, stable IDs,
// lookup extraction from Travel CRM (never hardcoded), city
// dependency, destination-change clearing, draft/payload mapping.
// ---------------------------------------------------------------------------

describe("normalizeItineraryDefaults (storage shape)", () => {
  it("1. accepts per-flow rows with stable IDs + nights", () => {
    expect(
      normalizeItineraryDefaults([
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-sg", city: "city-sentosa", nights: "3" },
      ]),
    ).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-sg", city: "city-sentosa", nights: 3 },
    ]);
  });

  it("drops empty rows so zero rows overall is savable", () => {
    expect(normalizeItineraryDefaults([])).toEqual([]);
    expect(
      normalizeItineraryDefaults([
        { destination: "", city: "", nights: "" },
        { destination: "  ", city: "", nights: "" },
      ]),
    ).toEqual([]);
  });

  it("drops rows missing destination but keeps complete ones", () => {
    expect(
      normalizeItineraryDefaults([
        { destination: "", city: "city-x", nights: 2 },
        { destination: "dest-a", city: "city-a", nights: 2 },
      ]),
    ).toEqual([{ destination: "dest-a", city: "city-a", nights: 2 }]);
  });

  it("accepts city-less dialog rows (Destination + Nights only)", () => {
    // The Create dialog no longer collects a per-row city: such rows
    // must survive normalization with an empty city, not be dropped.
    expect(
      normalizeItineraryDefaults([
        { destination: "dest-sg", nights: 4 },
        { destination: "dest-bali", city: "", nights: "3" },
      ]),
    ).toEqual([
      { destination: "dest-sg", city: "", nights: 4 },
      { destination: "dest-bali", city: "", nights: 3 },
    ]);
    // City-ful Settings rows keep working alongside city-less rows.
    expect(
      normalizeItineraryDefaults([
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-sg", nights: 3 },
      ]),
    ).toEqual([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-sg", city: "", nights: 3 },
    ]);
  });

  it("still drops destination-less rows and rejects bad nights without a city", () => {
    expect(
      normalizeItineraryDefaults([{ destination: "", nights: 2 }]),
    ).toEqual([]);
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", nights: 0 }]),
    ).toThrow();
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", nights: "two" }]),
    ).toThrow();
  });

  it("rejects non-lists and non-object rows", () => {
    expect(() => normalizeItineraryDefaults("x" as unknown as never)).toThrow();
    expect(() => normalizeItineraryDefaults([42] as unknown as never)).toThrow();
  });
});

describe("11. nights validation", () => {
  it("accepts positive whole numbers only", () => {
    expect(validateNightsInput(4)).toBeNull();
    expect(validateNightsInput("3")).toBeNull();
    expect(validateNightsInput(" 2 ")).toBeNull();
  });

  it("rejects zero, negatives, fractions, text, blanks", () => {
    for (const v of [0, -1, 1.5, "0", "-2", "2.5", "two", "", "  "]) {
      expect(validateNightsInput(v)).not.toBeNull();
    }
  });

  it("normalize throws on invalid nights in a non-empty row", () => {
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", city: "c", nights: 0 }]),
    ).toThrow();
    expect(() =>
      normalizeItineraryDefaults([{ destination: "d", city: "c", nights: "two" }]),
    ).toThrow();
  });
});

describe("8. destination lookup comes from Travel CRM (never hardcoded)", () => {
  it("extracts destinations from the live lookups payload", () => {
    const lookups = {
      destinations: [
        { value: "dest-sg", label: "Singapore" },
        { value: "dest-bali", label: "Bali" },
      ],
    };
    expect(extractDestinationOptions(lookups)).toEqual([
      { value: "dest-sg", label: "Singapore", countryName: null, privateName: null },
      { value: "dest-bali", label: "Bali", countryName: null, privateName: null },
    ]);
  });

  it("supports countries-shaped payloads and id/name objects", () => {
    expect(
      extractDestinationOptions({
        countries: [{ id: "c-sg", name: "Singapore" }],
      }),
    ).toEqual([{ value: "c-sg", label: "Singapore", countryName: null, privateName: null }]);
    expect(extractDestinationOptions({})).toEqual([]);
    expect(extractDestinationOptions(null)).toEqual([]);
  });

  it("forwards countryName/privateName metadata verbatim (null when absent)", () => {
    expect(
      extractDestinationOptions({
        destinations: [
          { value: "d1", label: "Thailand", countryName: "Thailand", privateName: "Thai Private" },
          { value: "d2", label: "Goa", countryName: "India", privateName: "  " },
          { value: "d3", label: "Bali" },
        ],
      }),
    ).toEqual([
      { value: "d1", label: "Thailand", countryName: "Thailand", privateName: "Thai Private" },
      { value: "d2", label: "Goa", countryName: "India", privateName: null },
      { value: "d3", label: "Bali", countryName: null, privateName: null },
    ]);
  });

  it("contains no hardcoded destination values in WACRM source", () => {
    const lib = readFileSync(`${process.cwd()}/src/lib/integrations/travel-crm/itineraries.ts`, "utf8");
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(lib).not.toContain(hardcoded);
    }
    const settings = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(settings).not.toContain(hardcoded);
    }
    const action = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    for (const hardcoded of ["Singapore", "Marina Bay", "Sentosa"]) {
      expect(action).not.toContain(hardcoded);
    }
  });
});

describe("9. city options depend on the selected destination", () => {
  const lookups = {
    destinations: [
      { value: "dest-sg", label: "Singapore" },
      { value: "dest-bali", label: "Bali" },
    ],
    cities: [
      { value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" },
      { value: "city-sentosa", label: "Sentosa Island", destinationValue: "dest-sg" },
      { value: "city-kuta", label: "Kuta", destinationValue: "dest-bali" },
    ],
  };

  it("extracts cities with parent linkage", () => {
    const cities = extractCityOptions(lookups);
    expect(cities).toHaveLength(3);
    expect(cities.find((c) => c.value === "city-marina")).toMatchObject({
      destinationValue: "dest-sg",
    });
  });

  it("filters cities per destination", () => {
    const cities = extractCityOptions(lookups);
    expect(citiesForDestination(cities, "dest-sg").map((c) => c.value).sort()).toEqual(
      ["city-marina", "city-sentosa"],
    );
    expect(citiesForDestination(cities, "dest-bali").map((c) => c.value)).toEqual([
      "city-kuta",
    ]);
  });

  it("builds citiesByDestination for the dialog", () => {
    const built = buildItineraryLookups(lookups);
    expect(Object.keys(built.citiesByDestination).sort()).toEqual(["dest-bali", "dest-sg"]);
    expect(built.citiesByDestination["dest-sg"].map((o) => o.value).sort()).toEqual([
      "city-marina",
      "city-sentosa",
    ]);
  });

  it("supports nested cities on destinations", () => {
    const nested = {
      destinations: [
        {
          value: "dest-sg",
          label: "Singapore",
          cities: [
            { value: "city-marina", label: "Marina Bay" },
            { value: "city-sentosa", label: "Sentosa Island" },
          ],
        },
      ],
    };
    const cities = extractCityOptions(nested);
    expect(citiesForDestination(cities, "dest-sg")).toHaveLength(2);
  });
});

describe("10. changing destination clears an incompatible city", () => {
  const cities = [
    { value: "city-marina", label: "Marina Bay", destinationValue: "dest-sg" },
    { value: "city-kuta", label: "Kuta", destinationValue: "dest-bali" },
  ];

  it("compatible city is kept, incompatible is cleared", () => {
    expect(isCompatibleCity(cities, "dest-sg", "city-marina")).toBe(true);
    expect(isCompatibleCity(cities, "dest-sg", "city-kuta")).toBe(false);
  });

  it("no linkage means free pairing (server validates)", () => {
    const free = [
      { value: "city-a", label: "A", destinationValue: null },
      { value: "city-b", label: "B", destinationValue: null },
    ];
    expect(isCompatibleCity(free, "dest-x", "city-a")).toBe(true);
    expect(citiesForDestination(free, "dest-x")).toHaveLength(2);
  });
});

describe("12+13. stable IDs preserved + payload mapping", () => {
  it("preserves Travel CRM IDs verbatim through defaults → draft → payload", () => {
    const defaults = normalizeItineraryDefaults([
      { destination: "dest-sg", city: "city-marina", nights: 4 },
      { destination: "dest-bali", city: "city-kuta", nights: 3 },
    ]);
    const draft = defaultsToDraftItinerary(defaults);
    expect(draft).toEqual([
      { country: "dest-sg", destination: "city-marina", nights: 4 },
      { country: "dest-bali", destination: "city-kuta", nights: 3 },
    ]);
    // Final payload shape expected by Travel CRM (existing contract):
    const payload = draft.map((row, i) => ({
      country: row.country,
      destination: row.destination,
      nights: row.nights,
      sequence: i + 1,
    }));
    expect(payload).toEqual([
      { country: "dest-sg", destination: "city-marina", nights: 4, sequence: 1 },
      { country: "dest-bali", destination: "city-kuta", nights: 3, sequence: 2 },
    ]);
  });

  it("draft → defaults round-trips without inventing names", () => {
    const back = draftToItineraryDefaults([
      { country: "dest-sg", destination: "city-marina", nights: 4 },
    ]);
    expect(back).toEqual([{ destination: "dest-sg", city: "city-marina", nights: 4 }]);
    expect(draftToItineraryDefaults([])).toEqual([]);
  });
});

describe("14. master-ID catalogs never mix with legacy display names", () => {
  // Regression: Travel CRM returns BOTH master IDs and legacy
  // display-name lists for backward compatibility. Merging them
  // produced two identical "Singapore" options (one by ID, one by
  // name); picking the legacy one emptied the City dropdown because
  // no city's destinationValue equals a display name.
  const SG_ID = "11111111-2222-3333-4444-555555555555";
  const SENTOSA_ID = "22222222-3333-4444-5555-666666666666";
  const MIXED = {
    destinations: [{ value: SG_ID, label: "Singapore" }],
    cities: [{ value: SENTOSA_ID, label: "Sentosa", destinationValue: SG_ID }],
    countries: ["Singapore", "Thailand"],
    leadSources: [],
  };

  it("1. Singapore destination loads exactly once, by ID", () => {
    const dests = extractDestinationOptions(MIXED);
    expect(dests).toEqual([
      { value: SG_ID, label: "Singapore", countryName: null, privateName: null },
    ]);
  });

  it("2. Singapore's cities are populated from linkage", () => {
    const built = buildItineraryLookups(MIXED);
    expect(built.cities).toEqual([
      { value: SENTOSA_ID, label: "Sentosa", destinationValue: SG_ID },
    ]);
    expect(citiesForDestination(built.cities, SG_ID).map((c) => c.value)).toEqual([SENTOSA_ID]);
  });

  it("3. city filtering uses the destination ID, not the name", () => {
    const built = buildItineraryLookups(MIXED);
    // Legacy display name matches nothing — the linkage is ID-based.
    expect(citiesForDestination(built.cities, "Singapore")).toEqual([]);
    expect(citiesForDestination(built.cities, SG_ID)).toHaveLength(1);
  });

  it("legacy lists still work when no master catalog exists (old servers)", () => {
    expect(extractDestinationOptions({ countries: ["Singapore"] })).toEqual([
      { value: "Singapore", label: "Singapore", countryName: null, privateName: null },
    ]);
    const free = extractCityOptions({ cities: ["Delhi", "Mumbai"] });
    expect(citiesForDestination(free, "anything")).toHaveLength(2);
  });
});

describe("15. ID storage with label display", () => {
  const SG_ID = "11111111-2222-3333-4444-555555555555";
  const SENTOSA_ID = "22222222-3333-4444-5555-666666666666";
  const DESTINATIONS = [{ value: SG_ID, label: "Singapore" }];
  const CITIES = [{ value: SENTOSA_ID, label: "Sentosa", destinationValue: SG_ID }];

  it("4. selected destination resolves to 'Singapore', not the UUID", () => {
    expect(destinationLabelForValue(DESTINATIONS, SG_ID)).toBe("Singapore");
  });

  it("5. selected city resolves to its name, not the UUID", () => {
    expect(cityLabelForValue(CITIES, SENTOSA_ID)).toBe("Sentosa");
  });

  it("6. saved UUID values rehydrate to labels per row", () => {
    const saved = [
      { destination: SG_ID, city: SENTOSA_ID, nights: 4 },
      { destination: SG_ID, city: SENTOSA_ID, nights: 2 },
    ];
    const labels = saved.map((r) => ({
      destination: destinationLabelForValue(DESTINATIONS, r.destination),
      city: cityLabelForValue(citiesForDestination(CITIES, r.destination), r.city),
    }));
    expect(labels).toEqual([
      { destination: "Singapore", city: "Sentosa" },
      { destination: "Singapore", city: "Sentosa" },
    ]);
  });

  it("8. multiple rows keep each row's correct labels", () => {
    const BALI_ID = "33333333-4444-5555-6666-777777777777";
    const KUTA_ID = "44444444-5555-6666-7777-888888888888";
    const dests = [...DESTINATIONS, { value: BALI_ID, label: "Bali" }];
    const cities = [...CITIES, { value: KUTA_ID, label: "Kuta", destinationValue: BALI_ID }];
    const rows = [
      { destination: SG_ID, city: SENTOSA_ID },
      { destination: BALI_ID, city: KUTA_ID },
    ];
    expect(
      rows.map((r) => ({
        destination: destinationLabelForValue(dests, r.destination),
        city: cityLabelForValue(citiesForDestination(cities, r.destination), r.city),
      })),
    ).toEqual([
      { destination: "Singapore", city: "Sentosa" },
      { destination: "Bali", city: "Kuta" },
    ]);
  });

  it("9. persisted payload still contains IDs", () => {
    const draft = defaultsToDraftItinerary([
      { destination: SG_ID, city: SENTOSA_ID, nights: 4 },
    ]);
    expect(draft).toEqual([{ country: SG_ID, destination: SENTOSA_ID, nights: 4 }]);
  });

  it("10. invalid stored IDs resolve to null (fallback, never UUID text)", () => {
    expect(destinationLabelForValue(DESTINATIONS, "dead-id")).toBeNull();
    expect(cityLabelForValue(CITIES, "dead-id")).toBeNull();
    expect(resolveSelectValue(DESTINATIONS, "dead-id")).toBeUndefined();
    expect(resolveSelectValue(CITIES, "dead-id")).toBeUndefined();
    // Matched IDs pass through untouched for Select state.
    expect(resolveSelectValue(DESTINATIONS, SG_ID)).toBe(SG_ID);
    expect(resolveSelectValue([], "")).toBeUndefined();
  });
});
