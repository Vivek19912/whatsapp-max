// ============================================================
// Travel CRM per-flow itinerary defaults.
//
// Workspace → Travel CRM Settings stores one itinerary list per
// (account, flow). Destination + City values are ALWAYS stable
// Travel CRM identifiers (the `value` from live lookup options),
// never invented display text. Nights is a positive integer.
//
// Lookup source of truth: the existing Travel CRM server-to-
// server lookups endpoint
//   GET {base}/api/integrations/wacrm/lookups
// fetched via fetchTravelCrmLookups (same auth as services).
// This module only PARSSES that payload — it never hardcodes
// destination or city values. Supported shapes (all optional,
// first usable wins, merged + deduped):
//   destinations: lookups.destinations | lookups.countries | ...
//   cities:       lookups.cities | nested `cities` on a
//                 destination | lookups.destinationCities map
// City → destination linkage is read from the city's parent
// fields (destination/country/parent + variants) or from
// nesting / mapping keys — never inferred from names.
// ============================================================

export interface TravelCrmItineraryDefault {
  /** Stable Travel CRM destination identifier (lookup `value`). */
  destination: string;
  /** Stable Travel CRM city identifier (lookup `value`). */
  city: string;
  /** Positive integer nights. */
  nights: number;
}

export interface TravelCrmDestinationOption {
  value: string;
  label: string;
  /**
   * Grouping country from the lookup feed (Travel CRM destination
   * `countryName`), or null/undefined when the feed omits it.
   * Never invented — grouping stays dormant without it.
   */
  countryName?: string | null;
  /**
   * Internal display name from the lookup feed (Travel CRM
   * destination `privateName`), or null/undefined when absent.
   * Search/display only — never submitted or stored.
   */
  privateName?: string | null;
}

export interface TravelCrmCityOption {
  value: string;
  label: string;
  /** Parent destination `value` when the lookup provides one. */
  destinationValue: string | null;
}

export const TRAVEL_CRM_MAX_ITINERARY_ROWS = 50;
export const TRAVEL_CRM_MAX_NIGHTS = 365;
export const TRAVEL_CRM_MAX_LOCATION_LENGTH = 120;

/** Canonical lookup key for destination options (stable master IDs). */
const DESTINATION_LOOKUP_KEY = "destinations" as const;

/** Legacy display-name keys, fallback only when `destinations` is absent. */
const LEGACY_DESTINATION_LOOKUP_KEYS = [
  "countries",
  "itineraryDestinations",
  "destinationList",
  "countryList",
] as const;

/** Canonical lookup key for city options (with parent linkage). */
const CITY_LOOKUP_KEY = "cities" as const;

/** Legacy city keys, fallback only when `cities` carries no linkage. */
const LEGACY_CITY_LOOKUP_KEYS = [
  "itineraryCities",
  "cityList",
  "destinationCities",
  "countryCities",
] as const;

/** Fields on a city object that may point at its destination. */
const CITY_PARENT_FIELDS = [
  "destinationValue",
  "destination",
  "destinationId",
  "destination_id",
  "countryValue",
  "country",
  "countryId",
  "country_id",
  "parent",
  "parentValue",
  "parentId",
  "parent_id",
] as const;

/** Fields on a generic option object that may hold the value. */
const OPTION_VALUE_FIELDS = ["value", "id", "code", "key"] as const;

