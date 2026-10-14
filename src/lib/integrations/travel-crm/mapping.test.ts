import { describe, expect, it } from "vitest";

import {
  TRAVEL_CRM_REQUIRED_FIELDS,
  buildReceivedOptions,
  canonicalizeLeadSource,
  canonicalizeOptionLabel,
  canonicalizeServices,
  inferReceivedLabel,
  mapLeadToTravelCrm,
  normalizeFieldToken,
  type WacrmLeadSource,
} from "./mapping";

function source(overrides: Partial<WacrmLeadSource> = {}): WacrmLeadSource {
  return {
    contact: { name: null, phone: null, email: null },
    answers: [],
    custom: [],
    ...overrides,
  };
}

function full(): WacrmLeadSource {
  return source({
    contact: { name: "Rahul Sharma", phone: "+911234567890", email: "RAHUL@Example.COM " },
    answers: [
      { key: "travel_date", label: "Travel Date", value: "2026-12-01" },
      { key: "destination", label: "Destination", value: "Goa" },
      { key: "city", label: "City", value: "Panaji" },
      { key: "nights", label: "Nights", value: "3" },
      { key: "adults", label: "Adults", value: "2" },
      { key: "service", label: "Service", value: "Flight; Hotel" },
    ],
    custom: [],
  });
}

describe("normalizeFieldToken", () => {
  it("lowercases and strips separators deterministically", () => {
    expect(normalizeFieldToken("Phone No")).toBe("phoneno");
    expect(normalizeFieldToken("customer_source")).toBe("customersource");
    expect(normalizeFieldToken("Travel-Date")).toBe("traveldate");
    expect(normalizeFieldToken("Travel-Date")).toBe(normalizeFieldToken("travel date"));
  });
});

describe("contact-first mapping", () => {
  it("maps Name from the contact record", () => {
    const r = mapLeadToTravelCrm(source({ contact: { name: "Rahul", phone: null, email: null } }), null);
    expect(r.draft.customerName).toBe("Rahul");
    expect(r.fields.customerName).toMatchObject({
      status: "available",
      source: { kind: "contact", key: "contact.name" },
    });
  });

  it("maps Phone from the contact record", () => {
    const r = mapLeadToTravelCrm(source({ contact: { name: null, phone: "+911234567890", email: null } }), null);
    expect(r.draft.phone).toBe("+911234567890");
    expect(r.fields.phone.status).toBe("available");
  });

  it("maps Email from the contact record", () => {
    const r = mapLeadToTravelCrm(
      source({ contact: { name: null, phone: null, email: "a@b.co" } }),
      null,
    );
    expect(r.draft.email).toBe("a@b.co");
  });

  it("rejects short names and phones as invalid, never silent", () => {
    const r = mapLeadToTravelCrm(
      source({ contact: { name: "A", phone: "123", email: "bad" } }),
      null,
    );
    expect(r.fields.customerName).toMatchObject({ status: "invalid" });
    expect(r.fields.phone).toMatchObject({ status: "invalid" });
    expect(r.fields.email).toMatchObject({ status: "invalid" });
    expect(r.draft.customerName).toBeNull();
  });
});

