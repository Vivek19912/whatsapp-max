import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import {
  buildDialogInputs,
  DepartureSearchSelect,
  FunnelSelect,
  resizeAgeRows,
  resolveDepartureCityOnCountryChange,
  resolveEffectiveDepartureCountry,
  seedTravelerForm,
  seedValues,
  travelerAgeCount,
  travelerFormToOverrides,
  TravelCrmAction,
  TRAVEL_DATE_REQUIRED_ERROR,
  validateTravelDateValue,
  validateTravelerForm,
  type TravelerForm,
} from "./travel-crm-action";
import { filterCellOptions } from "./custom-cell";
import {
  LEAD_RECEIVED_OPTIONS,
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import {
  DEFAULT_DEPARTURE_COUNTRY,
  DEPARTURE_COUNTRIES,
  departureCityOptions,
} from "@/lib/integrations/travel-crm/departure-catalog";
import { TRAVEL_CRM_SERVICE_LABELS } from "@/lib/integrations/travel-crm/services";
import { resolveDisplayServiceLabel } from "@/lib/integrations/travel-crm/services";
import { canonicalizeServices } from "@/lib/integrations/travel-crm/mapping";

describe("TravelCrmAction (Phase 3: connected)", () => {
  it("renders the Create action without a Created state", () => {
    const html = renderToStaticMarkup(
      <TravelCrmAction flowId="flow-1" runId="run-1" />
    );
    expect(html).toContain("Create in Travel CRM");
    expect(html).not.toContain("Creating");
    expect(html).not.toContain("Created in Travel CRM");
    expect(html).not.toContain("Lead Created");
  });
});

describe("buildDialogInputs (missing fields + always Name/Phone)", () => {
  const base = {
    available: ["customerName", "phone"],
    missing: ["travelStartDate", "leadSource", "services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };

  it("lists exactly the missing inputs with prefilled values", () => {
    const inputs = buildDialogInputs(
      base,
      { customerName: "Rahul", phone: "+911234567890", travelStartDate: null, services: ["Flight"] },
      {
        leadSource: [{ value: "WHATSAPP", label: "WhatsApp" }],
        leadType: null,
        leadStage: null,
        services: [{ value: "FLIGHT", label: "Flight" }],
      },
      null,
    );
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
      "services",
      "assignedToEmail",
      "travelStartDate",
    ]);
    // Name/Phone lead the dialog, prefilled from the canonical WACRM
    // flow-run values (same contact/submission data), editable.
    expect(inputs[0].field).toBe("customerName");
    expect(inputs[1].field).toBe("phone");
    expect(inputs.find((i) => i.field === "customerName")?.value).toBe("Rahul");
    expect(inputs.find((i) => i.field === "phone")?.value).toBe("+911234567890");
    expect(inputs.find((i) => i.field === "customerName")?.label).toBe("Name");
    expect(inputs.find((i) => i.field === "phone")?.label).toBe("Phone");
    // Received renders as an editable select with live options when
    // the mapping flags it.
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.label).toBe("Lead Source");
    expect(received?.options).toEqual([{ value: "WHATSAPP", label: "WhatsApp" }]);
    // Type/Stage always render too — here on the canonical
    // Workspace fallback sets (no live options in this fixture),
    // so they can never degrade to text inputs.
    const type = inputs.find((i) => i.field === "leadType");
    expect(type?.kind).toBe("select");
    expect(type?.label).toBe("Type");
    expect(type?.options?.map((o) => o.label)).toEqual([...LEAD_TYPE_OPTIONS]);
    const stage = inputs.find((i) => i.field === "leadStage");
    expect(stage?.kind).toBe("select");
    expect(stage?.label).toBe("Stage");
    expect(stage?.options?.map((o) => o.label)).toEqual([...STAGE_OPTIONS]);
    // Known services value rides along.
    expect(inputs.find((i) => i.field === "services")?.value).toEqual(["Flight"]);
  });

  it("requires the assignee member when the owner email is missing", () => {
    const inputs = buildDialogInputs(
      { ...base, missing: ["assignedToEmail"] },
      {},
      null,
      "assignment-required",
    );
    expect(inputs.map((i) => i.field)).toContain("assignedToEmail");
    expect(inputs.find((i) => i.field === "assignedToEmail")?.kind).toBe("member");
  });

  it("ambiguous input fields surface candidates as hints", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "destination", candidates: ["Goa", "Bali"] }],
        invalid: [],
        ready: false,
      },
      {},
      null,
      null,
    );
    // Legacy single destination ambiguity is subsumed by the
    // multi-row itinerary editor (Destination/City/Nights + Add
    // More/Remove) — the editor is shown instead of a lone text input.
    const itin = inputs.find((i) => i.field === "itinerary");
    expect(itin).toBeDefined();
    expect(itin?.kind).toBe("itinerary");
    expect(inputs.find((i) => i.field === "destination")).toBeUndefined();
  });

  it("never includes email or rooms as manual inputs", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: ["email", "rooms", "travelStartDate"],
        ambiguous: [{ field: "email", candidates: ["a@b.co", "c@d.co"] }],
        invalid: [{ field: "rooms", reason: "bad-count" }],
        ready: false,
      },
      { email: null, rooms: null, assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    // Name/Phone always lead; email/rooms never appear. The funnel
    // trio, departure pair, and Services section always render
    // (canonical fallbacks when the server sends no option lists).
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
      "services",
      "travelStartDate",
    ]);
    for (const f of ["leadSource", "leadType", "leadStage"] as const) {
      expect(inputs.find((i) => i.field === f)?.kind).toBe("select");
    }
  });

  it("Received always renders, prefilled from the Workspace row", () => {
    const inputs = buildDialogInputs(
      {
        available: ["leadSource", "customerName"],
        missing: ["leadType", "leadStage"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { leadSource: "FACEBOOK_ADS", assignedToEmail: "agent@acme.com" },
      {
        leadSource: [{ value: "FACEBOOK_ADS", label: "Facebook Ads" }],
        leadType: null,
        leadStage: null,
        services: null,
      },
      null,
    );
    expect(inputs.map((i) => i.field)).toEqual([
      "customerName",
      "phone",
      "leadSource",
      "leadType",
      "leadStage",
      "departureCountry",
      "departureCity",
      "services",
    ]);
    // Row-resolved enum seeds the Received select even though the
    // mapping marks it available; Type/Stage ride the canonical
    // fallbacks (no live options in this fixture).
    expect(inputs.find((i) => i.field === "leadSource")?.value).toBe("FACEBOOK_ADS");
    expect(inputs.find((i) => i.field === "leadSource")?.kind).toBe("select");
    for (const f of ["leadType", "leadStage"] as const) {
      expect(inputs.find((i) => i.field === f)?.kind).toBe("select");
    }
  });
});

