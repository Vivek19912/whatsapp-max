import { describe, expect, it } from "vitest";

import {
  TRAVEL_CRM_LEGACY_SERVICE_LABELS,
  TRAVEL_CRM_MAX_SERVICES,
  TRAVEL_CRM_SERVICE_LABELS,
  TRAVEL_CRM_SERVICE_VALUE_BY_LABEL,
  isOfferedServiceLabel,
  joinServiceLabels,
  normalizeServiceLabels,
  resolveDisplayServiceLabel,
  splitServiceLabels,
} from "./services";

describe("TRAVEL_CRM_SERVICE_LABELS", () => {
  it("offers exactly the six services in order", () => {
    expect([...TRAVEL_CRM_SERVICE_LABELS]).toEqual([
      "Cruise",
      "Flight",
      "Hotel",
      "Vehicle",
      "Sightseeing",
      "Add-on Service (Rail, Passport, etc.)",
    ]);
  });

  it("never offers the retired label", () => {
    expect([...TRAVEL_CRM_SERVICE_LABELS]).not.toContain("Vehicle (disposal)");
    expect([...TRAVEL_CRM_LEGACY_SERVICE_LABELS]).toEqual(["Vehicle (disposal)"]);
  });
});

describe("TRAVEL_CRM_SERVICE_VALUE_BY_LABEL", () => {
  it("maps every display label to its exact Travel CRM API enum", () => {
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Cruise"]).toBe("CRUISE");
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Flight"]).toBe("FLIGHT");
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Hotel"]).toBe("HOTEL");
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Vehicle"]).toBe("VEHICLE_TRANSFER");
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Sightseeing"]).toBe("SIGHTSEEING");
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Add-on Service (Rail, Passport, etc.)"]).toBe(
      "OTHER_ADD_ON",
    );
  });

  it("keeps resolving the retired label for previously stored values", () => {
    expect(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL["Vehicle (disposal)"]).toBe(
      "VEHICLE_TRANSFER",
    );
  });

  it("covers the six offered labels plus the retired alias (no drift)", () => {
    expect(Object.keys(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL).sort()).toEqual(
      [...TRAVEL_CRM_SERVICE_LABELS, ...TRAVEL_CRM_LEGACY_SERVICE_LABELS].sort(),
    );
  });
});

describe("normalizeServiceLabels", () => {
  it("trims, drops empties, dedupes case-insensitively preserving order", () => {
    expect(normalizeServiceLabels([" Hotel ", "hotel", "Flight", "", "  "])).toEqual([
      "Hotel",
      "Flight",
    ]);
    expect(normalizeServiceLabels([])).toEqual([]);
  });

  it("rejects non-lists, non-text, oversize input", () => {
    expect(() => normalizeServiceLabels("Hotel")).toThrow();
    expect(() => normalizeServiceLabels([42])).toThrow();
    expect(() =>
      normalizeServiceLabels(Array.from({ length: TRAVEL_CRM_MAX_SERVICES + 1 }, () => "Hotel")),
    ).toThrow();
    expect(() => normalizeServiceLabels(["x".repeat(81)])).toThrow();
  });
});

describe("isOfferedServiceLabel", () => {
  it("matches case-insensitively with trimming", () => {
    expect(isOfferedServiceLabel("hotel")).toBe(true);
    expect(isOfferedServiceLabel("Vehicle")).toBe(true);
    expect(isOfferedServiceLabel("Teleport")).toBe(false);
    expect(isOfferedServiceLabel("")).toBe(false);
  });

  it("keeps accepting the retired label from previously stored settings", () => {
    expect(isOfferedServiceLabel("  Vehicle (Disposal) ")).toBe(true);
  });
});

describe("resolveDisplayServiceLabel", () => {
  it("maps the retired label to the current name, passes the rest through", () => {
    expect(resolveDisplayServiceLabel("Vehicle (disposal)")).toBe("Vehicle");
    expect(resolveDisplayServiceLabel("  VEHICLE (DISPOSAL) ")).toBe("Vehicle");
    expect(resolveDisplayServiceLabel("Vehicle")).toBe("Vehicle");
    expect(resolveDisplayServiceLabel("Hotel")).toBe("Hotel");
    expect(resolveDisplayServiceLabel("Teleport")).toBe("Teleport");
  });
});

describe("split/joinServiceLabels (dialog value state)", () => {
  it("round-trips semicolon-joined values", () => {
    expect(splitServiceLabels("Hotel; Sightseeing")).toEqual(["Hotel", "Sightseeing"]);
    expect(splitServiceLabels("")).toEqual([]);
    expect(joinServiceLabels(["Hotel", "Flight"])).toBe("Hotel; Flight");
    expect(joinServiceLabels([])).toBe("");
  });
});