/** Fields on a generic option object that may hold the label. */
const OPTION_LABEL_FIELDS = ["label", "name", "title", "displayName"] as const;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionValue(raw: Record<string, unknown>): string | null {
  for (const key of OPTION_VALUE_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function readOptionLabel(
  raw: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of OPTION_LABEL_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

function readParentValue(raw: Record<string, unknown>): string | null {
  for (const key of CITY_PARENT_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (Array.isArray(v)) {
      const first = v.find(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
      if (first) return first.trim();
    }
  }
  return null;
}

/** Fields on a destination record that may hold the grouping country. */
const DESTINATION_COUNTRY_FIELDS = ["countryName", "country", "country_name"] as const;

/** Fields on a destination record that may hold the private name. */
const DESTINATION_PRIVATE_NAME_FIELDS = ["privateName", "private_name"] as const;

/** Trimmed text or null (blank/missing degrade to null, never invented). */
function readOptionalText(
  raw: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pushUnique(
  list: TravelCrmDestinationOption[],
  seen: Set<string>,
  value: string,
  label: string,
  countryName: string | null = null,
  privateName: string | null = null,
): void {
  if (seen.has(value)) return;
  seen.add(value);
  list.push({ value, label: label || value, countryName, privateName });
}

function parseOptionList(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ value: t, label: t });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/** Parse one raw list into deduped destination pairs (metadata preserved). */
function collectOptions(raw: unknown): TravelCrmDestinationOption[] {
  const out: TravelCrmDestinationOption[] = [];
  const seen = new Set<string>();
  for (const rec of parseOptionList(raw)) {
    const value = readOptionValue(rec);
    if (!value) continue;
    pushUnique(
      out,
      seen,
      value,
      readOptionLabel(rec, value),
      readOptionalText(rec, DESTINATION_COUNTRY_FIELDS),
      readOptionalText(rec, DESTINATION_PRIVATE_NAME_FIELDS),
    );
  }
  return out;
}

/**
 * Extract destination options from a live Travel CRM lookups
 * payload. The canonical `destinations` key (stable master IDs)
 * wins outright when present: legacy display-name lists
 * (`countries`, …) are only a fallback for older servers, never
 * merged — merging would create two visually identical options
 * (one master entry by ID plus one legacy entry by display name)
 * and selecting the legacy one breaks city linkage. Returns [] when
 * nothing usable exists — callers must render loading/error
 * states, never fake values. Country/private-name metadata rides
 * along untouched (null when the feed omits it) for grouped,
 * private-name-searchable dropdowns downstream.
 */
export function extractDestinationOptions(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmDestinationOption[] {
  if (!lookups || typeof lookups !== "object") return [];
  const primary = collectOptions(lookups[DESTINATION_LOOKUP_KEY]);
  if (primary.length > 0) return primary;
  const out: TravelCrmDestinationOption[] = [];
  const seen = new Set<string>();
  for (const key of LEGACY_DESTINATION_LOOKUP_KEYS) {
    for (const option of collectOptions(lookups[key])) {
      pushUnique(out, seen, option.value, option.label);
    }
  }
  return out;
}

/**
 * Extract city options (with parent destination linkage when the
 * lookup provides it) from a live Travel CRM lookups payload.
 *
 * The canonical flat `cities` list wins outright when any of its
 * entries carries parent linkage: legacy unlinked lists are then
 * ignored rather than merged, because merging would inject
 * linkage-free entries that city filtering must exclude anyway.
 * When `cities` carries no linkage at all, legacy keys are merged
 * as a fallback for older servers (free pairing, server validates).
 * Handles flat lists, nested `cities` on destinations, and
 * `{destinationValue: [...]}` mapping objects. Returns [] when
 * nothing usable exists.
 */
export function extractCityOptions(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmCityOption[] {
  if (!lookups || typeof lookups !== "object") return [];
  const out: TravelCrmCityOption[] = [];
  const seen = new Set<string>();

  const pushCity = (value: string, label: string, parent: string | null) => {
    const key = `${parent ?? ""}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, label: label || value, destinationValue: parent });
  };

  const pushCityRecords = (
    records: Array<Record<string, unknown>>,
    fallbackParent: string | null,
  ): boolean => {
    let linked = false;
    for (const rec of records) {
      const value = readOptionValue(rec);
      if (!value) continue;
      const parent = readParentValue(rec) ?? fallbackParent;
      if (parent !== null) linked = true;
      pushCity(value, readOptionLabel(rec, value), parent);
    }
    return linked;
  };

  const pushMapping = (raw: unknown): boolean => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    let linked = false;
    for (const [destKey, cityList] of Object.entries(raw as Record<string, unknown>)) {
      const parent = destKey.trim() || null;
      if (pushCityRecords(parseOptionList(cityList), parent) && parent !== null) linked = true;
    }
    return linked;
  };

  // 1. Canonical flat `cities` list.
  const primaryRaw = lookups[CITY_LOOKUP_KEY];
  let primaryLinked = false;
  if (Array.isArray(primaryRaw)) {
    primaryLinked = pushCityRecords(parseOptionList(primaryRaw), null);
  } else if (primaryRaw && typeof primaryRaw === "object") {
    // 2. Mapping object under the canonical key: { <destinationValue>: [...] }.
    primaryLinked = pushMapping(primaryRaw);
  }

  // Legacy keys only when the canonical list carries no linkage.
  if (!primaryLinked) {
    for (const key of LEGACY_CITY_LOOKUP_KEYS) {
      const raw = lookups[key];
      if (Array.isArray(raw)) {
        pushCityRecords(parseOptionList(raw), null);
      } else {
        pushMapping(raw);
      }
    }
  }

  // 3. Nested `cities` on destination objects (canonical + legacy keys).
  for (const key of [DESTINATION_LOOKUP_KEY, ...LEGACY_DESTINATION_LOOKUP_KEYS]) {
    for (const rec of parseOptionList(lookups[key])) {
      const destValue = readOptionValue(rec);
      if (!destValue) continue;
      const nested = (rec as Record<string, unknown>).cities;
      for (const cityRec of parseOptionList(nested)) {
        const value = readOptionValue(cityRec);
        if (!value) continue;
        pushCity(
          value,
          readOptionLabel(cityRec, value),
          readParentValue(cityRec) ?? destValue,
        );
      }
    }
  }

  return out;
}

export interface TravelCrmItineraryLookups {
  destinations: TravelCrmDestinationOption[];
  cities: TravelCrmCityOption[];
  /** Cities grouped by parent destination `value`. */
  citiesByDestination: Record<string, TravelCrmDestinationOption[]>;
}

/**
 * Build the full itinerary lookup view from a live Travel CRM
 * lookups payload. Pure + deterministic. Never hardcodes values.
 */
export function buildItineraryLookups(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmItineraryLookups {
  const destinations = extractDestinationOptions(lookups);
  const cities = extractCityOptions(lookups);
  const citiesByDestination: Record<string, TravelCrmDestinationOption[]> = {};
  for (const c of cities) {
    if (!c.destinationValue) continue;
    const list = (citiesByDestination[c.destinationValue] ??= []);
    if (!list.some((o) => o.value === c.value)) {
      list.push({ value: c.value, label: c.label });
    }
  }
  return { destinations, cities, citiesByDestination };
}

/**
 * Cities valid for one destination. When the lookup provides no
 * parent linkage at all (all destinationValue null), every city
 * is returned — the dialog still lets the agent pick, and Travel
 * CRM validates authoritatively. Otherwise only linked cities.
 */
export function citiesForDestination(
  cities: ReadonlyArray<{
    value: string;
    label: string;
    destinationValue?: string | null;
  }>,
  destinationValue: string,
): Array<{ value: string; label: string; destinationValue: string | null }> {
  const normalized = cities.map((c) => ({
    value: c.value,
    label: (c as { label?: unknown }).label as string,
    destinationValue: c.destinationValue ?? null,
  }));
  const linked = normalized.filter((c) => c.destinationValue !== null);
  if (linked.length === 0) return [...normalized];
  return normalized.filter((c) => c.destinationValue === destinationValue);
}

/**
 * Resolve a destination `value` (stable ID) to its display label.
 * Returns null when no matching option exists — callers must render
 * a safe fallback ("Select" / "Unknown destination"), never the raw
 * ID. Stored values stay intact; only display is affected.
 */
export function destinationLabelForValue(
  destinations: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): string | null {
  const match = destinations.find((o) => o.value === value);
  return match ? match.label : null;
}

/**
 * Resolve a city `value` (stable ID) to its display label within an
 * option list (typically already filtered to the selected
 * destination). Returns null when no matching option exists —
 * callers must render a safe fallback, never the raw ID.
 */
export function cityLabelForValue(
  cities: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): string | null {
  const match = cities.find((o) => o.value === value);
  return match ? match.label : null;
}

/**
 * Resolve a stored option value for Select display: returns the value
 * unchanged when a matching option exists, otherwise undefined so the
 * control renders its placeholder ("Select") instead of a raw UUID.
 * Stored state is never modified — display only.
 */
export function resolveSelectValue(
  options: ReadonlyArray<{ value: string }>,
  value: string,
): string | undefined {
  if (!value) return undefined;
  return options.some((o) => o.value === value) ? value : undefined;
}

/**
 * True when `cityValue` may be kept for `destinationValue`:
 * either the lookup links it to that destination, or the lookup
 * provides no linkage at all (free pairing, server validates).
 */
export function isCompatibleCity(
  cities: ReadonlyArray<{
    value: string;
    destinationValue?: string | null;
  }>,
  destinationValue: string,
  cityValue: string,
): boolean {
  const linked = cities.filter((c) => (c.destinationValue ?? null) !== null);
  if (linked.length === 0) return true;
  return linked.some(
    (c) => c.value === cityValue && (c.destinationValue ?? null) === destinationValue,
  );
}

/** Validate a nights input (string from UI or number). */
export function validateNightsInput(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return "Nights must be a positive whole number.";
    }
    if (value > TRAVEL_CRM_MAX_NIGHTS) {
      return `Nights must be at most ${TRAVEL_CRM_MAX_NIGHTS}.`;
    }
    return null;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Nights is required.";
  if (!/^\d+$/.test(text)) return "Nights must be a positive whole number.";
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    return "Nights must be a positive whole number.";
  }
  if (n > TRAVEL_CRM_MAX_NIGHTS) {
    return `Nights must be at most ${TRAVEL_CRM_MAX_NIGHTS}.`;
  }
  return null;
}

function toNights(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Validate + normalize itinerary defaults for storage. Drops
 * empty rows (no destination and no nights); throws with a
 * human-readable message on structurally invalid input or on a
 * non-empty row with an invalid nights value. The per-row city
 * is optional (the Create dialog collects Destination + Nights
 * only) — city-ful rows keep working for saved Settings
 * defaults. Preserves order, keeps stable Travel CRM identifiers
 * verbatim.
 */
export function normalizeItineraryDefaults(
  value: unknown,
): TravelCrmItineraryDefault[] {
  if (!Array.isArray(value)) {
    throw new Error("Itinerary must be a list.");
  }
  if (value.length > TRAVEL_CRM_MAX_ITINERARY_ROWS) {
    throw new Error(
      `Itinerary must have at most ${TRAVEL_CRM_MAX_ITINERARY_ROWS} rows.`,
    );
  }
  const out: TravelCrmItineraryDefault[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Each itinerary row must be an object.");
    }
    const rec = raw as Record<string, unknown>;
    const destination = asNonEmptyString(rec.destination);
    const city = asNonEmptyString(rec.city) ?? "";
    const nightsRaw =
      rec.nights === undefined || rec.nights === null
        ? ""
        : (rec.nights as unknown);
    const nightsText =
      typeof nightsRaw === "string" ? nightsRaw.trim() : nightsRaw;

    const isEmptyRow =
      !destination &&
      (nightsText === "" ||
        nightsText === null ||
        nightsText === undefined);
    if (isEmptyRow) continue;

    if (!destination) continue;

    if (
      destination.length > TRAVEL_CRM_MAX_LOCATION_LENGTH ||
      city.length > TRAVEL_CRM_MAX_LOCATION_LENGTH
    ) {
      throw new Error("Destination or city name is too long.");
    }
    const nights = toNights(nightsRaw);
    const nightsError = validateNightsInput(
      typeof nightsRaw === "number" ? nightsRaw : String(nightsRaw ?? ""),
    );
    if (nights === null || nightsError) {
      throw new Error(
        nightsError ?? "Nights must be a positive whole number.",
      );
    }
    out.push({ destination, city, nights });
  }
  return out;
}

/** Stored defaults → Travel CRM draft rows ({country, destination, nights}). */
export function defaultsToDraftItinerary(
  defaults: readonly TravelCrmItineraryDefault[],
): Array<{ country: string; destination: string; nights: number }> {
  return defaults.map((d) => ({
    country: d.destination,
    destination: d.city,
    nights: d.nights,
  }));
}

/** Draft/prefill rows → stored defaults shape (drops incomplete). */
export function draftToItineraryDefaults(
  rows: ReadonlyArray<{
    country?: unknown;
    destination?: unknown;
    city?: unknown;
    nights?: unknown;
  }>,
): TravelCrmItineraryDefault[] {
  const out: TravelCrmItineraryDefault[] = [];
  for (const r of rows) {
    const dest =
      asNonEmptyString(r.destination) ?? asNonEmptyString(r.city) ?? null;
    // Draft shape uses {country, destination}; prefill shape uses
    // {destination, city}. Accept both without guessing.
    const countryFirst = asNonEmptyString(
      (r as Record<string, unknown>).country,
    );
    const destinationField = asNonEmptyString(
      (r as Record<string, unknown>).destination,
    );
    const cityField = asNonEmptyString((r as Record<string, unknown>).city);
    const resolvedDestination = countryFirst ?? destinationField ?? dest;
    // When the row came from draft ({country, destination}), the
    // city is `destination` and the destination is `country`.
    const finalDestination =
      countryFirst !== null ? countryFirst : resolvedDestination;
    const finalCity =
      countryFirst !== null
        ? (destinationField ?? cityField)
        : (cityField ?? null);
    if (!finalDestination || !finalCity) continue;
    const nights = toNights(r.nights);
    if (nights === null || validateNightsInput(nights) !== null) continue;
    out.push({
      destination: finalDestination,
      city: finalCity,
      nights,
    });
  }
  return out;
}