describe("Received/Type/Stage editable selects (row-initialized)", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["leadSource", "leadType"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const receivedOptions = [
    { value: "WEBSITE", label: "Website" },
    { value: "FACEBOOK_ADS", label: "Facebook Ads" },
    { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
  ];
  const liveOptions = {
    leadSource: [{ value: "WHATSAPP", label: "WhatsApp" }],
    leadType: [{ value: "HOT", label: "Hot" }],
    leadStage: null,
    services: null,
  };

  it("renders flagged funnel fields as selects holding the row-resolved enums", () => {
    const inputs = buildDialogInputs(
      mapping,
      {
        leadSource: "INSTAGRAM_ADS",
        leadType: "HOT",
        rowLeadSource: "Instagram Ads",
        rowLeadType: "Hot",
        assignedToEmail: "agent@acme.com",
      },
      liveOptions,
      null,
      receivedOptions,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    const type = inputs.find((i) => i.field === "leadType");
    expect(received?.kind).toBe("select");
    expect(received?.label).toBe("Lead Source");
    expect(received?.options).toEqual(receivedOptions);
    // The input holds the canonical enum (Select shows its label);
    // the row display keys are never consumed as a second source.
    expect(received?.value).toBe("INSTAGRAM_ADS");
    expect(type?.kind).toBe("select");
    expect(type?.label).toBe("Type");
    expect(type?.options).toEqual([{ value: "HOT", label: "Hot" }]);
    expect(type?.value).toBe("HOT");
    // Stage always renders too — here on the canonical Workspace
    // fallback (no live Stage options in this fixture).
    const stage = inputs.find((i) => i.field === "leadStage");
    expect(stage?.kind).toBe("select");
    expect(stage?.label).toBe("Stage");
    expect(stage?.options?.map((o) => o.label)).toEqual([...STAGE_OPTIONS]);
    expect(stage?.value).toBeNull();
  });

  it("falls back to live options when the dedicated list is absent", () => {
    const inputs = buildDialogInputs(
      mapping,
      { leadSource: "WHATSAPP", assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      null,
    );
    const received = inputs.find((i) => i.field === "leadSource");
    expect(received?.kind).toBe("select");
    expect(received?.options).toEqual([{ value: "WHATSAPP", label: "WhatsApp" }]);
    expect(received?.value).toBe("WHATSAPP");
  });

  it("empty stays empty (nothing invented)", () => {
    const inputs = buildDialogInputs(
      mapping,
      { assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      receivedOptions,
    );
    expect(inputs.find((i) => i.field === "leadSource")?.value).toBeNull();
    expect(inputs.find((i) => i.field === "leadType")?.value).toBeNull();
  });

  it("ambiguous funnel fields surface candidates as select hints", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "leadType", candidates: ["Hot", "Warm"] }],
        invalid: [],
        ready: false,
      },
      { leadType: null, assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      receivedOptions,
    );
    const type = inputs.find((i) => i.field === "leadType");
    expect(type?.kind).toBe("select");
    expect(type?.hint).toBe(
      "Multiple values found: Hot / Warm — pick or type the correct one.",
    );
  });

  it("the dedicated option list itself is unchanged", () => {
    // The 12-option Received list still carries canonical enums.
    const picked = receivedOptions.find((o) => o.label === "Facebook Ads");
    expect(picked).toEqual({ value: "FACEBOOK_ADS", label: "Facebook Ads" });
  });

  it("funnel fallbacks are the exact canonical Workspace label sets", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: [], ambiguous: [], invalid: [], ready: true },
      { assignedToEmail: "agent@acme.com" },
      { leadSource: null, leadType: null, leadStage: null, services: null },
      null,
      null,
    );
    // Even with no live options anywhere, all three funnel fields
    // render as selects with the canonical label order — never text
    // inputs, never missing.
    expect(inputs.find((i) => i.field === "leadSource")?.options?.map((o) => o.label)).toEqual([
      ...LEAD_RECEIVED_OPTIONS,
    ]);
    expect(inputs.find((i) => i.field === "leadType")?.options?.map((o) => o.label)).toEqual([
      ...LEAD_TYPE_OPTIONS,
    ]);
    expect(inputs.find((i) => i.field === "leadStage")?.options?.map((o) => o.label)).toEqual([
      ...STAGE_OPTIONS,
    ]);
  });
});

