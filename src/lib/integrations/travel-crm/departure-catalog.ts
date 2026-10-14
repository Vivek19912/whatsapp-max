// ============================================================
// Departure country/city catalog.
//
// Provenance:
//   Countries:  world-countries@5.1.0 name.common for all 250
//               entries (the same package + accessor the Travel CRM
//               lead form uses).
//   India:      src/data/indian-cities.json { city, state } entries
//               (country-state-city master plus legacy spelling
//               aliases for previously stored values). Label shows the
//               state in parentheses only when one city name spans
//               several states — matching the Travel CRM lead form.
//   Others:     the curated lookups.cities strings from
//               queriesService.lookups() in
//               apps/api/src/modules/queries/queries.service.ts
//               (the list the form shows for non-India countries,
//               as { value: city, label: city }).
//
// City to country rule mirrors the Travel CRM form exactly:
// country India gives the JSON-derived list; otherwise the curated list.
// Stored identifiers ARE bare city names (Travel CRM stores
// departureCountry/departureCity as free text, e.g. India/Delhi).
// ============================================================

import indianCitiesData from "@/data/indian-cities.json";

/** All 250 country names (extraction order). */
export const DEPARTURE_COUNTRIES: readonly string[] = [
  "Aruba",
  "Afghanistan",
  "Angola",
  "Anguilla",
  "Åland Islands",
  "Albania",
  "Andorra",
  "United Arab Emirates",
  "Argentina",
  "Armenia",
  "American Samoa",
  "Antarctica",
  "French Southern and Antarctic Lands",
  "Antigua and Barbuda",
  "Australia",
  "Austria",
  "Azerbaijan",
  "Burundi",
  "Belgium",
  "Benin",
  "Burkina Faso",
  "Bangladesh",
  "Bulgaria",
  "Bahrain",
  "Bahamas",
  "Bosnia and Herzegovina",
  "Saint Barthélemy",
  "Saint Helena, Ascension and Tristan da Cunha",
  "Belarus",
  "Belize",
  "Bermuda",
  "Bolivia",
  "Caribbean Netherlands",
  "Brazil",
  "Barbados",
  "Brunei",
  "Bhutan",
  "Bouvet Island",
  "Botswana",
  "Central African Republic",
  "Canada",
  "Cocos (Keeling) Islands",
  "Switzerland",
  "Chile",
  "China",
  "Ivory Coast",
  "Cameroon",
  "DR Congo",
  "Republic of the Congo",
  "Cook Islands",
  "Colombia",
  "Comoros",
  "Cape Verde",
  "Costa Rica",
  "Cuba",
  "Curaçao",
  "Christmas Island",
  "Cayman Islands",
  "Cyprus",
  "Czechia",
  "Germany",
  "Djibouti",
  "Dominica",
  "Denmark",
  "Dominican Republic",
  "Algeria",
  "Ecuador",
  "Egypt",
  "Eritrea",
  "Western Sahara",
  "Spain",
  "Estonia",
  "Ethiopia",
  "Finland",
  "Fiji",
  "Falkland Islands",
  "France",
  "Faroe Islands",
  "Micronesia",
  "Gabon",
  "United Kingdom",
  "Georgia",
  "Guernsey",
  "Ghana",
  "Gibraltar",
  "Guinea",
  "Guadeloupe",
  "Gambia",
  "Guinea-Bissau",
  "Equatorial Guinea",
  "Greece",
  "Grenada",
  "Greenland",
  "Guatemala",
  "French Guiana",
  "Guam",
  "Guyana",
  "Hong Kong",
  "Heard Island and McDonald Islands",
  "Honduras",
  "Croatia",
  "Haiti",
  "Hungary",
  "Indonesia",
  "Isle of Man",
  "India",
  "British Indian Ocean Territory",
  "Ireland",
  "Iran",
  "Iraq",
  "Iceland",
  "Israel",
  "Italy",
  "Jamaica",
  "Jersey",
  "Jordan",
  "Japan",
  "Kazakhstan",
  "Kenya",
  "Kyrgyzstan",
  "Cambodia",
  "Kiribati",
  "Saint Kitts and Nevis",
  "South Korea",
  "Kosovo",
  "Kuwait",
  "Laos",
  "Lebanon",
  "Liberia",
  "Libya",
  "Saint Lucia",
  "Liechtenstein",
  "Sri Lanka",
  "Lesotho",
  "Lithuania",
  "Luxembourg",
  "Latvia",
  "Macau",
  "Saint Martin",
  "Morocco",
  "Monaco",
  "Moldova",
  "Madagascar",
  "Maldives",
  "Mexico",
  "Marshall Islands",
  "North Macedonia",
  "Mali",
  "Malta",
  "Myanmar",
  "Montenegro",
  "Mongolia",
  "Northern Mariana Islands",
  "Mozambique",
  "Mauritania",
  "Montserrat",
  "Martinique",
  "Mauritius",
  "Malawi",
  "Malaysia",
  "Mayotte",
  "Namibia",
  "New Caledonia",
  "Niger",
  "Norfolk Island",
  "Nigeria",
  "Nicaragua",
  "Niue",
  "Netherlands",
  "Norway",
  "Nepal",
  "Nauru",
  "New Zealand",
  "Oman",
  "Pakistan",
  "Panama",
  "Pitcairn Islands",
  "Peru",
  "Philippines",
  "Palau",
  "Papua New Guinea",
  "Poland",
  "Puerto Rico",
  "North Korea",
  "Portugal",
  "Paraguay",
  "Palestine",
  "French Polynesia",
  "Qatar",
  "Réunion",
  "Romania",
  "Russia",
  "Rwanda",
  "Saudi Arabia",
  "Sudan",
  "Senegal",
  "Singapore",
  "South Georgia",
  "Svalbard and Jan Mayen",
  "Solomon Islands",
  "Sierra Leone",
  "El Salvador",
  "San Marino",
  "Somalia",
  "Saint Pierre and Miquelon",
  "Serbia",
  "South Sudan",
  "São Tomé and Príncipe",
  "Suriname",
  "Slovakia",
  "Slovenia",
  "Sweden",
  "Eswatini",
  "Sint Maarten",
  "Seychelles",
  "Syria",
  "Turks and Caicos Islands",
  "Chad",
  "Togo",
  "Thailand",
  "Tajikistan",
  "Tokelau",
  "Turkmenistan",
  "Timor-Leste",
  "Tonga",
  "Trinidad and Tobago",
  "Tunisia",
  "Türkiye",
  "Tuvalu",
  "Taiwan",
  "Tanzania",
  "Uganda",
  "Ukraine",
  "United States Minor Outlying Islands",
  "Uruguay",
  "United States",
  "Uzbekistan",
  "Vatican City",
  "Saint Vincent and the Grenadines",
  "Venezuela",
  "British Virgin Islands",
  "United States Virgin Islands",
  "Vietnam",
  "Vanuatu",
  "Wallis and Futuna",
  "Samoa",
  "Yemen",
  "South Africa",
  "Zambia",
  "Zimbabwe",
];

