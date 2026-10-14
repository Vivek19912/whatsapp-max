// ============================================================
// Travel CRM per-flow departure defaults (country + city).
//
// Workspace → Travel CRM Settings stores one departure default
// per (account, flow), next to services/itinerary in
// travel_crm_flow_settings (migration 103).
//
// Source of truth: country names from the copied world-countries
// list and Indian cities from src/data/indian-cities.json, both via
// departure-catalog.ts — WACRM never calls Travel CRM for
// this list and never hardcodes its own values. Stored values
// ARE bare city names (Travel CRM persists
// departureCountry/departureCity as free text).
// ============================================================

import { TRAVEL_CRM_MAX_LOCATION_LENGTH } from "./itineraries";
import {
  isDepartureCityInCountry,
  isDepartureCountry,
} from "./departure-catalog";

export interface TravelCrmDepartureDefaults {
  /** Departure country name, exactly as in the copied catalog. */
  country: string;
  /** Departure city name, or null. Exactly as in the catalog. */
  city: string | null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate + normalize departure defaults for storage. Both empty
 * (or absent/null) normalizes to null (no defaults — the dialog
 * stays empty). A city without a country is rejected. Lengths are
 * capped like other Travel CRM location identifiers. Preserves
 * catalog values verbatim.
 */
export function normalizeDepartureDefaults(
  value: unknown,
): TravelCrmDepartureDefaults | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Departure defaults must be an object.");
  }
  const rec = value as Record<string, unknown>;
  const country = asNonEmptyString(rec.country);
  const city = asNonEmptyString(rec.city);
  if (!country && !city) return null;
  if (!country && city) {
    throw new Error("Select a departure country for the city.");
  }
  if (
    (country && country.length > TRAVEL_CRM_MAX_LOCATION_LENGTH) ||
    (city && city.length > TRAVEL_CRM_MAX_LOCATION_LENGTH)
  ) {
    throw new Error("Departure country or city name is too long.");
  }
  return { country: country as string, city };
}

/**
 * Validate normalized defaults against the catalog: the country
 * must be listed, the city (when set) must belong to that
 * country's list (JSON-backed Indian list, else curated list).
 * Throws with a human-readable message otherwise.
 * Case-insensitive, like the form's matching.
 */
export function validateDepartureCatalog(
  defaults: TravelCrmDepartureDefaults,
): void {
  if (!isDepartureCountry(defaults.country)) {
    throw new Error("Unknown departure country.");
  }
  if (defaults.city === null) return;
  if (!isDepartureCityInCountry(defaults.country, defaults.city as string)) {
    throw new Error("Departure city does not belong to the selected country.");
  }
}
