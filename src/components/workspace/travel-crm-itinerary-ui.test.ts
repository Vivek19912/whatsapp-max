import { describe, expect, it } from "vitest";

import {
  addItineraryRow,
  createEmptyItineraryRow,
  isEmptyItineraryRow,
  removeItineraryRow,
  updateItineraryDestination,
} from "./travel-crm-settings";
import {
  addItineraryDialogRow,
  buildDialogInputs,
  itineraryDialogRowsToOverrides,
  removeItineraryDialogRow,
  seedItineraryDialogRows,
  updateItineraryDialogDestination,
} from "./travel-crm-action";
import { validateNightsInput } from "@/lib/integrations/travel-crm/itineraries";

// ---------------------------------------------------------------------------
// Focused UI tests: Add More / Remove / nights validation / stable
// IDs / dialog prefill without mutating. Dialog rows carry
// Destination + Nights only (no per-row city — mirrors native
// Travel CRM); the Settings editor keeps its own city handling.
// ---------------------------------------------------------------------------

describe("6. Add More works (settings + dialog)", () => {
  it("settings appends a blank row", () => {
    expect(addItineraryRow([])).toEqual([{ destination: "", city: "", nights: "" }]);
    expect(
      addItineraryRow([{ destination: "d", city: "c", nights: "2" }]),
    ).toHaveLength(2);
  });

  it("dialog appends a blank row (Destination + Nights, no City)", () => {
    expect(addItineraryDialogRow([])).toEqual([{ destination: "", nights: "" }]);
    expect(addItineraryDialogRow([{ destination: "d", nights: "2" }])).toHaveLength(2);
  });
});

describe("7. Remove works (zero rows allowed)", () => {
  it("settings removes the indexed row, allowing empty", () => {
    const rows = [
      { destination: "d1", city: "c1", nights: "2" },
      { destination: "d2", city: "c2", nights: "3" },
    ];
    expect(removeItineraryRow(rows, 0)).toEqual([
      { destination: "d2", city: "c2", nights: "3" },
    ]);
    expect(removeItineraryRow(rows, 1)).toHaveLength(1);
    expect(removeItineraryRow([rows[0]], 0)).toEqual([]);
  });

  it("dialog removes the indexed row, allowing empty", () => {
    expect(
      removeItineraryDialogRow([{ destination: "d", nights: "2" }], 0),
    ).toEqual([]);
  });

  it("empty rows are droppable on save", () => {
    expect(isEmptyItineraryRow(createEmptyItineraryRow())).toBe(true);
    expect(isEmptyItineraryRow({ destination: "d", city: "", nights: "" })).toBe(false);
  });
});

describe("9+10. destination change keeps the row (no city to clear)", () => {
  it("settings clears an incompatible city on destination change", () => {
    const CITIES = [
      { value: "city-marina", destinationValue: "dest-sg" },
      { value: "city-sentosa", destinationValue: "dest-sg" },
      { value: "city-kuta", destinationValue: "dest-bali" },
    ];
    const rows = [{ destination: "dest-sg", city: "city-marina", nights: "4" }];
    const kept = updateItineraryDestination(rows, 0, "dest-sg", CITIES);
    expect(kept[0].city).toBe("city-marina");
    const cleared = updateItineraryDestination(rows, 0, "dest-bali", CITIES);
    expect(cleared).toEqual([{ destination: "dest-bali", city: "", nights: "4" }]);
    // Input never mutated.
    expect(rows).toEqual([{ destination: "dest-sg", city: "city-marina", nights: "4" }]);
  });

  it("dialog sets the destination and preserves nights (no city field)", () => {
    const rows = [{ destination: "dest-sg", nights: "4" }];
    expect(updateItineraryDialogDestination(rows, 0, "dest-bali")).toEqual([
      { destination: "dest-bali", nights: "4" },
    ]);
    // Input never mutated.
    expect(rows).toEqual([{ destination: "dest-sg", nights: "4" }]);
  });
});

describe("11. nights validation in UI helpers", () => {
  it("rejects bad nights when building overrides", () => {
    expect(() =>
      itineraryDialogRowsToOverrides([{ destination: "d", nights: "0" }]),
    ).toThrow();
    expect(validateNightsInput("two")).not.toBeNull();
    expect(itineraryDialogRowsToOverrides([{ destination: "d", nights: "3" }])).toEqual([
      { destination: "d", nights: 3 },
    ]);
  });

  it("city-less rows build overrides with destination + nights only", () => {
    expect(
      itineraryDialogRowsToOverrides([
        { destination: "d1", nights: "3" },
        { destination: "", nights: "" },
        { destination: "d2", nights: "4" },
      ]),
    ).toEqual([
      { destination: "d1", nights: 3 },
      { destination: "d2", nights: 4 },
    ]);
  });
});

describe("4+5+12. dialog prefill keeps stable IDs, edits don't mutate", () => {
  it("seeds dialog rows verbatim from prefill (Workspace defaults)", () => {
    const prefill = {
      itinerary: [
        { destination: "dest-sg", city: "city-marina", nights: 4 },
        { destination: "dest-sg", city: "city-sentosa", nights: 3 },
      ],
    };
    // City is not seeded: the dialog collects Destination + Nights
    // only, so a prefilled city never lingers as hidden state.
    expect(seedItineraryDialogRows(prefill)).toEqual([
      { destination: "dest-sg", nights: "4" },
      { destination: "dest-sg", nights: "3" },
    ]);
  });

  it("empty prefill seeds empty (no invented itinerary)", () => {
    expect(seedItineraryDialogRows({})).toEqual([]);
    expect(seedItineraryDialogRows({ itinerary: [] })).toEqual([]);
  });

  it("buildDialogInputs includes the itinerary editor when prefilled", () => {
    const inputs = buildDialogInputs(
      { available: ["customerName"], missing: ["leadType"], ambiguous: [], invalid: [], ready: false },
      {
        itinerary: [{ destination: "dest-sg", city: "city-marina", nights: 4 }],
        assignedToEmail: "a@x.co",
      },
      null,
      null,
    );
    const itin = inputs.find((i) => i.field === "itinerary");
    expect(itin).toBeDefined();
    expect(itin?.kind).toBe("itinerary");
    expect(itin?.value).toEqual([{ destination: "dest-sg", nights: "4" }]);
  });

  it("buildDialogInputs shows an empty itinerary editor when itinerary is missing", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: ["itinerary"], ambiguous: [], invalid: [], ready: false },
      { assignedToEmail: "a@x.co" },
      null,
      null,
    );
    const itin = inputs.find((i) => i.field === "itinerary");
    expect(itin).toBeDefined();
    expect(itin?.value).toEqual([]);
  });

  it("editing rows never mutates the seeded defaults array", () => {
    const seeded = [{ destination: "dest-sg", nights: "4" }];
    const edited = updateItineraryDialogDestination(seeded, 0, "dest-bali");
    expect(edited[0]).toEqual({ destination: "dest-bali", nights: "4" });
    expect(seeded).toEqual([{ destination: "dest-sg", nights: "4" }]);
  });
});