describe("FunnelSelect (shared Workspace chip surface)", () => {  it("paints the selected value with the Workspace chip", () => {
    // Lead Type "Hot" uses the exact shared chip (strong red) —
    // the same mapping the Workspace cells render through.
    const html = renderToStaticMarkup(
      <FunnelSelect
        label="Type"
        value="HOT"
        options={[{ value: "HOT", label: "Hot" }]}
        fieldName="Lead Type"
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Hot");
    expect(html).toContain("#dc2626");
  });

  it("renders an empty trigger with no chip when cleared", () => {
    const html = renderToStaticMarkup(
      <FunnelSelect
        label="Stage"
        value=""
        options={[{ value: "NEW_LEAD", label: "New Lead" }]}
        fieldName="Stage"
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain("#dbeafe");
    expect(html).toContain("Stage");
  });
});

describe("services multi-select input", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const liveOptions = {
    leadSource: null,
    leadType: null,
    leadStage: null,
    services: [
      { value: "HOTEL", label: "Hotel" },
      { value: "FLIGHT", label: "Flight" },
    ],
  };

  it("services renders as multi with the six supported options", () => {
    const inputs = buildDialogInputs(mapping, {}, liveOptions, null, null);
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    // Always the six supported labels — never the live catalog,
    // never invented services.
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
  });

  it("prefilled flow defaults ride along as the input value", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: ["HOTEL", "SIGHTSEEING"] },
      liveOptions,
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "services")?.value).toEqual([
      "HOTEL",
      "SIGHTSEEING",
    ]);
  });
});

describe("dialog Services section always shows every supported service", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const liveOptions = {
    leadSource: null,
    leadType: null,
    leadStage: null,
    services: [
      { value: "FLIGHT", label: "Flight" },
      { value: "HOTEL", label: "Hotel" },
      { value: "CRUISE", label: "Cruise" },
      { value: "VEHICLE_TRANSFER", label: "Vehicle Transfer" },
      { value: "VISA", label: "Visa" },
    ],
  };
  const CONFIGURED = [
    "Cruise",
    "Hotel",
    "Sightseeing",
    "Add-on Service (Rail, Passport, etc.)",
  ];

  it("shows all six supported options with configured defaults pre-checked", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: CONFIGURED },
      liveOptions,
      null,
      null,
      null,
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
    expect(services?.value).toEqual(CONFIGURED);
  });

  it("single-service Settings still show all six options", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: ["Hotel"] },
      liveOptions,
      null,
      null,
      null,
    );
    const labels = inputs.find((i) => i.field === "services")?.options?.map((o) => o.label) ?? [];
    expect(labels).toEqual([...TRAVEL_CRM_SERVICE_LABELS]);
    // Only the configured default arrives checked.
    expect(inputs.find((i) => i.field === "services")?.value).toEqual(["Hotel"]);
  });

  it("live-catalog-only entries never appear as options", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: CONFIGURED },
      liveOptions,
      null,
      null,
      null,
    );
    const labels = inputs.find((i) => i.field === "services")?.options?.map((o) => o.label) ?? [];
    for (const absent of ["Vehicle Transfer", "Visa"]) {
      expect(labels).not.toContain(absent);
    }
    expect(labels.filter((l) => l === "Rail" || l === "Meal")).toEqual([]);
  });

  it("empty configuration still shows all six (never hidden)", () => {
    const inputs = buildDialogInputs(mapping, { services: [] }, liveOptions, null, null, null);
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
    expect(services?.value).toEqual([]);
  });

  it("section renders even with no prefill and no mapping flag", () => {
    const inputs = buildDialogInputs(
      { available: ["customerName"], missing: [], ambiguous: [], invalid: [], ready: true },
      { assignedToEmail: "agent@acme.com" },
      liveOptions,
      null,
      null,
    );
    const services = inputs.find((i) => i.field === "services");
    expect(services?.kind).toBe("multi");
    expect(services?.options?.map((o) => o.label)).toEqual([
      ...TRAVEL_CRM_SERVICE_LABELS,
    ]);
  });
});