describe("semantic answer/custom matching", () => {
  it("maps travel date and normalizes to ISO", () => {
    const r = mapLeadToTravelCrm(
      source({ answers: [{ key: "Date_of_Travel", label: null, value: "2026-11-05" }] }),
      null,
    );
    expect(r.draft.travelStartDate).toBe("2026-11-05");
    expect(r.fields.travelStartDate.status).toBe("available");
  });

  it("maps destination / city / nights into one itinerary row", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [
          { key: "dest", label: "Destination", value: "Goa" },
          { key: "town", label: "Town", value: "Panaji" },
          { key: "no_of_nights", label: "Nights", value: "3" },
        ],
      }),
      null,
    );
    expect(r.draft.itinerary).toEqual([
      { country: "Goa", destination: "Panaji", nights: 3 },
    ]);
    expect(r.fields.itinerary.status).toBe("available");
  });

  it("maps adults with a minimum of one", () => {
    const ok = mapLeadToTravelCrm(
      source({ custom: [{ id: "f-1", name: "Adults", value: "2" }] }),
      null,
    );
    expect(ok.draft.adults).toBe(2);
    const bad = mapLeadToTravelCrm(
      source({ custom: [{ id: "f-1", name: "Adults", value: "two" }] }),
      null,
    );
    expect(bad.fields.adults).toMatchObject({ status: "invalid", reason: "bad-count" });
  });

  it("preserves raw service values and splits multi-value cells", () => {
    const r = mapLeadToTravelCrm(
      source({ answers: [{ key: "services_req", label: "Services", value: "Flight; Hotel" }] }),
      null,
    );
    expect(r.draft.services).toEqual(["Flight", "Hotel"]);
  });

  it("matches by label as well as key, without positions", () => {
    const r = mapLeadToTravelCrm(
      source({ answers: [{ key: "q7", label: "Adults?", value: "4" }] }),
      null,
    );
    expect(r.draft.adults).toBe(4);
  });
});

describe("assigned owner email", () => {
  it("normalizes trim + lowercase", () => {
    const r = mapLeadToTravelCrm(source(), "  Agent@Acme.COM ");
    expect(r.draft.assignedToEmail).toBe("agent@acme.com");
    expect(r.fields.assignedToEmail.status).toBe("available");
  });

  it("null email is missing, malformed email is invalid", () => {
    expect(mapLeadToTravelCrm(source(), null).fields.assignedToEmail.status).toBe("missing");
    const bad = mapLeadToTravelCrm(source(), "not-an-email");
    expect(bad.fields.assignedToEmail).toMatchObject({ status: "invalid" });
  });
});

describe("missing / ambiguous / invalid classification", () => {
  it("funnel fields are always missing in Phase 1", () => {
    const r = mapLeadToTravelCrm(full(), "agent@acme.com");
    expect(r.fields.leadSource.status).toBe("missing");
    expect(r.fields.leadType.status).toBe("missing");
    expect(r.fields.leadStage.status).toBe("missing");
    expect(r.missing).toEqual(
      expect.arrayContaining(["leadSource", "leadType", "leadStage"])
    );
  });

  it("flags competing distinct values as ambiguous", () => {
    const r = mapLeadToTravelCrm(
      source({
        contact: { name: null, phone: "+911111111111", email: null },
        answers: [{ key: "phone", label: "Phone", value: "+912222222222" }],
      }),
      null,
    );
    expect(r.fields.phone.status).toBe("ambiguous");
    expect(r.ambiguous).toEqual([
      { field: "phone", candidates: ["+911111111111", "+912222222222"] },
    ]);
    expect(r.draft.phone).toBeNull();
  });

  it("identical duplicates are not ambiguous", () => {
    const r = mapLeadToTravelCrm(
      source({
        contact: { name: null, phone: "+911111111111", email: null },
        answers: [{ key: "phone", label: "Phone", value: "+911111111111" }],
      }),
      null,
    );
    expect(r.fields.phone.status).toBe("available");
  });

  it("full fixture is ready with funnel fields still missing", () => {
    const r = mapLeadToTravelCrm(full(), "agent@acme.com");
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual(
      expect.arrayContaining(["leadSource", "leadType", "leadStage"])
    );
    expect(r.draft).toMatchObject({
      customerName: "Rahul Sharma",
      phone: "+911234567890",
      email: "RAHUL@Example.COM",
      travelStartDate: "2026-12-01",
      adults: 2,
      assignedToEmail: "agent@acme.com",
    });
    expect(r.draft.services).toEqual(["Flight", "Hotel"]);
    expect(r.draft.itinerary).toEqual([
      { country: "Goa", destination: "Panaji", nights: 3 },
    ]);
  });

  it("optional traveler counts are never reported missing", () => {
    // Children (CWB/CWOB) and Infants are optional in the Travel CRM
    // contract (defaults to 0; the WACRM payload schema marks them
    // nullable + optional) — an empty value must not appear in
    // missing[] and must never block creation.
    const r = mapLeadToTravelCrm(full(), "agent@acme.com");
    for (const f of ["childrenWithBed", "childrenWithoutBed", "infants"]) {
      expect(r.missing).not.toContain(f);
    }
    expect(r.fields.childrenWithBed).toMatchObject({ status: "missing" });
    expect(r.fields.childrenWithoutBed).toMatchObject({ status: "missing" });
    expect(r.fields.infants).toMatchObject({ status: "missing" });
    // Adults stays required: absent lead data keeps it missing so the
    // dialog can confirm the count.
    const noAdults = mapLeadToTravelCrm(
      { ...full(), answers: full().answers.filter((a) => a.key !== "adults") },
      "agent@acme.com",
    );
    expect(noAdults.missing).toContain("adults");
  });

  it("required list covers the Travel CRM contract", () => {
    expect([...TRAVEL_CRM_REQUIRED_FIELDS].sort()).toEqual(
      [
        "customerName",
        "phone",
        "leadSource",
        "leadType",
        "leadStage",
        "assignedToEmail",
        "travelStartDate",
        "adults",
        "services",
        "itinerary",
      ].sort()
    );
  });

  it("mapping is deterministic", () => {
    const a = mapLeadToTravelCrm(full(), "agent@acme.com");
    const b = mapLeadToTravelCrm(full(), "agent@acme.com");
    expect(a).toEqual(b);
  });

  it("expands delimited multi-row itineraries", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [
          { key: "destination", label: "Destination", value: "Goa; Bali" },
          { key: "nights", label: "Nights", value: "3" },
        ],
      }),
      null,
    );
    expect(r.draft.itinerary).toEqual([
      { country: "Goa", destination: null, nights: 3 },
      { country: "Bali", destination: null, nights: 3 },
    ]);
  });
});