/**
 * India departure cities, derived from the local JSON master
 * (src/data/indian-cities.json: { city, state } entries).
 *
 * value = bare city name = stored identifier (Travel CRM persists
 * departureCountry/departureCity as free text, e.g. India/Delhi), so the
 * submitted departureCity is always the bare name — never the display
 * label, never a database ID.
 * label = city name, with the state in parentheses when the same city
 * name exists in more than one state (e.g. Aurangabad (Bihar) vs
 * Aurangabad (Maharashtra)) — matching the Travel CRM lead form.
 * Duplicate-name states therefore yield distinct options sharing one
 * value; renderers must key items by value + label, not value alone.
 */

interface IndianCityEntry {
  city: string;
  state: string;
}

function indianCityEntries(): IndianCityEntry[] {
  const raw: unknown = (indianCitiesData as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return [];
  const out: IndianCityEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.city !== "string" || typeof rec.state !== "string") continue;
    const city = rec.city.trim();
    const state = rec.state.trim();
    if (!city || !state) continue;
    out.push({ city, state });
  }
  return out;
}

const INDIAN_CITY_ENTRIES: readonly IndianCityEntry[] = indianCityEntries();

/** How many states each city name appears in (for duplicate labels). */
const INDIAN_CITY_STATE_COUNT: ReadonlyMap<string, number> = (() => {
  const statesByCity = new Map<string, Set<string>>();
  for (const e of INDIAN_CITY_ENTRIES) {
    let set = statesByCity.get(e.city);
    if (!set) {
      set = new Set<string>();
      statesByCity.set(e.city, set);
    }
    set.add(e.state);
  }
  const counts = new Map<string, number>();
  for (const [city, states] of statesByCity) counts.set(city, states.size);
  return counts;
})();

export const INDIAN_DEPARTURE_CITIES: readonly { value: string; label: string }[] =
  INDIAN_CITY_ENTRIES.map((e) => ({
    value: e.city,
    label:
      (INDIAN_CITY_STATE_COUNT.get(e.city) ?? 1) > 1
        ? `${e.city} (${e.state})`
        : e.city,
  }));

/** Curated cities the form offers for non-India countries. */
export const OTHER_DEPARTURE_CITIES: readonly { value: string; label: string }[] = [
  {
    "value": "Delhi",
    "label": "Delhi"
  },
  {
    "value": "Mumbai",
    "label": "Mumbai"
  },
  {
    "value": "Bengaluru",
    "label": "Bengaluru"
  },
  {
    "value": "Dubai",
    "label": "Dubai"
  },
  {
    "value": "Bangkok",
    "label": "Bangkok"
  },
  {
    "value": "Singapore",
    "label": "Singapore"
  },
  {
    "value": "Bali",
    "label": "Bali"
  },
  {
    "value": "Malé",
    "label": "Malé"
  },
  {
    "value": "London",
    "label": "London"
  },
  {
    "value": "Paris",
    "label": "Paris"
  }
];

export interface DepartureCityOption {
  value: string;
  label: string;
}

/**
 * Workspace → Create in Travel CRM default departure country.
 * Resolved from the copied Travel CRM country master data above
 * (value = stored identifier = display name, e.g. India/Delhi) —
 * never an invented identifier. Scoped to the Workspace creation
 * dialog only; global defaults and other Travel CRM forms are
 * untouched.
 */
export const DEFAULT_DEPARTURE_COUNTRY: string =
  DEPARTURE_COUNTRIES.find((c) => c.toLowerCase() === "india") ?? "India";

/**
 * Cities offered for one departure country — the exact rule from
 * the Travel CRM lead form: India yields the INDIAN list, every
 * other country yields the curated list. Pure.
 */
export function departureCityOptions(
  country: string,
): readonly DepartureCityOption[] {
  return country.trim() === "India" ? INDIAN_DEPARTURE_CITIES : OTHER_DEPARTURE_CITIES;
}

/** True when the name is one of the copied Travel CRM countries. */
export function isDepartureCountry(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return DEPARTURE_COUNTRIES.some((c) => c.toLowerCase() === normalized);
}

/**
 * True when the city belongs to the country's offered list
 * (India list, else curated list). Case-insensitive, like the
 * form's own matching.
 */
export function isDepartureCityInCountry(country: string, city: string): boolean {
  const wanted = city.trim().toLowerCase();
  if (!wanted) return false;
  return departureCityOptions(country).some((c) => c.value.toLowerCase() === wanted);
}