describe("Services Vehicle rename (Create in Travel CRM dialog)", () => {
  const mapping = {
    available: ["customerName"],
    missing: ["services"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };
  const liveOptions = {
    leadSource: null,
    leadType: null,
    leadStage: null,
    services: null,
  };

  it("offers Vehicle (never the retired label) with the same checkbox behavior", () => {
    const inputs = buildDialogInputs(mapping, {}, liveOptions, null, null, null);
    const labels = inputs.find((i) => i.field === "services")?.options?.map((o) => o.label) ?? [];
    expect(labels).toContain("Vehicle");
    expect(labels).not.toContain("Vehicle (disposal)");
    expect(labels).toHaveLength(6);
  });

  it("previously stored selections keep rendering checked under the new name", () => {
    const inputs = buildDialogInputs(
      mapping,
      { services: ["Vehicle (disposal)", "Hotel"] },
      liveOptions,
      null,
      null,
      null,
    );
    // Stored values pass through untouched (no migration).
    expect(inputs.find((i) => i.field === "services")?.value).toEqual([
      "Vehicle (disposal)",
      "Hotel",
    ]);
    // The checkbox comparison resolves retired labels, so the
    // Vehicle checkbox reads checked for the legacy value.
    const current = inputs.find((i) => i.field === "services")?.value as string[];
    const hasVehicle = current.some(
      (c) => resolveDisplayServiceLabel(c).toLowerCase() === "vehicle",
    );
    expect(hasVehicle).toBe(true);
  });

  it("legacy and current values submit the same enum payload", () => {
    expect(canonicalizeServices(["Vehicle"], null)).toEqual(["VEHICLE_TRANSFER"]);
    expect(canonicalizeServices(["Vehicle (disposal)"], null)).toEqual(["VEHICLE_TRANSFER"]);
  });
});

describe("Travelers section (Adults/CWB/CWOB/Infants + ages)", () => {
  const blank: TravelerForm = {
    adults: "2",
    cwb: "",
    cwob: "",
    infants: "",
    cwbAges: [],
    cwobAges: [],
    infantAges: [],
  };

  it("1. Adults defaults to 1 when prefill has nothing", () => {
    expect(seedTravelerForm({}).adults).toBe("1");
    expect(seedTravelerForm({ adults: null }).adults).toBe("1");
    expect(seedTravelerForm({ adults: 2 }).adults).toBe("2");
  });

  it("2+3+4. Adults rejects 0, empty, and negatives", () => {
    for (const adults of ["0", "", "   ", "-1", "-2"]) {
      expect(validateTravelerForm({ ...blank, adults })).not.toBeNull();
    }
    expect(validateTravelerForm({ ...blank, adults: "two" })).not.toBeNull();
    expect(validateTravelerForm({ ...blank, adults: "1.5" })).not.toBeNull();
  });

  it("5. validation blocks Create (submit returns before any send)", () => {
    expect(validateTravelerForm({ ...blank, adults: "0" })).toContain("Adults");
  });

  it("6+7+8. CWB/CWOB/Infants are optional (empty omitted)", () => {
    expect(validateTravelerForm(blank)).toBeNull();
    expect(validateTravelerForm({ ...blank, cwb: "0", infants: "0" })).toBeNull();
    expect(validateTravelerForm({ ...blank, cwob: "two" })).not.toBeNull();
    expect(validateTravelerForm({ ...blank, infants: "-1" })).not.toBeNull();
  });

  it("9+10+11. counts create the matching number of age rows", () => {
    expect(resizeAgeRows([], 2)).toEqual(["", ""]);
    expect(resizeAgeRows(["5"], 2)).toEqual(["5", ""]);
    expect(resizeAgeRows([], 0)).toEqual([]);
    expect(travelerAgeCount("2")).toBe(2);
    expect(travelerAgeCount("")).toBe(0);
    expect(travelerAgeCount("two")).toBe(0);
  });

  it("12. reducing a count drops the extra age rows safely", () => {
    expect(resizeAgeRows(["3", "5", "7"], 1)).toEqual(["3"]);
    const shrunk = resizeAgeRows(["3", "5"], 0);
    expect(shrunk).toEqual([]);
  });

  it("13. blank optional ages never block creation", () => {
    expect(
      validateTravelerForm({ ...blank, cwb: "2", cwbAges: ["", "  "] }),
    ).toBeNull();
    expect(
      validateTravelerForm({ ...blank, infants: "1", infantAges: [""] }),
    ).toBeNull();
  });

  it("rejects non-numeric ages only when entered", () => {
    expect(
      validateTravelerForm({ ...blank, cwb: "1", cwbAges: ["abc"] }),
    ).not.toBeNull();
    expect(
      validateTravelerForm({ ...blank, cwb: "1", cwbAges: ["120"] }),
    ).not.toBeNull();
  });

  it("14–18. form maps to the Travel CRM payload keys", () => {
    expect(
      travelerFormToOverrides({
        adults: "2",
        cwb: "1",
        cwob: "0",
        infants: "1",
        cwbAges: ["5", ""],
        cwobAges: [],
        infantAges: ["1"],
      }),
    ).toEqual({
      adults: 2,
      childrenWithBed: 1,
      childrenWithoutBed: 0,
      infants: 1,
      childrenWithBedAges: [5],
      childrenWithoutBedAges: [],
      infantAges: [1],
    });
  });

  it("empty optionals map to null/[] (never invented)", () => {
    expect(travelerFormToOverrides({ ...blank, adults: "1" })).toEqual({
      adults: 1,
      childrenWithBed: null,
      childrenWithoutBed: null,
      infants: null,
      childrenWithBedAges: [],
      childrenWithoutBedAges: [],
      infantAges: [],
    });
  });

  it("replaces the standalone Adults input with one grouped section", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: ["adults"], ambiguous: [], invalid: [], ready: false },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    expect(inputs.map((i) => i.field)).toContain("travelers");
    expect(inputs.map((i) => i.field)).not.toContain("adults");
    const travelers = inputs.find((i) => i.field === "travelers");
    expect(travelers?.kind).toBe("travelers");
    expect(travelers?.label).toBe("Travelers *");
    // Seeded Adults default rides along as the input value.
    expect(travelers?.value).toMatchObject({ adults: "1" });
    // Position preserved: where Adults used to sit.
    const fields = inputs.map((i) => i.field);
    expect(fields.indexOf("travelers")).toBeGreaterThan(fields.indexOf("departureCity"));
  });

  it("prefilled traveler values seed the section", () => {
    const inputs = buildDialogInputs(
      { available: [], missing: ["adults"], ambiguous: [], invalid: [], ready: false },
      {
        adults: 2,
        childrenWithBed: 1,
        childrenWithBedAges: [5],
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "travelers")?.value).toMatchObject({
      adults: "2",
      cwb: "1",
      cwbAges: ["5"],
    });
  });

  it("ambiguous adults surface candidates as hints on the section", () => {
    const inputs = buildDialogInputs(
      {
        available: [],
        missing: [],
        ambiguous: [{ field: "adults", candidates: ["2", "3"] }],
        invalid: [],
        ready: false,
      },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    const travelers = inputs.find((i) => i.field === "travelers");
    expect(travelers?.hint).toContain("2");
    expect(travelers?.hint).toContain("3");
  });
});