describe("canonicalizeServices", () => {
  // Production-like live catalog: Travel CRM derives its labels from
  // the enum (labelForLookup title-casing), so VEHICLE_TRANSFER and
  // OTHER_ADD_ON do NOT carry WACRM's display labels. The explicit
  // label→value map must still resolve WACRM's display labels to the
  // correct enums — otherwise the display label would be sent as the
  // API value and rejected.
  const options = [
    { value: "FLIGHT", label: "Flight" },
    { value: "HOTEL", label: "Hotel" },
    { value: "CRUISE", label: "Cruise" },
    { value: "VEHICLE_TRANSFER", label: "Vehicle Transfer" },
    { value: "SIGHTSEEING", label: "Sightseeing" },
    { value: "VISA", label: "Visa" },
    { value: "OTHER_ADD_ON", label: "Other Add On" },
  ];

  it("resolves every one of the six display labels to its canonical enum", () => {
    expect(
      canonicalizeServices(
        [
          "Cruise",
          "Flight",
          "Hotel",
          "Vehicle",
          "Sightseeing",
          "Add-on Service (Rail, Passport, etc.)",
        ],
        options,
      ),
    ).toEqual(["CRUISE", "FLIGHT", "HOTEL", "VEHICLE_TRANSFER", "SIGHTSEEING", "OTHER_ADD_ON"]);
  });

  it("resolves individual display labels and catalog labels to canonical enums", () => {
    expect(canonicalizeServices(["Flight", "Hotel"], options)).toEqual(["FLIGHT", "HOTEL"]);
    expect(canonicalizeServices(["Vehicle"], options)).toEqual(["VEHICLE_TRANSFER"]);
    // The retired label keeps resolving for previously stored values.
    expect(canonicalizeServices(["Vehicle (disposal)"], options)).toEqual(["VEHICLE_TRANSFER"]);
    expect(
      canonicalizeServices(["Add-on Service (Rail, Passport, etc.)"], options),
    ).toEqual(["OTHER_ADD_ON"]);
  });

  it("resolves the six known labels even when the catalog is unavailable", () => {
    expect(canonicalizeServices(["Vehicle"], null)).toEqual(["VEHICLE_TRANSFER"]);
    expect(canonicalizeServices(["Vehicle (disposal)"], null)).toEqual(["VEHICLE_TRANSFER"]);
    expect(canonicalizeServices(["Add-on Service (Rail, Passport, etc.)"], [])).toEqual([
      "OTHER_ADD_ON",
    ]);
    expect(canonicalizeServices(["Flight"], null)).toEqual(["FLIGHT"]);
    // Unknown values still pass through for Travel CRM to validate.
    expect(canonicalizeServices(["Teleport"], null)).toEqual(["Teleport"]);
  });

  it("passes enum values through verbatim", () => {
    expect(canonicalizeServices(["VEHICLE_TRANSFER", "HOTEL"], options)).toEqual([
      "VEHICLE_TRANSFER",
      "HOTEL",
    ]);
  });
});

