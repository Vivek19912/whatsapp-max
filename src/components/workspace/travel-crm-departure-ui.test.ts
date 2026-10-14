import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Departure Defaults REMOVED from Travel CRM Settings — the dialog no
// longer manages saved departure defaults (services + itinerary
// defaults remain). Saved departure values in the database are left
// untouched: the save payload omits the departure key, which the
// settings API treats as "preserve stored values". The Create in
// Travel CRM dialog keeps its own working Departure Country/City
// controls with the India default.
// ---------------------------------------------------------------------------

const root = process.cwd();
const settingsSrc = readFileSync(
  `${root}/src/components/workspace/travel-crm-settings.tsx`,
  "utf8",
);

describe("Departure Defaults removed (Workspace → Travel CRM Settings)", () => {
  it("renders no Departure Defaults section or departure controls", () => {
    expect(settingsSrc).not.toContain("Departure Defaults");
    expect(settingsSrc).not.toContain('aria-label="Departure Country"');
    expect(settingsSrc).not.toContain('aria-label="Departure City"');
    expect(settingsSrc).not.toContain("Pick country first");
    expect(settingsSrc).not.toContain("dep-country");
    expect(settingsSrc).not.toContain("dep-city");
  });

  it("carries no departure UI state, validation, or save logic", () => {
    expect(settingsSrc).not.toContain("departureCountry");
    expect(settingsSrc).not.toContain("departureCity");
    expect(settingsSrc).not.toContain("DEPARTURE_COUNTRIES");
    expect(settingsSrc).not.toContain("departureCityOptions(");
    expect(settingsSrc).not.toContain("isDepartureCityInCountry");
    expect(settingsSrc).not.toContain("Select a departure country for the city.");
  });

  it("save omits departure so stored defaults are preserved, not wiped", () => {
    // The API preserves stored departure defaults when the key is
    // absent; sending null/empty would clear them instead.
    expect(settingsSrc).toContain(
      "body: JSON.stringify({ services: selected, itinerary })",
    );
    expect(settingsSrc).not.toContain("departure_country");
    expect(settingsSrc).not.toContain("departure_city");
  });

  it("services and itinerary defaults are untouched", () => {
    expect(settingsSrc).toContain("Default services");
    expect(settingsSrc).toContain("TRAVEL_CRM_SERVICE_LABELS");
    expect(settingsSrc).toContain("Itinerary Defaults");
    expect(settingsSrc).toContain("Add itinerary");
  });
});

describe("Create dialog keeps working departure controls (India default)", () => {
  const actionSrc = readFileSync(
    `${root}/src/components/workspace/travel-crm-action.tsx`,
    "utf8",
  );

  it("the creation dialog still owns Departure Country/City with India default", () => {
    expect(actionSrc).toContain("<DepartureSearchSelect");
    expect(actionSrc).toContain("DEFAULT_DEPARTURE_COUNTRY");
    expect(actionSrc).toContain("resolveDepartureCityOnCountryChange(next, values.departureCity");
    expect(actionSrc).toContain("key={`departureCity:${country}`}");
  });
});