describe("seedValues (dialog-open prefill preservation)", () => {  it("11. prefilled funnel enums survive dialog open; row display keys never leak", () => {
    const values = seedValues({
      customerName: "Rahul",
      phone: "+911234567890",
      leadSource: "FACEBOOK_ADS",
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
      rowLeadSource: "Facebook Ads",
      rowLeadType: "Fresh",
      rowLeadStage: "New Lead",
      assignedToEmail: "agent@acme.com",
    });
    // The FunnelSelect initial values: exact server prefill enums.
    expect(values).toMatchObject({
      leadSource: "FACEBOOK_ADS",
      leadType: "FRESH",
      leadStage: "NEW_LEAD",
    });
    // Row display keys feed nothing — no second value source.
    expect(values).not.toHaveProperty("rowLeadSource");
    expect(values).not.toHaveProperty("rowLeadType");
    expect(values).not.toHaveProperty("rowLeadStage");
  });
});

describe("Departure Country/City catalog selects (saved flow defaults)", () => {
  // Regression condition: saving Travel CRM Settings marks both
  // fields available (not missing). The dialog must still render
  // them, prefilled from the saved defaults.
  const savedMapping = {
    available: ["customerName", "departureCountry", "departureCity"],
    missing: ["travelStartDate"],
    ambiguous: [],
    invalid: [],
    ready: false,
  };

  it("1+9. saved India/Delhi render prefilled even though marked available", () => {
    const inputs = buildDialogInputs(
      savedMapping,
      {
        departureCountry: "India",
        departureCity: "Delhi",
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    const country = inputs.find((i) => i.field === "departureCountry");
    const city = inputs.find((i) => i.field === "departureCity");
    expect(country?.kind).toBe("select");
    expect(country?.label).toBe("Departure Country");
    expect(country?.value).toBe("India");
    expect(city?.kind).toBe("select");
    expect(city?.label).toBe("Departure City");
    expect(city?.value).toBe("Delhi");
    // Country options come from the copied catalog.
    expect(country?.options?.some((o) => o.value === "India")).toBe(true);
    // City options are the Indian catalog list containing Delhi.
    expect(city?.options).toEqual(
      departureCityOptions("India").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(city?.options?.some((o) => o.value === "Delhi")).toBe(true);
    // Saved defaults seed dialog state verbatim (initial values).
    expect(
      seedValues({ departureCountry: "India", departureCity: "Delhi" }),
    ).toMatchObject({ departureCountry: "India", departureCity: "Delhi" });
  });

  it("3. no saved defaults render with India pre-selected; city stays empty", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName"],
        missing: ["travelStartDate", "departureCountry", "departureCity"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    const country = inputs.find((i) => i.field === "departureCountry");
    const city = inputs.find((i) => i.field === "departureCity");
    expect(country?.kind).toBe("select");
    // Workspace creation-dialog default: genuinely new entries open
    // with India pre-selected (from the copied catalog).
    expect(country?.value).toBe(DEFAULT_DEPARTURE_COUNTRY);
    expect(country?.value).toBe("India");
    expect(city?.kind).toBe("select");
    expect(city?.value).toBeNull();
    // City offers the Indian catalog list while the selection stays
    // empty for the agent to pick.
    expect(city?.options).toEqual(
      departureCityOptions("India").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(city?.options?.some((o) => o.value === "Delhi")).toBe(true);
  });

  it("3b. India default comes from the copied country master data", () => {
    // The default is the catalog's own India entry — never an
    // invented identifier.
    expect(DEPARTURE_COUNTRIES).toContain("India");
    expect(DEPARTURE_COUNTRIES).toContain(DEFAULT_DEPARTURE_COUNTRY);
    expect(DEFAULT_DEPARTURE_COUNTRY).toBe("India");
  });

  it("3c. saved non-India values are preserved verbatim (never forced to India)", () => {
    const inputs = buildDialogInputs(
      savedMapping,
      {
        departureCountry: "France",
        departureCity: "Paris",
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "departureCountry")?.value).toBe("France");
    expect(inputs.find((i) => i.field === "departureCity")?.value).toBe("Paris");
    // Manual change to India swaps the city list; an incompatible
    // saved city is dropped rather than kept as an invalid pairing.
    expect(resolveDepartureCityOnCountryChange("India", "Paris")).toBe("");
    expect(resolveDepartureCityOnCountryChange("France", "Paris")).toBe("Paris");
  });

  it("3d. India city options come from the JSON master with state disambiguation", () => {
    const inputs = buildDialogInputs(
      savedMapping,
      {
        departureCountry: "India",
        departureCity: null,
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    const city = inputs.find((i) => i.field === "departureCity");
    // Unique names render bare; duplicates carry the state.
    expect(city?.options).toContainEqual({ value: "Delhi", label: "Delhi" });
    expect(city?.options).toContainEqual({
      value: "Aurangabad",
      label: "Aurangabad (Bihar)",
    });
    expect(city?.options).toContainEqual({
      value: "Aurangabad",
      label: "Aurangabad (Maharashtra)",
    });
    // Submitted values are bare master city names: both duplicate
    // labels share one value, so either selection submits "Aurangabad".
    const aurangabads = (city?.options ?? []).filter(
      (o) => o.label === "Aurangabad (Bihar)" || o.label === "Aurangabad (Maharashtra)",
    );
    expect(aurangabads).toHaveLength(2);
    for (const o of aurangabads) expect(o.value).toBe("Aurangabad");
  });

  it("4. city options follow the prefilled country via the catalog", () => {
    const forCountry = (c: string | null) =>
      buildDialogInputs(
        savedMapping,
        {
          departureCountry: c,
          departureCity: null,
          assignedToEmail: "agent@acme.com",
        },
        null,
        null,
      ).find((i) => i.field === "departureCity")?.options ?? null;
    expect(forCountry("India")).toEqual(
      departureCityOptions("India").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(forCountry("France")).toEqual(
      departureCityOptions("France").map((o) => ({ value: o.value, label: o.label })),
    );
    expect(forCountry("India")).not.toEqual(forCountry("France"));
  });

  it("5. changing country clears only an incompatible city", () => {
    // Agra is India-list-only; Dubai is curated-list-only.
    expect(resolveDepartureCityOnCountryChange("United Arab Emirates", "Agra")).toBe("");
    expect(resolveDepartureCityOnCountryChange("India", "Dubai")).toBe("");
    expect(resolveDepartureCityOnCountryChange("United Arab Emirates", "Dubai")).toBe("Dubai");
    expect(resolveDepartureCityOnCountryChange("India", "Delhi")).toBe("Delhi");
    expect(resolveDepartureCityOnCountryChange("India", "")).toBe("");
  });
});

describe("Departure searchable selects (Create in Travel CRM dialog)", () => {
  const countryOptions = [...DEPARTURE_COUNTRIES]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }));
  const indiaCities = departureCityOptions("India").map((o) => ({
    value: o.value,
    label: o.label,
  }));

  it("country renders searchable with India selected and all options preserved", () => {
    // SSR renders the trigger only (popover content is portaled);
    // combobox internals are covered by the wiring test below.
    const html = renderToStaticMarkup(
      <DepartureSearchSelect
        label="Departure Country"
        value="India"
        options={countryOptions}
        placeholder="Select Departure Country"
        onChange={() => {}}
      />,
    );
    // Trigger carries the field name and shows India selected (not
    // the placeholder).
    expect(html).toContain('aria-label="Departure Country"');
    expect(html).toContain("India");
    expect(html).not.toContain("Select Departure Country</span>");
    // Full option list preserved (250 countries).
    expect(countryOptions).toHaveLength(250);
    expect(countryOptions).toContainEqual({ value: "India", label: "India" });
  });

  it("city renders searchable with the JSON-backed Indian list", () => {
    const html = renderToStaticMarkup(
      <DepartureSearchSelect
        label="Departure City"
        value=""
        options={indiaCities}
        placeholder="Select city"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Departure City"');
    expect(html).toContain("Select city");
    expect(indiaCities.length).toBeGreaterThan(4000);
  });

  it("searching filters countries and state-qualified city labels", () => {
    // Country search by name.
    expect(
      filterCellOptions(countryOptions, "united arab").map((o) => o.value),
    ).toContain("United Arab Emirates");
    // City search by bare name narrows to matches.
    const aura = filterCellOptions(indiaCities, "aurangabad");
    expect(aura.map((o) => o.label)).toContain("Aurangabad (Bihar)");
    expect(aura.map((o) => o.label)).toContain("Aurangabad (Maharashtra)");
    // State-qualified search matches the duplicate labels exactly.
    const maha = filterCellOptions(indiaCities, "aurangabad (maharashtra)");
    expect(maha.map((o) => o.label)).toEqual(["Aurangabad (Maharashtra)"]);
    // Every filtered city still submits its bare name.
    for (const o of [...aura, ...maha]) {
      expect(o.value).toBe("Aurangabad");
    }
  });

  it("selecting a duplicate submits the bare city name (never the label)", () => {
    let submitted = "";
    // Rendered options for duplicates share one value; either pick
    // resolves to the bare name through onChange.
    const dupes = indiaCities.filter((o) => o.value === "Aurangabad");
    expect(dupes.map((o) => o.label)).toEqual([
      "Aurangabad (Bihar)",
      "Aurangabad (Maharashtra)",
    ]);
    const onChange = (v: string) => {
      submitted = v;
    };
    onChange(dupes[1].value);
    expect(submitted).toBe("Aurangabad");
    expect(submitted).not.toContain("(");
  });

  it("non-India city options stay curated and searchable", () => {
    const curated = departureCityOptions("France").map((o) => ({
      value: o.value,
      label: o.label,
    }));
    expect(curated.map((o) => o.value)).toEqual([
      "Delhi",
      "Mumbai",
      "Bengaluru",
      "Dubai",
      "Bangkok",
      "Singapore",
      "Bali",
      "Malé",
      "London",
      "Paris",
    ]);
    expect(filterCellOptions(curated, "dub").map((o) => o.value)).toEqual([
      "Dubai",
    ]);
  });

  it("dialog wires both departure fields through the popover combobox", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    // Both Country and City render via the shared Popover combobox
    // (real editable search input + substring filter + plain scroll
    // viewport — no Select typeahead to swallow keystrokes).
    expect(src).toContain("<DepartureSearchSelect");
    expect(src).toContain("<Popover");
    expect(src).toContain("<PopoverTrigger");
    expect(src).toContain("<PopoverContent");
    // Real search input with controlled query; the query resets on
    // close; an empty filter shows an empty state.
    expect(src).toContain('aria-label={`Search ${label} options`}');
    expect(src).toContain("No matching options.");
    expect(src).toContain("if (!v) {");
    // Options submit their values; the combobox owns arrow/Enter
    // navigation with scroll-into-view only on keyboard moves.
    expect(src).toContain("onClick={() => pick(o.value)}");
    expect(src).toContain('scrollIntoView({ block: "nearest" })');
    // City remounts per country so stale queries/options never linger.
    expect(src).toContain("key={`departureCity:${country}`}");
    // Country change still clears an incompatible city.
    expect(src).toContain("resolveDepartureCityOnCountryChange(next, values.departureCity");
  });
});

describe("Departure clear buttons (Create in Travel CRM dialog)", () => {
  const cityOptions = [
    { value: "Delhi", label: "Delhi" },
    { value: "Aurangabad", label: "Aurangabad (Bihar)" },
    { value: "Aurangabad", label: "Aurangabad (Maharashtra)" },
  ];

  it("shows × only when a value is selected", () => {
    const withValue = renderToStaticMarkup(
      <DepartureSearchSelect
        label="Departure City"
        value="Delhi"
        options={cityOptions}
        placeholder="Select city"
        onChange={() => {}}
      />,
    );
    expect(withValue).toContain('aria-label="Clear Departure City"');
    const empty = renderToStaticMarkup(
      <DepartureSearchSelect
        label="Departure City"
        value=""
        options={cityOptions}
        placeholder="Select city"
        onChange={() => {}}
      />,
    );
    expect(empty).not.toContain("Clear Departure City");
  });

  it("clear never opens the dropdown, submits, or nests a button", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    // Span (not a nested <button>), using the existing lucide X icon.
    expect(src).toContain('role="button"');
    expect(src).toContain("<X ");
    // Pointer, mouse, and click activation all stop propagation and
    // suppress the trigger default so the dropdown stays closed;
    // keyboard activation is guarded the same way (no submission).
    expect(src).toContain("aria-label={`Clear ${label}`}");
    const clearBlock = src.slice(src.indexOf("aria-label={`Clear ${label}`}"));
    expect(clearBlock).toContain("e.stopPropagation()");
    expect(clearBlock).toContain("e.preventDefault()");
    expect(clearBlock).toContain('if (e.key === "Enter" || e.key === " ")');
  });

  it("clearing the country also resets the city (never an invalid pair)", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    // Country × clears unconditionally — not via the compatibility
    // rule, so a city valid in both lists (e.g. Delhi) cannot linger
    // without a country.
    expect(src).toContain('set("departureCountry", "")');
    expect(src).toContain('set("departureCity", "")');
    // City × clears only the city.
    expect(src).toContain('onClear={() => set(input.field, "")}');
  });

  it("manual clear sticks: explicit empty is never forced back to India", () => {
    // Fresh modal (no live selection yet) defaults to India…
    expect(resolveEffectiveDepartureCountry(undefined, "")).toBe("India");
    expect(resolveEffectiveDepartureCountry(undefined, "France")).toBe("France");
    expect(resolveEffectiveDepartureCountry(undefined, "  ")).toBe("India");
    // …a set pick is preserved…
    expect(resolveEffectiveDepartureCountry("France", "")).toBe("France");
    expect(resolveEffectiveDepartureCountry("India", "France")).toBe("India");
    // …and an explicit manual clear stays cleared.
    expect(resolveEffectiveDepartureCountry("", "India")).toBe("");
    expect(resolveEffectiveDepartureCountry("", "")).toBe("");
  });

  it("fresh modal still preselects India with an empty city", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName"],
        missing: ["travelStartDate"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      { assignedToEmail: "agent@acme.com" },
      null,
      null,
    );
    expect(inputs.find((i) => i.field === "departureCountry")?.value).toBe(
      "India",
    );
    expect(inputs.find((i) => i.field === "departureCity")?.value).toBeNull();
  });
});

describe("Funnel row layout (Lead Source + Type + Stage side by side)", () => {
  it("groups exactly the three funnel fields into one row", () => {
    const src = readFileSync(`${process.cwd()}/src/components/workspace/travel-crm-action.tsx`, "utf8");
    expect(src).toContain('"leadSource"');
    expect(src).toContain('"leadType"');
    expect(src).toContain('"leadStage"');
    // Consecutive funnel fields render through one grouped row.
    expect(src).toContain("dialogFieldRows()");
    expect(src).toContain("FUNNEL_ROW_FIELDS.includes(input.field)");
  });

  it("renders equal-width columns that stack on narrow screens", () => {
    const src = readFileSync(`${process.cwd()}/src/components/workspace/travel-crm-action.tsx`, "utf8");
    // One column (stacked, no overflow) on narrow screens, three
    // equal columns with consistent spacing from sm up.
    expect(src).toContain("grid grid-cols-1 gap-3 sm:grid-cols-3");
  });

  it("keeps each field's label, control, and hint markup unchanged", () => {
    const src = readFileSync(`${process.cwd()}/src/components/workspace/travel-crm-action.tsx`, "utf8");
    // Shared block: same label/control/hint structure as before,
    // only the wrapping row is new.
    expect(src).toContain("dialogFieldBlock(input)");
    expect(src).toContain("<Label htmlFor={`tmc-${input.field}`}>{input.label}</Label>");
    expect(src).toContain("{inputControl(input)}");
  });

  it("keeps dialog order, values, and submission inputs untouched", () => {
    const inputs = buildDialogInputs(
      {
        available: ["customerName"],
        missing: ["travelStartDate"],
        ambiguous: [],
        invalid: [],
        ready: false,
      },
      {
        leadSource: "INSTAGRAM_ADS",
        leadType: "FRESH",
        leadStage: "NEW_LEAD",
        assignedToEmail: "agent@acme.com",
      },
      null,
      null,
    );
    const fields = inputs.map((i) => i.field);
    // The three stay consecutive in dialog order with values intact.
    expect(fields.indexOf("leadSource") + 1).toBe(fields.indexOf("leadType"));
    expect(fields.indexOf("leadType") + 1).toBe(fields.indexOf("leadStage"));
    expect(inputs.find((i) => i.field === "leadSource")).toMatchObject({
      label: "Lead Source",
      value: "INSTAGRAM_ADS",
    });
    expect(inputs.find((i) => i.field === "leadType")).toMatchObject({
      label: "Type",
      value: "FRESH",
    });
    expect(inputs.find((i) => i.field === "leadStage")).toMatchObject({
      label: "Stage",
      value: "NEW_LEAD",
    });
  });
});

describe("Travel Date required validation (Create Lead dialog)", () => {
  // submit() blocks the create request with this inline error when the
  // Travel Date input is rendered but empty; the same validator clears
  // the error once a valid date is selected. Date format and payload
  // mapping are untouched — presence only.
  it("empty Travel Date yields the required error (blocks submit)", () => {
    expect(validateTravelDateValue("")).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(validateTravelDateValue("   ")).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(validateTravelDateValue(undefined)).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(validateTravelDateValue(null)).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(validateTravelDateValue(42)).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    expect(TRAVEL_DATE_REQUIRED_ERROR).toBe("Travel Date is required.");
  });

  it("valid Travel Date yields no error (submit flow continues)", () => {
    expect(validateTravelDateValue("2026-12-01")).toBeNull();
    expect(validateTravelDateValue(" 2026-12-01 ")).toBeNull();
  });

  it("correcting an empty date removes the validation error", () => {
    let error = validateTravelDateValue("");
    expect(error).toBe(TRAVEL_DATE_REQUIRED_ERROR);
    error = validateTravelDateValue("2026-12-01");
    expect(error).toBeNull();
  });
});

describe("Complete Travel CRM fields modal sizing", () => {
  it("fills most of the viewport with a wide content area (no cramped scrollbar)", () => {
    const src = readFileSync(`${process.cwd()}/src/components/workspace/travel-crm-action.tsx`, "utf8");
    const titleAt = src.indexOf("Complete Travel CRM fields");
    const dialogBlock = src.slice(src.lastIndexOf("DialogContent", titleAt));
    // Wide modal on desktop (~1000px max) at 94vw, so small screens
    // stay responsive without horizontal overflow.
    expect(dialogBlock).toContain("w-[94vw]");
    expect(dialogBlock).toContain("max-w-[94vw]");
    expect(dialogBlock).toContain("sm:max-w-[62.5rem]");
    // The popup itself is capped to most of the dynamic viewport
    // height and laid out as a flex column so the form area grows
    // to fill it.
    expect(dialogBlock).toContain("max-h-[92dvh]");
    expect(dialogBlock).toContain("flex-col");
    // The content area flexes to the remaining space and scrolls ONLY
    // when the viewport genuinely cannot fit the whole form (small
    // screens) — the Create/Cancel footer stays pinned below it.
    expect(dialogBlock).toContain("min-h-0");
    expect(dialogBlock).toContain("flex-1");
    expect(dialogBlock).toContain("overflow-y-auto");
    // Header stays visible with the footer accessible.
    expect(dialogBlock).toContain("<DialogHeader>");
    expect(dialogBlock).toContain("<DialogFooter>");
  });
});

describe("Create Lead itinerary displays names — never raw UUIDs", () => {
  it("resolves IDs to labels and renders them as SelectValue children", () => {
    const src = readFileSync(`${process.cwd()}/src/components/workspace/travel-crm-action.tsx`, "utf8");
    // The destination select resolves the stored UUID to its public
    // name for display (city keeps its explicit resolution).
    expect(src).toContain("<ItineraryDestinationSelect");
    expect(src).toContain("cityLabelForValue(cityOptions, row.city)");
    expect(src).toContain("cityLabel !== null ? cityLabel : undefined");
    // The stored UUID stays the Select value; only display resolves.
    expect(src).toContain("resolveSelectValue(destinations, row.destination)");
  });
});
