import { describe, expect, it } from "vitest";

import { buildDialogInputs } from "./travel-crm-action";
import { TRAVEL_CRM_SERVICE_LABELS } from "@/lib/integrations/travel-crm/services";

// ---------------------------------------------------------------------------
// Services section visibility — the multi-select always renders every
// supported service option in the Create in Travel CRM dialog, never
// filtered by the per-flow Settings configuration. Prefilled services
// (flow defaults or lead data) arrive pre-checked; all six stay
// independently toggleable.
// ---------------------------------------------------------------------------

const LIVE_OPTIONS = {
  leadSource: null,
  leadType: null,
  leadStage: null,
  services: [
    { value: "CRUISE", label: "Cruise" },
    { value: "FLIGHT", label: "Flight" },
    { value: "HOTEL", label: "Hotel" },
    { value: "SIGHTSEEING", label: "Sightseeing" },
  ],
};

function mapping(over: Partial<{
  available: string[];
  missing: string[];
}> = {}) {
  return {
    available: over.available ?? [],
    missing: over.missing ?? [],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
}

describe("Services section appears in the completion dialog", () => {
  it("6. renders for flow-defaulted services even when mapping is available", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["assignedToEmail"] }),
      {
        services: ["HOTEL", "SIGHTSEEING"],
        assignedToEmail: null,
      },
      LIVE_OPTIONS,
      "assignment-required",
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services).toBeDefined();
    expect(services?.kind).toBe("multi");
    // Prefilled defaults ride along as the input value.
    expect(services?.value).toEqual(["HOTEL", "SIGHTSEEING"]);
    // All six supported options render — never Settings-filtered.
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
  });

  it("2+3+4+5. each configured default is preselected; others are not", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["assignedToEmail"] }),
      { services: ["Cruise", "Flight", "Hotel"], assignedToEmail: null },
      LIVE_OPTIONS,
      "assignment-required",
    );
    // The input value carries exactly the configured labels —
    // nothing invented, nothing dropped.
    expect(inputs.find((i) => i.field === "services")?.value).toEqual([
      "Cruise",
      "Flight",
      "Hotel",
    ]);
  });

  it("still renders when the mapping needs services (no prefill)", () => {
    const inputs = buildDialogInputs(
      mapping({ missing: ["services"] }),
      { assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.value).toBeNull();
  });

  it("always renders, even when unneeded AND unprefilled", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services", "customerName"], missing: ["travelStartDate"] }),
      { assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
    expect(inputs.map((i) => i.field)).toContain("travelStartDate");
  });

  it("never re-asks email/rooms while showing services", () => {
    const inputs = buildDialogInputs(
      mapping({ available: ["services"], missing: ["email", "rooms"] }),
      { services: ["HOTEL"], assignedToEmail: "agent@acme.com" },
      LIVE_OPTIONS,
      null,
    );
    expect(inputs.find((i) => i.field === "services")?.kind).toBe("multi");
    expect(inputs.find((i) => i.field === "email")).toBeUndefined();
    expect(inputs.find((i) => i.field === "rooms")).toBeUndefined();
  });
});