describe("optional fields are never reported missing", () => {
  it("absent email is not in missing (present email still maps)", () => {
    const absent = mapLeadToTravelCrm(source(), null);
    expect(absent.fields.email.status).toBe("missing");
    expect(absent.missing).not.toContain("email");
    const present = mapLeadToTravelCrm(
      source({ contact: { name: null, phone: null, email: "a@b.co" } }),
      null,
    );
    expect(present.fields.email.status).toBe("available");
    expect(present.draft.email).toBe("a@b.co");
  });

  it("malformed email still reports invalid", () => {
    const r = mapLeadToTravelCrm(
      source({ contact: { name: null, phone: null, email: "bad" } }),
      null,
    );
    expect(r.fields.email).toMatchObject({ status: "invalid" });
  });

  it("absent rooms is not in missing", () => {
    const r = mapLeadToTravelCrm(source(), null);
    expect(r.fields.rooms.status).toBe("missing");
    expect(r.missing).not.toContain("rooms");
  });

  it("empty dateOfBirth is not in missing and never blocks readiness", () => {
    const r = mapLeadToTravelCrm(source(), null);
    expect(r.fields.dateOfBirth.status).toBe("missing");
    expect(r.missing).not.toContain("dateOfBirth");
    expect(r.draft.dateOfBirth).toBeNull();
    // A lead complete in every genuinely required field is ready
    // with no DOB provided.
    const complete = mapLeadToTravelCrm(full(), "owner@acme.com");
    expect(complete.missing).not.toContain("dateOfBirth");
    expect(complete.ready).toBe(true);
  });

  it("provided dateOfBirth maps normally to an ISO date", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [{ key: "dob", label: "DOB", value: "1990-05-01" }],
      }),
      null,
    );
    expect(r.fields.dateOfBirth.status).toBe("available");
    expect(r.draft.dateOfBirth).toBe("1990-05-01");
    expect(r.missing).not.toContain("dateOfBirth");
  });

  it("malformed dateOfBirth still reports invalid", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [{ key: "dob", label: "DOB", value: "not-a-date" }],
      }),
      null,
    );
    expect(r.fields.dateOfBirth).toMatchObject({ status: "invalid" });
  });
});

describe("inferReceivedLabel", () => {
  it("maps Facebook variants", () => {
    for (const v of ["Facebook", "facebook ads", "FB", " FaceBook "]) {
      expect(inferReceivedLabel(v)).toBe("Facebook Ads");
    }
  });

  it("maps Instagram variants", () => {
    for (const v of ["Instagram", "instagram ads", "IG", " ig "]) {
      expect(inferReceivedLabel(v)).toBe("Instagram Ads");
    }
  });

  it("returns null for anything else", () => {
    for (const v of ["Google", "Walk-in", "Referral", "", "FB IG"]) {
      expect(inferReceivedLabel(v)).toBeNull();
    }
  });
});

