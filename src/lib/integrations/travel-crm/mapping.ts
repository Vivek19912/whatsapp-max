// ============================================================
// Travel CRM lead-draft mapper (Phase 1: WACRM side only).
//
// Pure + deterministic: same WACRM lead data always yields the
// same draft + classification. No network, no database, no
// guessing — ambiguous or unusable values are reported, never
// silently resolved.
//
// Candidate sources, in priority order:
//   1. contact record (name / phone / email only)
//   2. flow submission answers, matched by normalized key OR label
//   3. custom Workspace fields, matched by normalized name
//
// Matching normalizes to lowercase alphanumerics ("Phone No" →
// "phoneno", "customer_source" → "customersource") and compares
// against fixed synonym sets — never column positions. When two
// DIFFERENT non-empty values match one target, the target is
// AMBIGUOUS (even if one came from the contact record).
//
// Required Travel CRM fields (must be AVAILABLE before any
// future send): customerName, phone, leadSource, leadType,
// leadStage, assignedToEmail, travelStartDate, adults,
// services (≥1), itinerary (≥1 row with a destination).
// leadType/leadStage have no WACRM equivalent and are always
// MISSING here; leadSource is inferred only from unambiguous
// Facebook/Instagram source signals, otherwise MISSING;
// assignedToEmail arrives already resolved by the server (never
// mapped from a field).
// Email and rooms are optional in Travel CRM: absence is never
// reported as missing (present values still map/send, bad values
// still report invalid).
// ============================================================

import { TRAVEL_CRM_SERVICE_VALUE_BY_LABEL } from "./services";