describe("leadSource inference from WACRM source fields", () => {
  const withSource = (value: string, key = "lead_source", label = "Lead Source") =>
    source({ answers: [{ key, label, value }] });

  it("Facebook source resolves to available Facebook Ads", () => {
    for (const v of ["Facebook", "FB"]) {
      const r = mapLeadToTravelCrm(withSource(v), null);
      expect(r.fields.leadSource.status).toBe("available");
      expect(r.draft.leadSource).toBe("Facebook Ads");
      expect(r.missing).not.toContain("leadSource");
    }
  });

  it("Instagram source resolves to available Instagram Ads", () => {
    const r = mapLeadToTravelCrm(withSource("Instagram", "source", "Source"), null);
    expect(r.fields.leadSource.status).toBe("available");
    expect(r.draft.leadSource).toBe("Instagram Ads");
  });

  it("same meaning twice is not ambiguous", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [
          { key: "lead_source", label: "Lead Source", value: "Facebook" },
          { key: "src", label: "Source", value: "facebook" },
        ],
      }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("available");
    expect(r.draft.leadSource).toBe("Facebook Ads");
  });

  it("mixed Facebook+Instagram stays ambiguous (never guesses)", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [
          { key: "lead_source", label: "Lead Source", value: "Facebook" },
          { key: "src", label: "Source", value: "Instagram" },
        ],
      }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("ambiguous");
    expect(r.draft.leadSource).toBeNull();
    expect(r.ambiguous).toEqual([
      { field: "leadSource", candidates: ["Facebook", "Instagram"] },
    ]);
  });

  it("unmappable source stays missing for manual selection", () => {
    const r = mapLeadToTravelCrm(withSource("Google"), null);
    expect(r.fields.leadSource.status).toBe("missing");
    expect(r.missing).toContain("leadSource");
    expect(r.draft.leadSource).toBeNull();
  });

  it("absent source stays missing", () => {
    const r = mapLeadToTravelCrm(source(), null);
    expect(r.fields.leadSource.status).toBe("missing");
    expect(r.missing).toContain("leadSource");
  });
});

describe("canonicalizeLeadSource", () => {
  const options = [
    { value: "FACEBOOK_ADS", label: "Facebook Ads" },
    { value: "INSTAGRAM_ADS", label: "Instagram Ads" },
    { value: "WHATSAPP", label: "WhatsApp" },
  ];

  it("resolves labels and values to live enum values", () => {
    expect(canonicalizeLeadSource("Facebook Ads", options)).toBe("FACEBOOK_ADS");
    expect(canonicalizeLeadSource("FACEBOOK_ADS", options)).toBe("FACEBOOK_ADS");
    expect(canonicalizeLeadSource("Instagram Ads", options)).toBe("INSTAGRAM_ADS");
    // Bare variants do NOT resolve here — inferReceivedLabel owns those.
    expect(canonicalizeLeadSource("instagram", options)).toBeNull();
  });

  it("returns null when nothing matches or options are absent", () => {
    expect(canonicalizeLeadSource("Carrier Pigeon", options)).toBeNull();
    expect(canonicalizeLeadSource("Facebook Ads", null)).toBeNull();
    expect(canonicalizeLeadSource("Facebook Ads", [])).toBeNull();
  });
});

describe("ad-source platform inference (Lead Source icon signal)", () => {
  it("platform alone resolves Received (screenshot case)", () => {
    const r = mapLeadToTravelCrm(
      source({ adSourcePlatform: "instagram" }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("available");
    expect(r.draft.leadSource).toBe("Instagram Ads");
    expect(r.missing).not.toContain("leadSource");
    expect(r.fields.leadSource).toMatchObject({
      source: { kind: "contact", key: "contact.source_url" },
    });
  });

  it("facebook platform resolves to Facebook Ads", () => {
    const r = mapLeadToTravelCrm(
      source({ adSourcePlatform: "facebook" }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("available");
    expect(r.draft.leadSource).toBe("Facebook Ads");
  });

  it("agreeing text and platform resolve once", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [{ key: "lead_source", label: "Lead Source", value: "Instagram" }],
        adSourcePlatform: "instagram",
      }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("available");
    expect(r.draft.leadSource).toBe("Instagram Ads");
  });

  it("conflicting text and platform stay ambiguous (never guesses)", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [{ key: "lead_source", label: "Lead Source", value: "Facebook" }],
        adSourcePlatform: "instagram",
      }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("ambiguous");
    expect(r.draft.leadSource).toBeNull();
    expect(r.fields.leadSource.candidates).toEqual(
      expect.arrayContaining(["Facebook", "Instagram Ads"]),
    );
  });

  it("unmappable text plus platform stays ambiguous, not silent", () => {
    const r = mapLeadToTravelCrm(
      source({
        answers: [{ key: "src", label: "Source", value: "Google" }],
        adSourcePlatform: "instagram",
      }),
      null,
    );
    expect(r.fields.leadSource.status).toBe("ambiguous");
    expect(r.draft.leadSource).toBeNull();
  });
});

describe("buildReceivedOptions", () => {
  const EXPECTED_LABELS = [
    "Website",
    "Social Media",
    "Facebook Ads",
    "Instagram Ads",
    "Google Ads",
    "Whatsapp",
    "Phone Call",
    "Referral",
    "Walk In",
    "Repeat Customer",
    "Partner",
    "Other",
  ];

  it("always yields exactly the 12 required labels in order", () => {
    expect(buildReceivedOptions(null).map((o) => o.label)).toEqual(EXPECTED_LABELS);
    expect(buildReceivedOptions([]).map((o) => o.label)).toEqual(EXPECTED_LABELS);
  });

  it("prefers live lookup values when they match", () => {
    const out = buildReceivedOptions([
      { value: "FACEBOOK_ADS", label: "Facebook Ads" },
      { value: "CUSTOM_IG", label: "Instagram Ads" },
      { value: "WHATSAPP", label: "WhatsApp" },
    ]);
    expect(out.map((o) => o.label)).toEqual(EXPECTED_LABELS);
    expect(out.find((o) => o.label === "Facebook Ads")).toEqual({
      value: "FACEBOOK_ADS",
      label: "Facebook Ads",
    });
    expect(out.find((o) => o.label === "Instagram Ads")).toEqual({
      value: "CUSTOM_IG",
      label: "Instagram Ads",
    });
    expect(out.find((o) => o.label === "Whatsapp")).toEqual({
      value: "WHATSAPP",
      label: "Whatsapp",
    });
  });

  it("falls back to audited enums only for unmatched labels", () => {
    const out = buildReceivedOptions([{ value: "REFERRAL", label: "Referral" }]);
    expect(out.find((o) => o.label === "Referral")).toEqual({
      value: "REFERRAL",
      label: "Referral",
    });
    expect(out.find((o) => o.label === "Website")).toEqual({
      value: "WEBSITE",
      label: "Website",
    });
  });
});

describe("renamed business fields never auto-fill funnel targets", () => {
  it("stored Lead Type / Stage / Lead Received values stay out of the draft", () => {
    const r = mapLeadToTravelCrm(
      source({
        custom: [
          { id: "f-1", name: "Lead Type", value: "Hot" },
          { id: "f-2", name: "Stage", value: "Lost" },
          { id: "f-3", name: "Lead Received", value: "Facebook Ads" },
        ],
      }),
      null,
    );
    expect(r.fields.leadType.status).toBe("missing");
    expect(r.fields.leadStage.status).toBe("missing");
    expect(r.draft.leadType).toBeNull();
    expect(r.draft.leadStage).toBeNull();
    // Lead Received has its own explicit inference path below; a
    // same-named custom field must not feed it either.
    expect(r.fields.leadSource.status).toBe("missing");
    expect(r.draft.leadSource).toBeNull();
  });
});