export interface WacrmContactSource {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface WacrmAnswerSource {
  key: string;
  label?: string | null;
  value: string | null;
}

export interface WacrmCustomSource {
  id: string;
  name: string;
  value: string | null;
  /** Field-level display default (workspace_fields.default_value), if any. */
  defaultValue?: string | null;
}

export interface WacrmLeadSource {
  contact: WacrmContactSource;
  answers: WacrmAnswerSource[];
  custom: WacrmCustomSource[];
  /**
   * Ad-platform signal behind the Workspace Lead Source icon,
   * derived from the SAME contacts.source_url the column renders
   * (never a second source of truth). Drives Received inference
   * when no confident text signal exists; any disagreement with
   * text values stays ambiguous.
   */
  adSourcePlatform?: "facebook" | "instagram" | null;
}

export type TravelCrmFieldStatus =
  | "available"
  | "missing"
  | "ambiguous"
  | "invalid";

export interface TravelCrmFieldMapping {
  status: TravelCrmFieldStatus;
  /** Where the value came from (contact record, answer key, or custom field id). */
  source?: { kind: "contact" | "answer" | "custom" | "flow-default"; key: string };
  /** Competing distinct values when ambiguous. */
  candidates?: string[];
  /** Machine-readable reason for invalid (e.g. "bad-email"). */
  reason?: string;
}

export interface TravelCrmItineraryRow {
  country: string | null;
  destination: string | null;
  nights: number | null;
}

/** Internal Travel CRM-ready lead draft. Unavailable fields stay null. */
export interface TravelCrmLeadDraft {
  customerName: string | null;
  phone: string | null;
  email: string | null;
  leadSource: string | null;
  leadType: string | null;
  leadStage: string | null;
  /** Server-resolved owner email — never mapped from a WACRM field. */
  assignedToEmail: string | null;
  dateOfBirth: string | null;
  travelStartDate: string | null;
  /** Month-based travel timing (both set or both null; never a date). */
  travelMonth: number | null;
  travelYear: number | null;
  departureCountry: string | null;
  departureCity: string | null;
  rooms: number | null;
  adults: number | null;
  childrenWithBed: number | null;
  childrenWithoutBed: number | null;
  infants: number | null;
  /** Optional per-child ages (empty = none provided). */
  childrenWithBedAges: number[];
  childrenWithoutBedAges: number[];
  infantAges: number[];
  services: string[];
  itinerary: TravelCrmItineraryRow[];
}

export interface TravelCrmAmbiguity {
  field: string;
  candidates: string[];
}

export interface TravelCrmInvalid {
  field: string;
  reason: string;
}

export interface TravelCrmMappingResult {
  draft: TravelCrmLeadDraft;
  fields: Record<string, TravelCrmFieldMapping>;
  available: string[];
  missing: string[];
  ambiguous: TravelCrmAmbiguity[];
  invalid: TravelCrmInvalid[];
  /** True when every REQUIRED field is AVAILABLE. */
  ready: boolean;
}

/** Travel CRM required fields (assignedToEmail resolved server-side). */
export const TRAVEL_CRM_REQUIRED_FIELDS: readonly string[] = [
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
];

/**
 * Required fields WACRM itself can satisfy. leadSource/leadType/
 * leadStage have no WACRM equivalent (Phase-2 dialog/defaults),
 * so `ready` means "WACRM-side complete" — everything mappable is
 * AVAILABLE. It never claims the funnel fields.
 */

/** Normalize a key/label for synonym comparison. */
export function normalizeFieldToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface CanonicalOption {
  value: string;
  label: string;
}

/**
 * Map raw WACRM service values onto canonical Travel CRM enum
 * values. WACRM's six display labels resolve through the explicit
 * label→value map first (the live catalog derives its labels from
 * the enum and does NOT match two of the six display labels), so a
 * label is never sent as the API value. Every other value is matched
 * against the live lookup options (by normalized value OR label, so
 * "Flight" and "Vehicle Transfer" resolve without hardcoding);
 * unmatched values pass through untouched — Travel CRM validates
 * authoritatively. Deterministic and pure.
 */
export function canonicalizeServices(
  values: string[],
  options: readonly CanonicalOption[] | null | undefined,
): string[] {
  const byNorm = new Map<string, string>();
  // Explicit WACRM display-label → Travel CRM enum resolution first:
  // these enums are fixed in the Travel CRM contract, so the six known
  // labels resolve even when the live catalog is unreachable.
  for (const [label, value] of Object.entries(TRAVEL_CRM_SERVICE_VALUE_BY_LABEL)) {
    const labelKey = normalizeFieldToken(label);
    if (!byNorm.has(labelKey)) byNorm.set(labelKey, value);
    const valueKey = normalizeFieldToken(value);
    if (!byNorm.has(valueKey)) byNorm.set(valueKey, value);
  }
  // Live catalog fills in every other value/label; the explicit map
  // above always wins for the six known labels.
  if (options && options.length > 0) {
    for (const o of options) {
      const value = o.value;
      if (!value) continue;
      const valueKey = normalizeFieldToken(value);
      if (!byNorm.has(valueKey)) byNorm.set(valueKey, value);
      if (typeof o.label === "string" && o.label) {
        const key = normalizeFieldToken(o.label);
        if (!byNorm.has(key)) byNorm.set(key, value);
      }
    }
  }
  return values.map((v) => byNorm.get(normalizeFieldToken(v)) ?? v);
}

/**
 * Normalize one WACRM source text to a supported Travel CRM
 * Received label. Facebook/Instagram shorthands resolve to their
 * Ads labels ("Facebook" → "Facebook Ads", "IG" → "Instagram
 * Ads"); every other value must match a supported label exactly
 * (normalized — "WhatsApp" → "Whatsapp", "Walk-in" → "Walk In").
 * Returns null when the value maps to nothing — the caller leaves
 * the field unselected instead of guessing. Deterministic and
 * pure. The 12 labels mirror the Travel CRM lead-source contract
 * (see RECEIVED_LABELS / the shared LEAD_SOURCES enum).
 */
export function canonicalizeReceivedText(
  value: string,
): (typeof RECEIVED_LABELS)[number] | null {
  const token = normalizeFieldToken(value);
  if (token === "facebook" || token === "facebookads" || token === "fb") {
    return "Facebook Ads";
  }
  if (token === "instagram" || token === "instagramads" || token === "ig") {
    return "Instagram Ads";
  }
  for (const label of RECEIVED_LABELS) {
    if (normalizeFieldToken(label) === token) return label;
  }
  return null;
}

/**
 * Resolve a Workspace display label (e.g. a business-column
 * default like "Fresh" or "New Lead") to a live Travel CRM option
 * value, matched by normalized value OR label. Returns null when
 * nothing matches or options are absent, so the caller can fall
 * back to manual selection. Deterministic and pure.
 */
export function canonicalizeOptionLabel(
  value: string,
  options: readonly CanonicalOption[] | null | undefined,
): string | null {
  if (!options || options.length === 0) return null;
  const token = normalizeFieldToken(value);
  for (const o of options) {
    if (!o.value) continue;
    if (normalizeFieldToken(o.value) === token) return o.value;
  }
  for (const o of options) {
    if (!o.value || typeof o.label !== "string" || !o.label) continue;
    if (normalizeFieldToken(o.label) === token) return o.value;
  }
  return null;
}

/**
 * Infer a Travel CRM Received label from a WACRM lead-source value.
 * Only unambiguous Facebook/Instagram signals map — anything else
 * (including mixed FB+IG signals, resolved by the caller) returns
 * null so Received stays manually selectable. Never guesses.
 */
export function inferReceivedLabel(value: string): "Facebook Ads" | "Instagram Ads" | null {
  const token = normalizeFieldToken(value);
  if (
    token === "facebook" ||
    token === "facebookads" ||
    token === "fb"
  ) {
    return "Facebook Ads";
  }
  if (
    token === "instagram" ||
    token === "instagramads" ||
    token === "ig"
  ) {
    return "Instagram Ads";
  }
  return null;
}

/**
 * Resolve an inferred Received label to a live Travel CRM option
 * value (matched by normalized value OR label, mirroring
 * canonicalizeServices). Returns null when nothing matches, so
 * the caller can fall back to manual selection.
 */
export function canonicalizeLeadSource(
  value: string,
  options: readonly CanonicalOption[] | null | undefined,
): string | null {
  if (!options || options.length === 0) return null;
  const token = normalizeFieldToken(value);
  for (const o of options) {
    if (!o.value) continue;
    if (normalizeFieldToken(o.value) === token) return o.value;
  }
  for (const o of options) {
    if (!o.value || typeof o.label !== "string" || !o.label) continue;
    if (normalizeFieldToken(o.label) === token) return o.value;
  }
  return null;
}

/**
 * Exact Received labels the dialog must offer, in display order.
 */
export const RECEIVED_LABELS: readonly string[] = [
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

/**
 * Fallback enum values for the 12 Received labels, used ONLY when
 * live Travel CRM options are unavailable. These mirror the audited
 * Travel CRM contract; whenever live options exist, their values
 * win (matched by normalized value or label).
 */
const RECEIVED_ENUM_FALLBACK: Readonly<Record<string, string>> = {
  Website: "WEBSITE",
  "Social Media": "SOCIAL_MEDIA",
  "Facebook Ads": "FACEBOOK_ADS",
  "Instagram Ads": "INSTAGRAM_ADS",
  "Google Ads": "GOOGLE_ADS",
  Whatsapp: "WHATSAPP",
  "Phone Call": "PHONE_CALL",
  Referral: "REFERRAL",
  "Walk In": "WALK_IN",
  "Repeat Customer": "REPEAT_CUSTOMER",
  Partner: "PARTNER",
  Other: "OTHER",
};

export interface ReceivedOption {
  value: string;
  label: string;
}

/**
 * Build the Received dropdown options: exactly the 12 required
 * labels, each carrying the live Travel CRM enum value when the
 * live lookups provide a match, else the audited fallback value.
 * Deterministic and pure.
 */
export function buildReceivedOptions(
  live: readonly CanonicalOption[] | null | undefined,
): ReceivedOption[] {
  const byNorm = new Map<string, string>();
  if (live) {
    for (const o of live) {
      if (!o.value) continue;
      const valueKey = normalizeFieldToken(o.value);
      if (!byNorm.has(valueKey)) byNorm.set(valueKey, o.value);
      if (typeof o.label === "string" && o.label) {
        const labelKey = normalizeFieldToken(o.label);
        if (!byNorm.has(labelKey)) byNorm.set(labelKey, o.value);
      }
    }
  }
  return RECEIVED_LABELS.map((label) => ({
    value: byNorm.get(normalizeFieldToken(label)) ?? RECEIVED_ENUM_FALLBACK[label] ?? label,
    label,
  }));
}

interface Candidate {
  source: { kind: "contact" | "answer" | "custom"; key: string };
  value: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function collectCandidates(
  source: WacrmLeadSource,
  synonyms: ReadonlySet<string>,
  contactPick: (c: WacrmContactSource) => string | null,
  contactKey: string,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (sourceDesc: Candidate["source"], raw: string | null) => {
    const value = nonEmpty(raw);
    if (value === null || seen.has(value)) return;
    seen.add(value);
    out.push({ source: sourceDesc, value });
  };
  push({ kind: "contact", key: contactKey }, contactPick(source.contact));
  for (const a of source.answers) {
    if (
      synonyms.has(normalizeFieldToken(a.key)) ||
      (a.label != null && synonyms.has(normalizeFieldToken(a.label)))
    ) {
      push({ kind: "answer", key: a.key }, a.value);
    }
  }
  for (const f of source.custom) {
    if (synonyms.has(normalizeFieldToken(f.name))) {
      push({ kind: "custom", key: f.id }, f.value);
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function toIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : trimmed;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Split a multi-value cell ("A; B | C") preserving order. */
function splitMulti(value: string): string[] {
  return value
    .split(/[;\n|]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

const SYNONYMS: Readonly<Record<string, ReadonlySet<string>>> = {
  leadSource: new Set([
    "leadsource",
    "source",
    "leadsrc",
    // Actual Meta Source column key (META_SOURCE_COLUMN_KEY in the
    // virtual flow, normalized): Meta submissions store the Source
    // answer under "meta_lead_source", and the label derivation
    // falls back to that same key — without this entry the
    // Workspace Source value never reaches the mapping at all.
    "metaleadsource",
  ]),
  customerName: new Set([
    "name",
    "fullname",
    "customername",
    "clientname",
    "leadname",
    "contactname",
    "travellername",
    "passengername",
    "guestname",
  ]),
  phone: new Set([
    "phone",
    "phonenumber",
    "mobile",
    "mobilenumber",
    "contactphone",
    "contactnumber",
    "telephonenumber",
    "phoneno",
  ]),
  email: new Set(["email", "emailaddress", "emailid", "mail", "emailidaddress"]),
  travelStartDate: new Set([
    "traveldate",
    "dateoftravel",
    "journeystartdate",
    "startdate",
    "departuredate",
    "tourdate",
    "tripdate",
  ]),
  destination: new Set([
    "destination",
    "dest",
    "holidaydestination",
    "traveldestination",
    "tour destination".replace(/[^a-z0-9]/g, ""),
    "destinationplace",
  ]),
  city: new Set(["city", "town", "destinationcity", "placecity"]),
  nights: new Set([
    "nights",
    "night",
    "noofnights",
    "numberofnights",
    "totalnights",
    "duration",
    "durationnights",
  ]),
  adults: new Set(["adults", "adult", "noofadults", "numberofadults"]),
  departureCountry: new Set([
    "departurecountry",
    "departingfrom",
    "fromcountry",
    "departurelocationcountry",
  ]),
  departureCity: new Set(["departurecity", "fromcity", "departurelocationcity"]),
  services: new Set([
    "service",
    "services",
    "servicerequired",
    "servicesrequired",
    "servicetype",
    "servicetypes",
  ]),
  rooms: new Set(["rooms", "room", "noofrooms"]),
  childrenWithBed: new Set(["childrenwithbed", "cwb", "childwithbed"]),
  childrenWithoutBed: new Set([
    "childrenwithoutbed",
    "cwob",
    "childwithoutbed",
  ]),
  infants: new Set(["infants", "infant", "noofinfants"]),
  dateOfBirth: new Set(["dateofbirth", "dob", "birthdate", "birthdatedate"]),
};

/**
 * Collapse phone candidates that differ only in formatting (spaces,
 * dashes, parentheses, a missing "+" prefix) into one candidate per
 * distinct digit string, preferring an explicit international ("+")
 * form as the representative. "918511880206" and "+918511880206"
 * are the same number and must not surface as an ambiguity;
 * genuinely different numbers stay separate candidates and remain
 * ambiguous. Candidates with no digits at all never merge (each
 * keeps its own raw key) so non-numeric values keep the legacy
 * behavior. Pure.
 */
function dedupePhoneCandidates(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const digits = c.value.replace(/\D/g, "");
    const key = digits === "" ? `raw:${c.value.trim()}` : `digits:${digits}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()].map(
    (group) =>
      group.find((c) => c.value.trim().startsWith("+")) ?? group[0],
  );
}

function singleText(
  candidates: Candidate[],
  validate: (value: string) => string | null,
): { mapping: TravelCrmFieldMapping; value: string | null } {
  if (candidates.length === 0) {
    return { mapping: { status: "missing" }, value: null };
  }
  if (candidates.length > 1) {
    return {
      mapping: {
        status: "ambiguous",
        candidates: candidates.map((c) => c.value),
      },
      value: null,
    };
  }
  const reason = validate(candidates[0].value);
  if (reason !== null) {
    return { mapping: { status: "invalid", reason }, value: null };
  }
  return {
    mapping: { status: "available", source: candidates[0].source },
    value: candidates[0].value,
  };
}

const ok = (): string | null => null;

/**
 * Resolve Travel CRM Name from the exact flow-derived Workspace
 * "Name" column (CASE 1). Reads ONLY the answer stored under that
 * column's key — never synonym matching, never the contact record,
 * never custom fields. A non-empty answer wins outright: the
 * WhatsApp contact name is ignored, so the two intentionally
 * different sources can never surface as an ambiguity. An
 * empty/missing answer falls back to the single WhatsApp
 * contact-name candidate (the CASE 2 source); with nothing usable
 * the field is missing for manual entry. Conflicting values for
 * the exact key itself (only possible from exotic multi-entry
 * inputs) stay ambiguous.
 */
function resolveWorkspaceName(
  source: WacrmLeadSource,
  columnKey: string,
  fields: Record<string, TravelCrmFieldMapping>,
  draft: TravelCrmLeadDraft,
  validate: (value: string) => string | null,
): void {
  const values = source.answers
    .filter((a) => a.key === columnKey)
    .map((a) => nonEmpty(a.value))
    .filter((v): v is string => v !== null);
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    fields.customerName = { status: "ambiguous", candidates: distinct };
    return;
  }
  if (distinct.length === 1) {
    const reason = validate(distinct[0]);
    if (reason !== null) {
      fields.customerName = { status: "invalid", reason };
      return;
    }
    fields.customerName = {
      status: "available",
      source: { kind: "answer", key: columnKey },
    };
    draft.customerName = distinct[0];
    return;
  }
  const contactValue = nonEmpty(source.contact.name);
  if (contactValue === null) {
    fields.customerName = { status: "missing" };
    return;
  }
  const reason = validate(contactValue);
  if (reason !== null) {
    fields.customerName = { status: "invalid", reason };
    return;
  }
  fields.customerName = {
    status: "available",
    source: { kind: "contact", key: "contact.name" },
  };
  draft.customerName = contactValue;
}

/**
 * Map one WACRM lead to a Travel CRM-ready draft + per-field
 * classification. `assignedToEmail` is passed in already resolved
 * (or null) — the mapper only validates its shape.
 *
 * `opts.flowNameColumnKey` carries the exact key of the
 * flow-derived Workspace "Name" column (same derivation the table
 * renders, resolved by the caller). When set, customerName comes
 * from THAT column's answer only — the WhatsApp contact name is
 * used solely as the fallback when the answer is empty, and other
 * name-like fields are ignored entirely. The flow answer and the
 * contact name are therefore never treated as competing
 * candidates. When unset, the legacy synonym matching applies.
 */
export function mapLeadToTravelCrm(
  source: WacrmLeadSource,
  assignedToEmail: string | null,
  opts?: { flowNameColumnKey?: string | null },
): TravelCrmMappingResult {
  const fields: Record<string, TravelCrmFieldMapping> = {};
  const draft: TravelCrmLeadDraft = {
    customerName: null,
    phone: null,
    email: null,
    leadSource: null,
    leadType: null,
    leadStage: null,
    assignedToEmail: null,
    dateOfBirth: null,
    travelStartDate: null,
    travelMonth: null,
    travelYear: null,
    departureCountry: null,
    departureCity: null,
    rooms: null,
    adults: null,
    childrenWithBed: null,
    childrenWithoutBed: null,
    infants: null,
    childrenWithBedAges: [],
    childrenWithoutBedAges: [],
    infantAges: [],
    services: [],
    itinerary: [],
  };

  const text = (
    field: keyof TravelCrmLeadDraft,
    synonyms: ReadonlySet<string>,
    contactPick: (c: WacrmContactSource) => string | null,
    contactKey: string,
    validate: (value: string) => string | null = ok,
  ) => {
    const { mapping, value } = singleText(
      collectCandidates(source, synonyms, contactPick, contactKey),
      validate,
    );
    fields[field] = mapping;
    (draft as unknown as Record<string, unknown>)[field] = value;
  };

  const digits = (value: string) => value.replace(/\D/g, "");

  const validateName = (v: string) =>
    v.trim().length >= 2 ? null : "name-too-short";
  if (opts?.flowNameColumnKey) {
    resolveWorkspaceName(source, opts.flowNameColumnKey, fields, draft, validateName);
  } else {
    text("customerName", SYNONYMS.customerName, (c) => c.name, "contact.name", validateName);
  }
  {
    // Phone values that differ only in formatting collapse to one
    // canonical candidate (preferring the "+" form) before the
    // available/ambiguous decision, so equivalent representations
    // never ask the agent to choose. Distinct numbers still surface
    // as ambiguous; validation is unchanged.
    const { mapping, value } = singleText(
      dedupePhoneCandidates(
        collectCandidates(source, SYNONYMS.phone, (c) => c.phone, "contact.phone"),
      ),
      (v) => (digits(v).length >= 5 ? null : "phone-too-short"),
    );
    fields.phone = mapping;
    draft.phone = value;
  }
  text("email", SYNONYMS.email, (c) => c.email, "contact.email", (v) =>
    EMAIL_RE.test(v.trim()) ? null : "bad-email",
  );
  text("travelStartDate", SYNONYMS.travelStartDate, () => null, "contact.none", (v) =>
    toIsoDate(v) === null ? "bad-date" : null,
  );
  if (fields.travelStartDate.status === "available" && draft.travelStartDate) {
    draft.travelStartDate = toIsoDate(draft.travelStartDate);
  }
  text("departureCountry", SYNONYMS.departureCountry, () => null, "contact.none");
  text("departureCity", SYNONYMS.departureCity, () => null, "contact.none");
  text("dateOfBirth", SYNONYMS.dateOfBirth, () => null, "contact.none", (v) =>
    toIsoDate(v) === null ? "bad-date" : null,
  );
  if (fields.dateOfBirth.status === "available" && draft.dateOfBirth) {
    draft.dateOfBirth = toIsoDate(draft.dateOfBirth);
  }

  const count = (
    field: "rooms" | "adults" | "childrenWithBed" | "childrenWithoutBed" | "infants",
    synonyms: ReadonlySet<string>,
    min: number,
  ) => {
    const { mapping, value } = singleText(
      collectCandidates(source, synonyms, () => null, "contact.none"),
      (v) => {
        const n = toInt(v);
        return n !== null && n >= min ? null : "bad-count";
      },
    );
    fields[field] = mapping;
    draft[field] = value === null ? null : Number(value.trim());
  };
  count("adults", SYNONYMS.adults, 1);
  count("rooms", SYNONYMS.rooms, 0);
  count("childrenWithBed", SYNONYMS.childrenWithBed, 0);
  count("childrenWithoutBed", SYNONYMS.childrenWithoutBed, 0);
  count("infants", SYNONYMS.infants, 0);

  // Services: raw WACRM values preserved (multi-value cells split);
  // no Travel CRM enum conversion in Phase 1.
  {
    const cands = collectCandidates(source, SYNONYMS.services, () => null, "contact.none");
    if (cands.length === 0) {
      fields.services = { status: "missing" };
    } else if (cands.length > 1) {
      fields.services = {
        status: "ambiguous",
        candidates: cands.map((c) => c.value),
      };
    } else {
      const values = splitMulti(cands[0].value);
      if (values.length === 0) {
        fields.services = { status: "missing" };
      } else {
        fields.services = { status: "available", source: cands[0].source };
        draft.services = values;
      }
    }
  }

  // Itinerary: destination drives rows; city/nights broadcast when
  // singular or zip when equal-length; otherwise single raw row.
  {
    const dests = collectCandidates(source, SYNONYMS.destination, () => null, "contact.none");
    const cities = collectCandidates(source, SYNONYMS.city, () => null, "contact.none");
    const nights = collectCandidates(source, SYNONYMS.nights, () => null, "contact.none");
    const pick = (
      list: Candidate[],
    ): { status: TravelCrmFieldStatus; values: string[]; source?: Candidate["source"]; candidates?: string[] } => {
      if (list.length === 0) return { status: "missing", values: [] };
      if (list.length > 1) {
        return {
          status: "ambiguous",
          values: [],
          candidates: list.map((c) => c.value),
        };
      }
      return { status: "available", values: splitMulti(list[0].value), source: list[0].source };
    };
    const d = pick(dests);
    const ci = pick(cities);
    const n = pick(nights);
    if (d.status === "ambiguous" || ci.status === "ambiguous" || n.status === "ambiguous") {
      const cands: string[] = [
        ...(d.candidates ?? []),
        ...(ci.candidates ?? []),
        ...(n.candidates ?? []),
      ];
      fields.itinerary = { status: "ambiguous", candidates: cands };
    } else if (d.values.length === 0) {
      fields.itinerary = { status: "missing" };
    } else {
      const cityVals = ci.values.length > 0 ? ci.values : [""];
      const nightVals = n.values.length > 0 ? n.values : [""];
      const expandable =
        (cityVals.length === 1 || cityVals.length === d.values.length) &&
        (nightVals.length === 1 || nightVals.length === d.values.length);
      if (!expandable) {
        fields.itinerary = {
          status: "ambiguous",
          candidates: [...d.values, ...ci.values, ...nightVals],
        };
      } else {
        const badNight =
          n.status === "available" &&
          nightVals.some((v) => v !== "" && toInt(v) === null);
        if (badNight) {
          fields.itinerary = { status: "invalid", reason: "bad-count" };
        } else {
          fields.itinerary = {
            status: "available",
            source: d.source ?? ci.source ?? n.source,
          };
          draft.itinerary = d.values.map((dest, i) => {
            const city = cityVals.length === 1 ? cityVals[0] : cityVals[i];
            const night = nightVals.length === 1 ? nightVals[0] : nightVals[i];
            return {
              country: dest,
              destination: city && city !== "" ? city : null,
              nights: night && night !== "" ? Number(night) : null,
            };
          });
        }
      }
    }
  }

  // No WACRM equivalent exists for leadType/leadStage — always
  // missing here. leadSource is inferred from WACRM source fields
  // below; only Facebook/Instagram resolve automatically.
  fields.leadType = { status: "missing" };
  fields.leadStage = { status: "missing" };

  // Received inference: normalize every WACRM source text to a
  // supported Travel CRM option ("Facebook" → "Facebook Ads",
  // "WhatsApp" → "Whatsapp", "Website" → "Website", …). The
  // ad-platform icon signal (same contacts.source_url the Lead
  // Source column renders) joins as one more vote — never an
  // override. Unanimous normalized meanings resolve to available;
  // any disagreement stays ambiguous (never guess); unmappable
  // values stay missing for manual selection.
  {
    const srcCands = collectCandidates(
      source,
      SYNONYMS.leadSource,
      () => null,
      "contact.none",
    );
    const distinct = [...new Set(srcCands.map((c) => c.value))];
    const platformLabel =
      source.adSourcePlatform === "facebook"
        ? "Facebook Ads"
        : source.adSourcePlatform === "instagram"
          ? "Instagram Ads"
          : null;
    const textSource = srcCands.length > 0 ? srcCands[0].source : null;
    if (distinct.length === 0) {
      if (platformLabel !== null) {
        fields.leadSource = {
          status: "available",
          source: { kind: "contact", key: "contact.source_url" },
        };
        draft.leadSource = platformLabel;
      } else {
        fields.leadSource = { status: "missing" };
      }
    } else {
      const canonical = distinct.map((v) => canonicalizeReceivedText(v));
      const resolvedMeanings = new Set(
        canonical.filter(
          (l): l is (typeof RECEIVED_LABELS)[number] => l !== null,
        ),
      );
      const agrees =
        canonical.every((l) => l !== null) &&
        resolvedMeanings.size === 1 &&
        (platformLabel === null || platformLabel === [...resolvedMeanings][0]);
      if (agrees && textSource !== null) {
        fields.leadSource = { status: "available", source: textSource };
        draft.leadSource = [...resolvedMeanings][0];
      } else {
        // Conflict or unmappable mix: surface everything, decide nothing.
        const candidates = [...distinct];
        if (platformLabel !== null && !candidates.includes(platformLabel)) {
          candidates.push(platformLabel);
        }
        if (candidates.length > 1 || platformLabel !== null) {
          fields.leadSource = { status: "ambiguous", candidates };
        } else {
          fields.leadSource = { status: "missing" };
        }
      }
    }
  }

  // Assigned owner email arrives resolved (or null) from the server.
  {
    const normalized =
      typeof assignedToEmail === "string" ? assignedToEmail.trim().toLowerCase() : "";
    if (!normalized) {
      fields.assignedToEmail = { status: "missing" };
    } else if (!EMAIL_RE.test(normalized)) {
      fields.assignedToEmail = { status: "invalid", reason: "bad-email" };
    } else {
      fields.assignedToEmail = { status: "available" };
      draft.assignedToEmail = normalized;
    }
  }

  const available: string[] = [];
  const missing: string[] = [];
  const ambiguous: TravelCrmAmbiguity[] = [];
  const invalid: TravelCrmInvalid[] = [];
  // Email and rooms are optional in Travel CRM: absence is never
  // reported as missing (present values still map; bad values
  // still report invalid).
  // Optional fields are never "missing": email and rooms need no
  // value to proceed, and dateOfBirth is optional in Travel CRM
  // itself (optionalDate in both the core lead schema and the
  // WACRM contract) — an empty DOB must not block creation nor
  // appear in missing[]. Provided values still map normally.
  // Children (CWB/CWOB) and Infants are optional traveler counts
  // in the Travel CRM contract (defaults to 0; the WACRM payload
  // schema marks them nullable + optional) — an empty value never
  // blocks creation, so they must not surface in missing[] either.
  // Adults stays REQUIRED (the Travel CRM lead schema defaults it
  // to 1; WACRM's dialog confirms it, and the count feeds the
  // traveler summary).
  const NEVER_MISSING = new Set([
    "email",
    "rooms",
    "dateOfBirth",
    "childrenWithBed",
    "childrenWithoutBed",
    "infants",
  ]);
  for (const [field, m] of Object.entries(fields)) {
    if (m.status === "available") available.push(field);
    else if (m.status === "missing") {
      if (!NEVER_MISSING.has(field)) missing.push(field);
    } else if (m.status === "ambiguous") {
      ambiguous.push({ field, candidates: m.candidates ?? [] });
    } else {
      invalid.push({ field, reason: m.reason ?? "invalid" });
    }
  }
  const ready = isTravelCrmReady(fields);
  return { draft, fields, available, missing, ambiguous, invalid, ready };
}
/** Required fields WACRM itself can satisfy (excludes funnel fields). */
const MAPPABLE_REQUIRED = [
  "customerName",
  "phone",
  "assignedToEmail",
  "travelStartDate",
  "adults",
  "services",
  "itinerary",
];

/**
 * True when every WACRM-mappable required field is AVAILABLE.
 * Exported so the route can recompute readiness after applying
 * flow service defaults (which live outside the mapper).
 */
export function isTravelCrmReady(
  fields: Record<string, TravelCrmFieldMapping>,
): boolean {
  return MAPPABLE_REQUIRED.every(
    (f) => fields[f]?.status === "available",
  );
}