describe("canonicalizeOptionLabel (Workspace business defaults)", () => {
  const typeOptions = [
    { value: "FRESH", label: "Fresh" },
    { value: "HOT", label: "Hot" },
  ];
  const stageOptions = [
    { value: "NEW_LEAD", label: "New Lead" },
    { value: "QUALIFIED", label: "Qualified" },
  ];

  it("resolves Fresh / New Lead display labels to live enum values", () => {
    expect(canonicalizeOptionLabel("Fresh", typeOptions)).toBe("FRESH");
    expect(canonicalizeOptionLabel("New Lead", stageOptions)).toBe("NEW_LEAD");
    expect(canonicalizeOptionLabel("FRESH", typeOptions)).toBe("FRESH");
  });

  it("returns null when unmatched or options are absent", () => {
    expect(canonicalizeOptionLabel("Fresh", [{ value: "HOT", label: "Hot" }])).toBeNull();
    expect(canonicalizeOptionLabel("Fresh", null)).toBeNull();
    expect(canonicalizeOptionLabel("Fresh", [])).toBeNull();
  });
});

describe("workspace Name column prefill (flowNameColumnKey)", () => {
  const wa = "राधे राधे🙏🌸";
  const flowAnswer = "Ritika Singh";

  function withKey() {
    return source({
      contact: { name: wa, phone: "+911234567890", email: null },
      answers: [{ key: "full_name", label: "Name", value: flowAnswer }],
      custom: [
        { id: "f-1", name: "Customer Name", value: "Someone Else" },
        { id: "f-2", name: "Parent Name", value: "Another Person" },
        { id: "f-3", name: "Full Name", value: "Third Person" },
        { id: "f-4", name: "Name", value: "Custom Name Field" },
      ],
    });
  }

  it("CASE 1: exact flow column wins; contact + name-like customs ignored, no ambiguity", () => {
    const r = mapLeadToTravelCrm(withKey(), null, { flowNameColumnKey: "full_name" });
    expect(r.draft.customerName).toBe(flowAnswer);
    expect(r.fields.customerName).toMatchObject({
      status: "available",
      source: { kind: "answer", key: "full_name" },
    });
    expect(r.ambiguous.filter((a) => a.field === "customerName")).toEqual([]);
  });

  it("empty flow answer falls back to the WhatsApp contact name (single candidate)", () => {
    const r = mapLeadToTravelCrm(
      source({
        contact: { name: wa, phone: null, email: null },
        answers: [{ key: "full_name", label: "Name", value: "" }],
      }),
      null,
      { flowNameColumnKey: "full_name" },
    );
    expect(r.draft.customerName).toBe(wa);
    expect(r.fields.customerName.status).toBe("available");
  });

  it("missing answer and contact stays missing for manual entry", () => {
    const r = mapLeadToTravelCrm(
      source({ answers: [{ key: "other", label: "Other", value: "x" }] }),
      null,
      { flowNameColumnKey: "full_name" },
    );
    expect(r.fields.customerName.status).toBe("missing");
    expect(r.missing).toContain("customerName");
  });

  it("legacy path preserved: no key still merges-then-flags contact+answer as ambiguous", () => {
    const r = mapLeadToTravelCrm(withKey(), null);
    expect(r.fields.customerName.status).toBe("ambiguous");
    expect(r.draft.customerName).toBeNull();
  });

  it("genuinely conflicting values for the exact key stay ambiguous", () => {
    const r = mapLeadToTravelCrm(
      source({
        contact: { name: null, phone: null, email: null },
        answers: [
          { key: "full_name", label: "Name", value: "Anna" },
          { key: "full_name", label: "Name", value: "Beth" },
        ],
      }),
      null,
      { flowNameColumnKey: "full_name" },
    );
    expect(r.fields.customerName.status).toBe("ambiguous");
  });

  it("short flow answers are invalid, never silently accepted", () => {
    const r = mapLeadToTravelCrm(
      source({
        contact: { name: null, phone: null, email: null },
        answers: [{ key: "full_name", label: "Name", value: "A" }],
      }),
      null,
      { flowNameColumnKey: "full_name" },
    );
    expect(r.fields.customerName).toMatchObject({ status: "invalid" });
  });
});
