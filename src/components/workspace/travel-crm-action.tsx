"use client";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Check, ChevronDown, ExternalLink, Loader2, Plane, Plus, Trash2, X } from
"lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  resolveDisplayServiceLabel,
  TRAVEL_CRM_SERVICE_LABELS,
  joinServiceLabels,
  splitServiceLabels,
} from "@/lib/integrations/travel-crm/services";
import {
  resolveSelectValue,
  validateNightsInput,
} from "@/lib/integrations/travel-crm/itineraries";
import {
  formatPhoneForDisplay,
  resolveDialogPhoneForSubmit,
} from "@/lib/whatsapp/phone-utils";
import {
  LEAD_RECEIVED_FIELD_NAME,
  LEAD_RECEIVED_OPTIONS,
  LEAD_TYPE_FIELD_NAME,
  LEAD_TYPE_OPTIONS,
  STAGE_FIELD_NAME,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import {
  DEFAULT_DEPARTURE_COUNTRY,
  DEPARTURE_COUNTRIES,
  departureCityOptions,
  isDepartureCityInCountry,
} from "@/lib/integrations/travel-crm/departure-catalog";
import { getSelectChip } from "@/lib/flows/workspace-select-chips";
import {
  filterCellOptions,
  OPTION_SEARCH_THRESHOLD,
  OptionSearchBox,
  SELECT_CELL_TRIGGER_CLASS,
  SelectChipView,
} from "./custom-cell";

interface MappingPayload {
  available: string[];
  missing: string[];
  ambiguous: Array<{ field: string; candidates: string[] }>;
  invalid: Array<{ field: string; reason: string }>;
  ready: boolean;
}

interface LookupOption {
  value: string;
  label: string;
  destinationValue?: string | null;
}

interface PrepareResult {
  success: boolean;
  code: string;
  error?: string;
  fields?: Record<string, string[]>;
  leadId?: string;
  leadUrl?: string;
  alreadyExists?: boolean;
  mapping?: MappingPayload;
  prefill?: Record<string, unknown>;
  options?: Record<string, LookupOption[] | null> | null;
  receivedOptions?: LookupOption[] | null;
  destinations?: LookupOption[] | null;
  cities?: LookupOption[] | null;
  citiesByDestination?: Record<string, LookupOption[]> | null;
  assignedOwnerEmail?: string | null;
  assignmentIssue?: string | null;
  /** Per-flow configured service labels for the dialog Services section. */
  configuredServices?: string[] | null;
  workspaceSync?: {
    updated: string[];
    failed: Array<{ field: string; error: string }>;
    rowPatch: {
      answers: Record<string, string | null>;
      name: string | null;
      phone: string | null;
    };
  };
}

/** Workspace row patch applied after a synced create (table + drawer). */
export interface WorkspaceRowPatch {
  answers: Record<string, string | null>;
  name: string | null;
  phone: string | null;
  /** Custom-field cell values by workspace field id (Type/Stage/Received). */
  customValues: Record<string, string | null>;
}

interface TeamMember {
  user_id: string;
  full_name: string | null;
  email?: string | null;
}

export interface DialogInput {
  field: string;
  label: string;
  kind: "member" | "date" | "text" | "number" | "select" | "multi" | "itinerary" | "travelers";
  value: unknown;
  options?: LookupOption[] | null;
  cities?: LookupOption[] | null;
  citiesByDestination?: Record<string, LookupOption[]> | null;
  hint?: string;
}

/**
 * Editable traveler counts + per-child ages for the Travelers
 * section. Counts stay strings while typing (validated on
 * submit); each age row is one optional string entry.
 */
export interface TravelerForm {
  adults: string;
  cwb: string;
  cwob: string;
  infants: string;
  cwbAges: string[];
  cwobAges: string[];
  infantAges: string[];
}

/** Maximum age accepted per optional age entry. */
export const MAX_TRAVELER_AGE = 99;

function prefillCount(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : fallback;
}

function prefillAges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map(String);
}

/**
 * Seed the Travelers section from prefill (stable values echoed
 * by the server, including the agent's own entries on dialog
 * re-rounds). Adults falls back to "1" — Travel CRM requires at
 * least one adult — while children/infants stay empty (optional)
 * and ages start blank.
 */
export function seedTravelerForm(prefill: Record<string, unknown>): TravelerForm {
  return {
    adults: prefillCount(prefill.adults, "1"),
    cwb: prefillCount(prefill.childrenWithBed, ""),
    cwob: prefillCount(prefill.childrenWithoutBed, ""),
    infants: prefillCount(prefill.infants, ""),
    cwbAges: prefillAges(prefill.childrenWithBedAges),
    cwobAges: prefillAges(prefill.childrenWithoutBedAges),
    infantAges: prefillAges(prefill.infantAges),
  };
}

/** Parse a non-negative count input; NaN when blank/invalid. */
export function travelerAgeCount(countText: string): number {
  if (!/^\d+$/.test(countText.trim())) return 0;
  const n = Number(countText.trim());
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * Resize age rows to a count: shrinking drops the extra rows
 * (their values are discarded safely), growing pads blanks.
 * Never mutates the input.
 */
export function resizeAgeRows(ages: string[], count: number): string[] {
  const next = ages.slice(0, Math.max(0, count));
  while (next.length < Math.max(0, count)) next.push("");
  return next;
}

function isWholeNumber(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

/** Inline validation message for an empty Travel Date. */
export const TRAVEL_DATE_REQUIRED_ERROR = "Travel Date is required.";

/**
 * Validate the Travel Date value before Create. Returns
 * TRAVEL_DATE_REQUIRED_ERROR when empty/blank, null when a value is
 * present. Date format/payload mapping is untouched — presence only.
 */
export function validateTravelDateValue(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? null : TRAVEL_DATE_REQUIRED_ERROR;
}

/** Travel-timing mode for the creation dialog (mirrors native Travel CRM). */
export type TravelTimingMode = "exact" | "month";

/** Month names for the Month-mode dropdown (January–December). */
export const TRAVEL_MONTH_NAMES: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Accepted travel-month range (mirrors native Travel CRM validation). */
export const TRAVEL_MONTH_MIN = 1;
export const TRAVEL_MONTH_MAX = 12;
/** Accepted travel-year range (mirrors native Travel CRM validation). */
export const TRAVEL_YEAR_MIN = 1900;
export const TRAVEL_YEAR_MAX = 2100;

/** Current calendar year (year dropdown default + option window anchor). */
export function currentTravelYear(now: Date = new Date()): number {
  return now.getFullYear();
}

/**
 * Year options for the Month-mode dropdown (mirrors native Travel
 * CRM: current−2 through current+10, never hardcoded).
 */
export function travelYearOptions(now: Date = new Date()): string[] {
  const current = currentTravelYear(now);
  const out: string[] = [];
  for (let y = current - 2; y <= current + 10; y++) out.push(String(y));
  return out;
}

export interface TravelTimingSelection {
  mode: TravelTimingMode;
  /** Exact-date text (YYYY-MM-DD from the date input). */
  travelStartDate: string;
  /** Month-mode month number text ("1"–"12"). */
  travelMonth: string;
  /** Month-mode year text. */
  travelYear: string;
}

/**
 * Validate the active travel-timing selection before Create.
 * Exact mode keeps the existing presence-only date behavior;
 * Month mode requires a complete, in-range month/year pair and
 * never invents a day. Returns a message or null when valid.
 */
export function validateTravelTiming(sel: TravelTimingSelection): string | null {
  if (sel.mode === "month") {
    const monthText = sel.travelMonth.trim();
    const yearText = sel.travelYear.trim();
    if (!monthText && !yearText) return "Select a travel month and year.";
    if (!monthText || !yearText) return "Select both a travel month and year.";
    if (!/^\d+$/.test(monthText)) return "Travel month must be between 1 and 12.";
    const month = Number(monthText);
    if (!Number.isSafeInteger(month) || month < TRAVEL_MONTH_MIN || month > TRAVEL_MONTH_MAX) {
      return "Travel month must be between 1 and 12.";
    }
    if (!/^\d+$/.test(yearText)) {
      return `Travel year must be between ${TRAVEL_YEAR_MIN} and ${TRAVEL_YEAR_MAX}.`;
    }
    const year = Number(yearText);
    if (!Number.isSafeInteger(year) || year < TRAVEL_YEAR_MIN || year > TRAVEL_YEAR_MAX) {
      return `Travel year must be between ${TRAVEL_YEAR_MIN} and ${TRAVEL_YEAR_MAX}.`;
    }
    return null;
  }
  return validateTravelDateValue(sel.travelStartDate);
}

/**
 * Clear the inactive timing representation when switching modes
 * (mirrors native Travel CRM: hidden fields can never stay
 * populated and be submitted). Pure.
 */
export function clearInactiveTravelTiming(
  mode: TravelTimingMode,
  state: { travelStartDate: string; travelMonth: string; travelYear: string },
): { travelStartDate: string; travelMonth: string; travelYear: string } {
  if (mode === "month") return { ...state, travelStartDate: "" };
  return { ...state, travelMonth: "", travelYear: "" };
}

/**
 * Timing payload shapes. Exact submits the date string exactly as
 * before; Month submits numeric month/year with no invented day
 * (the Phase 2 Travel CRM contract accepts both shapes).
 */
export type TravelTimingPayload =
  | { mode: "exact"; travelStartDate: string }
  | { mode: "month"; travelMonth: number; travelYear: number };

/**
 * Validated timing selection → payload shapes. Call only after
 * validateTravelTiming returns null. Exact echoes the trimmed
 * date text; Month returns numbers (never a synthesized date).
 */
export function buildTravelTimingPayload(sel: TravelTimingSelection): TravelTimingPayload {
  if (sel.mode === "month") {
    return {
      mode: "month",
      travelMonth: Number(sel.travelMonth.trim()),
      travelYear: Number(sel.travelYear.trim()),
    };
  }
  return { mode: "exact", travelStartDate: sel.travelStartDate.trim() };
}

/**
 * Validate the Travelers section before Create. Returns a
 * human-readable message or null when valid. Adults is required
 * (integer ≥ 1, never empty/0/negative); children/infants are
 * optional (empty omitted, otherwise integer ≥ 0); ages are
 * optional (blank entries skipped, the rest integers 0–99), so a
 * blank optional age never blocks creation.
 */
export function validateTravelerForm(form: TravelerForm): string | null {
  const adults = form.adults.trim();
  if (!adults) return "Adults is required.";
  if (!isWholeNumber(adults)) return "Adults must be a whole number.";
  if (Number(adults) < 1) return "Adults must be at least 1.";
  for (const [label, raw] of [
    ["CWB", form.cwb],
    ["CWOB", form.cwob],
    ["Infants", form.infants],
  ] as const) {
    const text = raw.trim();
    if (!text) continue;
    // ^\d+$ admits only non-negative integers, so empties are the
    // only other shape — both mean "not provided".
    if (!isWholeNumber(text)) return `${label} must be a whole number.`;
  }
  const ageGroups: ReadonlyArray<{ label: string; ages: string[] }> = [
    { label: "CWB ages", ages: form.cwbAges },
    { label: "CWOB ages", ages: form.cwobAges },
    { label: "Infant ages", ages: form.infantAges },
  ];
  for (const { label, ages } of ageGroups) {
    for (const raw of ages) {
      const text = raw.trim();
      if (!text) continue;
      if (!isWholeNumber(text)) return `${label} must be whole numbers.`;
      const n = Number(text);
      if (n < 0 || n > MAX_TRAVELER_AGE) {
        return `${label} must be between 0 and ${MAX_TRAVELER_AGE}.`;
      }
    }
  }
  return null;
}

export interface TravelerOverrides {
  adults: number;
  childrenWithBed: number | null;
  childrenWithoutBed: number | null;
  infants: number | null;
  childrenWithBedAges: number[];
  childrenWithoutBedAges: number[];
  infantAges: number[];
}

/**
 * Validated traveler form → lead-creation overrides. Call only
 * after validateTravelerForm returns null. Empty optionals become
 * null (counts) or [] (ages); Adults is always present (≥ 1).
 */
export function travelerFormToOverrides(form: TravelerForm): TravelerOverrides {
  const countOrNull = (raw: string): number | null => {
    const text = raw.trim();
    return text === "" ? null : Number(text);
  };
  const agesOf = (ages: string[]): number[] =>
    ages.map((a) => a.trim()).filter((a) => a !== "").map(Number);
  return {
    adults: Number(form.adults.trim()),
    childrenWithBed: countOrNull(form.cwb),
    childrenWithoutBed: countOrNull(form.cwob),
    infants: countOrNull(form.infants),
    childrenWithBedAges: agesOf(form.cwbAges),
    childrenWithoutBedAges: agesOf(form.cwobAges),
    infantAges: agesOf(form.infantAges),
  };
}

export interface ItineraryDialogRow {
  destination: string;
  nights: string;
}

/** Blank dialog itinerary row (nights as text for typing). */
export function createEmptyItineraryDialogRow(): ItineraryDialogRow {
  return { destination: "", nights: "" };
}

/** Pure: append a blank row (Add More). Never mutates input. */
export function addItineraryDialogRow(
  rows: ItineraryDialogRow[],
): ItineraryDialogRow[] {
  return [...rows, createEmptyItineraryDialogRow()];
}

/** Pure: remove one row (Remove). Allows empty overall. Never mutates. */
export function removeItineraryDialogRow(
  rows: ItineraryDialogRow[],
  index: number,
): ItineraryDialogRow[] {
  return rows.filter((_, i) => i !== index);
}

/**
 * Pure: set a dialog row's destination. Rows carry Destination +
 * Nights only (no per-row city — mirrors native Travel CRM).
 * Never mutates.
 */
export function updateItineraryDialogDestination(
  rows: ItineraryDialogRow[],
  index: number,
  destination: string,
): ItineraryDialogRow[] {
  return rows.map((row, i) => (i === index ? { ...row, destination } : row));
}

/**
 * Seed dialog itinerary rows from prefill (stable Travel CRM IDs
 * preserved verbatim). Returns [] when nothing prefilled — the
 * dialog shows an empty itinerary, never an invented one.
 */
export function seedItineraryDialogRows(
  prefill: Record<string, unknown>,
): ItineraryDialogRow[] {
  const raw = prefill.itinerary;
  if (!Array.isArray(raw)) return [];
  const out: ItineraryDialogRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const destination =
      typeof rec.destination === "string" ? rec.destination : "";
    const nights =
      typeof rec.nights === "number" && Number.isFinite(rec.nights)
        ? String(rec.nights)
        : typeof rec.nights === "string"
          ? rec.nights
          : "";
    // Rows carry Destination + Nights only: a prefilled city is
    // intentionally not seeded (the dialog collects no city).
    if (!destination && !nights.trim()) continue;
    out.push({ destination, nights });
  }
  return out;
}

/**
 * Dialog rows → lead-creation overrides payload. Drops empty rows;
 * throws with a human-readable message on invalid nights so the
 * dialog can surface it without sending.
 */
export function itineraryDialogRowsToOverrides(
  rows: ItineraryDialogRow[],
): Array<{ destination: string; nights: number }> {
  const out: Array<{ destination: string; nights: number }> = [];
  for (const row of rows) {
    if (!row.destination && !row.nights.trim()) continue;
    if (!row.destination) continue;
    const err = validateNightsInput(row.nights);
    if (err) throw new Error(err);
    out.push({
      destination: row.destination,
      nights: Number(row.nights.trim()),
    });
  }
  return out;
}

/**
 * Validate dialog itinerary rows before Create (mirrors native
 * Travel CRM: an incomplete row blocks submission instead of
 * being silently discarded). Fully-empty rows stay skippable so
 * an empty editor still defers to server defaults; a partially
 * filled row returns a row-numbered message naming what is
 * missing. Nights reuse the existing validator. Pure.
 */
export function validateItineraryRows(rows: ItineraryDialogRow[]): string | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.destination && !row.nights.trim()) continue;
    if (!row.destination || !row.nights.trim()) {
      return `Itinerary row ${i + 1} needs a destination and nights. Add both or clear the row.`;
    }
    const err = validateNightsInput(row.nights);
    if (err) return `Itinerary row ${i + 1}: ${err.charAt(0).toLowerCase()}${err.slice(1)}`;
  }
  return null;
}

const INPUT_LABELS: Record<string, string> = {
  customerName: "Name",
  phone: "Phone",
  assignedToEmail: "Assign To (team member)",
  travelStartDate: "Travel Date",
  destination: "Destination",
  city: "City",
  nights: "Nights",
  itinerary: "Itinerary",
  adults: "Adults",
  travelers: "Travelers *",
  departureCountry: "Departure Country",
  departureCity: "Departure City",
  services: "Services",
  // Email and rooms are optional in Travel CRM and therefore never
  // manual dialog inputs: present values map/send automatically.
  leadSource: "Lead Source",
  leadType: "Type",
  leadStage: "Stage",
};

/**
 * Fixed dialog order: Name + Phone always at the top (prefilled
 * from the canonical WACRM flow-run values, editable), then the
 * Workspace-prefilled funnel block (Received, Type, Stage —
 * editable Workspace-style dropdowns), then the remaining
 * completion fields, with the itinerary editor last.
 */
const DIALOG_ORDER: readonly string[] = [
  "customerName",
  "phone",
  "leadSource",
  "leadType",
  "leadStage",
  "departureCountry",
  "departureCity",
  "travelers",
  "services",
  "assignedToEmail",
  "travelStartDate",
  "itinerary",
];

function dialogOrderIndex(field: string): number {
  const i = DIALOG_ORDER.indexOf(field);
  return i === -1 ? DIALOG_ORDER.length : i;
}

/**
 * Funnel fields rendered side by side in one dialog row (Lead
 * Source + Type + Stage). Layout only — order, values, and
 * submission are untouched.
 */
const FUNNEL_ROW_FIELDS: readonly string[] = [
  "leadSource",
  "leadType",
  "leadStage",
];

const INPUT_KINDS: Record<string, DialogInput["kind"]> = {
  assignedToEmail: "member",
  travelStartDate: "date",
  nights: "number",
  itinerary: "itinerary",
  travelers: "travelers",
  adults: "number",
  leadSource: "select",
  leadType: "select",
  leadStage: "select",
  services: "multi",
};

const OPTION_KEYS: Record<string, string> = {
  leadSource: "leadSource",
  leadType: "leadType",
  leadStage: "leadStage",
  services: "services",
};

function asLookupList(value: unknown): LookupOption[] | null {
  if (!Array.isArray(value)) return null;
  const out: LookupOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value !== "string" || !rec.value.trim()) continue;
    out.push({
      value: rec.value.trim(),
      label:
        typeof rec.label === "string" && rec.label.trim()
          ? rec.label.trim()
          : rec.value.trim(),
      destinationValue:
        typeof rec.destinationValue === "string" && rec.destinationValue.trim()
          ? rec.destinationValue.trim()
          : null,
    });
  }
  return out;
}

function resolveItineraryLookups(
  options: Record<string, LookupOption[] | null> | null,
  prefill: Record<string, unknown>,
  topDestinations?: LookupOption[] | null,
  topCities?: LookupOption[] | null,
  topByDest?: Record<string, LookupOption[]> | null,
): {
  destinations: LookupOption[] | null;
  cities: LookupOption[] | null;
  citiesByDestination: Record<string, LookupOption[]> | null;
} {
  const destinations =
    (Array.isArray(topDestinations) ? topDestinations : null) ??
    (options ? asLookupList(options.destinations) : null);
  const cities =
    (Array.isArray(topCities) ? topCities : null) ??
    (options ? asLookupList(options.cities) : null);
  let citiesByDestination: Record<string, LookupOption[]> | null = null;
  if (topByDest && typeof topByDest === "object") {
    citiesByDestination = topByDest;
  } else if (
    prefill.citiesByDestination &&
    typeof prefill.citiesByDestination === "object"
  ) {
    citiesByDestination = prefill.citiesByDestination as Record<
      string,
      LookupOption[]
    >;
  }
  return { destinations, cities, citiesByDestination };
}

/**
 * Pure derivation of dialog inputs: Name + Phone always lead
 * (prefilled canonical values, editable), then Received/Type/Stage
 * (initialized from the Workspace row, editable — edits ride the
 * normal override path to both the Travel CRM payload and, after
 * a successful create, back to the Workspace row), then the
 * remaining fields that still need user input.
 */
export function buildDialogInputs(
  mapping: MappingPayload,
  prefill: Record<string, unknown>,
  options: Record<string, LookupOption[] | null> | null,
  assignmentIssue: string | null,
  receivedOptions?: LookupOption[] | null,
  itineraryLookups?: {
    destinations?: LookupOption[] | null;
    cities?: LookupOption[] | null;
    citiesByDestination?: Record<string, LookupOption[]> | null;
  } | null,
): DialogInput[] {
  const wanted = new Set<string>();
  for (const f of mapping.missing) {
    if (INPUT_LABELS[f] !== undefined) wanted.add(f);
  }
  for (const a of mapping.ambiguous) {
    if (INPUT_LABELS[a.field] !== undefined) wanted.add(a.field);
  }
  for (const v of mapping.invalid) {
    if (INPUT_LABELS[v.field] !== undefined) wanted.add(v.field);
  }
  if (assignmentIssue !== null || prefill.assignedToEmail == null) {
    wanted.add("assignedToEmail");
  }
  const needsItinerary =
    wanted.has("itinerary") ||
    wanted.has("destination") ||
    wanted.has("city") ||
    wanted.has("nights");
  const prefilledRows = seedItineraryDialogRows(prefill);
  const showItinerary = needsItinerary || prefilledRows.length > 0;
  if (showItinerary) {
    wanted.delete("destination");
    wanted.delete("city");
    wanted.delete("nights");
    wanted.add("itinerary");
  }
  // Name + Phone always lead the dialog (prefilled canonical WACRM
  // values, editable). Never a second source: value comes from
  // prefill.customerName / prefill.phone already derived server-side
  // from the flow run's contact/submission data.
  wanted.add("customerName");
  wanted.add("phone");
  // Adults (missing/invalid/ambiguous) opens the grouped Travelers
  // section instead of a lone number input — counts plus optional
  // per-child ages in one compact surface.
  if (wanted.has("adults")) {
    wanted.delete("adults");
    wanted.add("travelers");
  }
  // Received/Type/Stage always render as editable Workspace-style
  // dropdowns prefilled from the selected row — never gated on the
  // mapping flagging them, so Received can never go missing and
  // Type/Stage can never degrade to text inputs. The agent's picks
  // ride the normal override path to both the Travel CRM payload
  // and, after a successful create, back to the Workspace row.
  // Clearing one simply omits the override, so the row/default
  // path applies (empty Type → Fresh, empty Stage → New Lead).
  wanted.add("leadSource");
  wanted.add("leadType");
  wanted.add("leadStage");
  // Departure Country/City always render as catalog selects
  // prefilled from the saved flow defaults (server prefill) —
  // never gated on the mapping flagging them, so saving Travel
  // CRM Settings (which marks them available) can never hide
  // them. The city is optional (never required for creation).
  // Per-lead edits ride the normal override path to the
  // payload only; saved Settings are never modified here.
  wanted.add("departureCountry");
  wanted.add("departureCity");
  // Services multi-select always renders every supported service
  // option (the six TRAVEL_CRM_SERVICE_LABELS) as independently
  // selectable checkboxes — never filtered by the per-flow Settings
  // configuration. Prefilled services (flow defaults or lead data,
  // via server prefill) arrive pre-checked and stay editable per
  // lead. The dedicated server override path means an edit can
  // never collide with mapped/default values as a false ambiguity.
  wanted.add("services");
  const ambiguousBy = new Map(mapping.ambiguous.map((a) => [a.field, a.candidates]));
  const resolved = resolveItineraryLookups(
    options,
    prefill,
    itineraryLookups?.destinations ?? null,
    itineraryLookups?.cities ?? null,
    itineraryLookups?.citiesByDestination ?? null,
  );
  const ordered = [...wanted].sort(
    (a, b) => dialogOrderIndex(a) - dialogOrderIndex(b),
  );
  return ordered.map((field) => {
    if (field === "departureCountry" || field === "departureCity") {
      // Catalog selects, never text inputs: country from the
      // copied catalog, cities for the prefilled country (the
      // live selected country refreshes the list at render).
      // Values are the saved flow defaults via server prefill —
      // initial values only, freely editable per lead. When the
      // server carries no saved country (genuinely new entry),
      // the Workspace creation dialog defaults to India (from the
      // copied catalog) so the modal opens pre-selected; saved
      // values are always preserved verbatim when present. The
      // city is optional and never blocks creation.
      const rawPrefillCountry =
        typeof prefill.departureCountry === "string"
          ? prefill.departureCountry.trim()
          : "";
      const effectivePrefillCountry =
        rawPrefillCountry || DEFAULT_DEPARTURE_COUNTRY;
      const depOptions =
        field === "departureCountry"
          ? DEPARTURE_COUNTRY_OPTIONS
          : departureCityOptions(effectivePrefillCountry).map((o) => ({
              value: o.value,
              label: o.label,
            }));
      const rawValue = prefill[field] ?? null;
      const value =
        field === "departureCountry" &&
        (rawValue === null ||
          (typeof rawValue === "string" && !rawValue.trim()))
          ? DEFAULT_DEPARTURE_COUNTRY
          : rawValue;
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "select" as const,
        value,
        options: depOptions,
        hint: ambiguousBy.has(field)
          ? `Multiple values found: ${ambiguousBy.get(field)?.join(" / ")} — pick or type the correct one.`
          : undefined,
      };
    }
    if (field === "travelers") {
      const adultHints = ambiguousBy.get("adults") ?? [];
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "travelers" as const,
        value: seedTravelerForm(prefill),
        options: null,
        hint:
          adultHints.length > 0
            ? `Multiple values found: ${adultHints.join(" / ")} — pick the correct one.`
            : undefined,
      };
    }
    if (field === "itinerary") {
      const legacyHints: string[] = [];
      for (const key of ["itinerary", "destination", "city", "nights"]) {
        const cands = ambiguousBy.get(key);
        if (cands && cands.length > 0) legacyHints.push(...cands);
      }
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "itinerary" as const,
        value: prefilledRows,
        options: resolved.destinations,
        cities: resolved.cities,
        citiesByDestination: resolved.citiesByDestination,
        hint:
          legacyHints.length > 0
            ? `Multiple values found: ${[...new Set(legacyHints)].join(" / ")} — pick the correct one.`
            : undefined,
      };
    }
    const optionKey = OPTION_KEYS[field];
    const liveOptions =
      field === "leadSource" && receivedOptions && receivedOptions.length > 0
        ? receivedOptions
        : optionKey
          ? (options?.[optionKey] ?? null)
          : undefined;
    // Services options are always the six supported labels —
    // never the per-flow Settings configuration, never the live
    // catalog, never invented labels. Checked state comes from the
    // input value (server prefill: flow defaults or lead data).
    const serviceOptions =
      field === "services"
        ? [...TRAVEL_CRM_SERVICE_LABELS].map((label) => ({ value: label, label }))
        : null;
    // Funnel dropdowns never degrade to text inputs: when the
    // server sends no option list, fall back to the canonical
    // Workspace label sets above.
    const fieldOptions =
      serviceOptions !== null
        ? serviceOptions
        : liveOptions && liveOptions.length > 0
          ? liveOptions
          : (FUNNEL_FALLBACK_OPTIONS[field] ?? undefined);
    return {
      field,
      label: INPUT_LABELS[field] ?? field,
      kind: INPUT_KINDS[field] ?? "text",
      value: prefill[field] ?? (Array.isArray(prefill[field]) ? prefill[field] : null),
      options: fieldOptions,
      hint: ambiguousBy.has(field)
        ? `Multiple values found: ${ambiguousBy.get(field)?.join(" / ")} — pick or type the correct one.`
        : undefined,
    };
  });
}

/**
 * Combine a failed API message with its per-field details so the
 * dialog names the rejected field instead of showing only a
 * generic message (e.g. Travel CRM's "The submitted data is
 * invalid." plus `itinerary.0.destination: ...`). Known dialog
 * fields render with their input labels; anything else keeps its
 * raw key. Pure — unit-tested.
 */
export function formatApiError(
  message: string,
  fields: unknown,
): string {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return message;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const messages = Array.isArray(value) ? value.map(String) : [String(value)];
    if (messages.length === 0) continue;
    const head = key.split(".")[0] ?? key;
    const label = INPUT_LABELS[head] ?? head;
    const rest = key.slice(head.length);
    parts.push(`${label}${rest}: ${messages.join(", ")}`);
  }
  return parts.length > 0 ? `${message} ${parts.join("; ")}` : message;
}

/** Seed editable inputs from known values (true prefill). */
export function seedValues(prefill: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, raw] of Object.entries(prefill)) {
    // Itinerary has its own row state; rowLead* keys feed the
    // read-only funnel block directly (never dialog overrides).
    if (field === "itinerary") continue;
    if (field === "rowLeadSource" || field === "rowLeadType" || field === "rowLeadStage") continue;
    // Phone seeds in display form (Indian +91 shown as 10 digits);
    // submit() maps edits back to canonical — payloads stay canonical.
    if (field === "phone" && typeof raw === "string" && raw) {
      out[field] = formatPhoneForDisplay(raw);
      continue;
    }
    if (typeof raw === "string" && raw) out[field] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[field] = String(raw);
    else if (Array.isArray(raw) && raw.length > 0) out[field] = raw.map(String).join("; ");
  }
  return out;
}

/**
 * Country options for the dialog Departure Country select: the
 * exact copied Travel CRM catalog, sorted alphabetically (never
 * fetched, never hardcoded locally).
 */
const DEPARTURE_COUNTRY_OPTIONS: LookupOption[] = [...DEPARTURE_COUNTRIES]
  .sort((a, b) => a.localeCompare(b))
  .map((name) => ({ value: name, label: name }));

/**
 * City rule: changing country clears an incompatible city rather
 * than keeping a value the new country cannot offer. Pure.
 */
export function resolveDepartureCityOnCountryChange(
  country: string,
  city: string,
): string {
  return city && !isDepartureCityInCountry(country, city) ? "" : city;
}

/**
 * Effective departure country for the dialog: the live selection
 * when the agent has set one (including an explicit clear to ""),
 * else the server prefill, else the Workspace India default for
 * genuinely new entries. An explicit "" is preserved (never
 * forced back to India) so manual clearing sticks until the agent
 * picks again. Pure — unit-tested.
 */
export function resolveEffectiveDepartureCountry(
  stored: string | undefined,
  prefillCountry: string,
): string {
  if (stored !== undefined) return stored;
  return prefillCountry.trim() || DEFAULT_DEPARTURE_COUNTRY;
}

/**
 * Workspace column names behind the three funnel dropdowns —
 * the chip lookup keys, so dialog chips can never disagree with
 * the Workspace cells on colors.
 */
const FUNNEL_WORKSPACE_FIELD_NAMES: Record<string, string> = {
  leadSource: LEAD_RECEIVED_FIELD_NAME,
  leadType: LEAD_TYPE_FIELD_NAME,
  leadStage: STAGE_FIELD_NAME,
};

/**
 * Last-resort funnel options: the exact canonical Workspace label
 * sets (values = labels — no live enums available to map). Used
 * ONLY when the server sends no option list (lookups unreachable);
 * the server then falls back to the row/default path and Travel
 * CRM validates authoritatively. This keeps Received/Type/Stage
 * dropdowns in every reachable state instead of degrading to
 * free-text inputs.
 */
const FUNNEL_FALLBACK_OPTIONS: Record<string, LookupOption[]> = {
  leadSource: LEAD_RECEIVED_OPTIONS.map((label) => ({ value: label, label })),
  leadType: LEAD_TYPE_OPTIONS.map((label) => ({ value: label, label })),
  leadStage: STAGE_OPTIONS.map((label) => ({ value: label, label })),
};

/**
 * Received/Type/Stage dropdown: the exact Workspace single-select
 * surface, composed from the shared Workspace pieces (chip view,
 * trigger styling, Clear-first, search threshold, chip lookup) —
 * controlled instead of self-saving, so picks stay local dialog
 * state until Create. Options arrive pre-ordered from the server
 * (canonical Workspace labels carrying live Travel CRM enum
 * values); the submitted value is the enum, labels only display.
 * Clear submits empty, which omits the override so the row/default
 * path applies. Nothing here persists — Workspace writes happen
 * server-side only after a successful Travel CRM create.
 *
 * Exported for render tests (same pattern as CustomCell).
 */
export function FunnelSelect({
  label,
  value,
  options,
  fieldName,
  onChange,
}: {
  label: string;
  value: string;
  options: LookupOption[];
  fieldName: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const showSearch = options.length > OPTION_SEARCH_THRESHOLD;
  const visible = showSearch
    ? filterCellOptions(
        options.map((o) => ({ value: o.value, label: o.label })),
        query,
      )
    : options;
  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;
  const selectedChip =
    selectedLabel !== null ? getSelectChip(fieldName, selectedLabel) : null;
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "__clear__" ? "" : (v ?? ""))}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <SelectTrigger className={SELECT_CELL_TRIGGER_CLASS} aria-label={label}>
        <SelectValue placeholder={`Select ${label}`}>
          {selectedLabel == null || selectedLabel === "" ? undefined : selectedChip ? (
            <SelectChipView chip={selectedChip}>{selectedLabel}</SelectChipView>
          ) : (
            selectedLabel
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__clear__">
          <span className="text-muted-foreground">Clear</span>
        </SelectItem>
        {showSearch && (
          <OptionSearchBox query={query} onQuery={setQuery} fieldName={label} />
        )}
        {visible.map((o) => {
          const chip = getSelectChip(fieldName, o.label);
          return (
            <SelectItem key={o.value} value={o.value}>
              {chip ? <SelectChipView chip={chip}>{o.label}</SelectChipView> : o.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Destination option for the itinerary selector. `value` is the
 * stable Travel CRM master ID (the only thing ever submitted —
 * private names never travel); `label` is the public name.
 * `privateName`/`countryName` are tolerated enrichment from the
 * lookup feed: the current feed omits both, in which case the
 * selector degrades to the long-standing flat public-name list
 * with zero invented data (see groupDestinationOptionsByCountry).
 */
export interface ItineraryDestinationOption {
  value: string;
  label: string;
  privateName?: string | null;
  countryName?: string | null;
}

/**
 * Pinned placement for the itinerary Destination/City dropdowns
 * (both dialog and Settings): always above the trigger, never
 * flipping below on expand/select/search. Alignment may still
 * shift to stay in the viewport; the popup height caps at the
 * space available above via `--available-height`.
 */
export const ITINERARY_DROPDOWN_ABOVE: {
  side: "top";
  collisionAvoidance: {
    side: "none";
    align: "shift";
    fallbackAxisSide: "none";
  };
} = {
  side: "top",
  collisionAvoidance: { side: "none", align: "shift", fallbackAxisSide: "none" },
};

/**
 * Native Travel CRM option-label convention: `Destination Name —
 * Private Name`, collapsing to the bare public name when the
 * private name is blank or identical (case/trim-insensitive).
 * Display/search only — the submitted value is always separate.
 */
export function destinationOptionLabel(name: string, privateName?: string | null): string {
  const suffix = (privateName ?? "").trim();
  if (!suffix) return name;
  if (suffix.toLowerCase() === name.trim().toLowerCase()) return name;
  return `${name} — ${suffix}`;
}

/**
 * True for options carrying country metadata. The current lookup
 * feed provides none, so grouping stays dormant until Phase 2
 * enriches the feed — never inferred or hardcoded here.
 */
function hasCountryMetadata(
  options: ReadonlyArray<ItineraryDestinationOption>,
): boolean {
  return options.some((o) => (o.countryName ?? "").trim() !== "");
}

export interface DestinationCountryGroup {
  /** Country display name, or null for the ungrouped flat list. */
  country: string | null;
  options: ItineraryDestinationOption[];
}

/**
 * Group destination options under their country (blank country →
 * "Other" pinned last, mirroring native Travel CRM). When no
 * option carries country metadata, returns the options as one
 * ungrouped list — the selector renders flat exactly as today,
 * with no invented countries.
 */
export function groupDestinationOptionsByCountry(
  options: ReadonlyArray<ItineraryDestinationOption>,
): DestinationCountryGroup[] {
  if (!hasCountryMetadata(options)) return [{ country: null, options: [...options] }];
  const groups = new Map<string, ItineraryDestinationOption[]>();
  const other: ItineraryDestinationOption[] = [];
  for (const o of options) {
    const country = (o.countryName ?? "").trim();
    if (!country) {
      other.push(o);
      continue;
    }
    const list = groups.get(country) ?? [];
    list.push(o);
    groups.set(country, list);
  }
  const out = [...groups.entries()].map(([country, opts]) => ({ country, options: opts }));
  if (other.length > 0) out.push({ country: "Other", options: other });
  return out;
}

/**
 * Substring match over the public name and, when present, the
 * private name (case-insensitive). The private name only widens
 * the match — it is never returned or submitted.
 */
export function destinationOptionMatches(
  option: ItineraryDestinationOption,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (option.label.toLowerCase().includes(q)) return true;
  const priv = (option.privateName ?? "").trim().toLowerCase();
  return priv !== "" && priv.includes(q);
}

/**
 * Filter destination options by query (public + private names),
 * preserving feed order. Pure.
 */
export function filterDestinationOptions(
  options: ReadonlyArray<ItineraryDestinationOption>,
  query: string,
): ItineraryDestinationOption[] {
  return options.filter((o) => destinationOptionMatches(o, query));
}

/**
 * Pure country-expand toggle for the grouped destination selector:
 * clicking a collapsed heading expands it, clicking an expanded one
 * collapses it; other countries are untouched. Never mutates input.
 */
export function toggleCountryExpanded(
  prev: ReadonlySet<string>,
  country: string,
): Set<string> {
  const next = new Set(prev);
  if (next.has(country)) next.delete(country);
  else next.add(country);
  return next;
}

/**
 * Keyboard-nav offsets per group (index of each group's first
 * shown row inside the navigation options). Pure — shown-ness
 * must mirror the list render exactly (searching shows all).
 */
export function destinationGroupNavOffsets(
  groups: ReadonlyArray<DestinationCountryGroup>,
  opts: {
    grouped: boolean;
    searching: boolean;
    expanded: ReadonlySet<string>;
  },
): Map<string, number> {
  const offsets = new Map<string, number>();
  let acc = 0;
  for (const g of groups) {
    const key = g.country ?? "";
    const shown = !opts.grouped || opts.searching || opts.expanded.has(key);
    offsets.set(key, acc);
    if (shown) acc += g.options.length;
  }
  return offsets;
}

/**
 * Rendered destination option list: search-empty state, flat
 * options, or expandable country groups. Pure presentational —
 * the parent owns query/highlight/expand state. Separated so both
 * dropdown locations (and SSR render tests) share the exact
 * output the popup shows.
 */
export function ItineraryDestinationList({
  groups,
  grouped,
  searching,
  expanded,
  highlight,
  selectedValue,
  onToggleCountry,
  onPick,
  onHighlight,
  listRef,
}: {
  groups: ReadonlyArray<DestinationCountryGroup>;
  grouped: boolean;
  searching: boolean;
  expanded: ReadonlySet<string>;
  highlight: number;
  selectedValue: string | undefined;
  onToggleCountry: (country: string) => void;
  onPick: (value: string) => void;
  onHighlight: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  function renderOptions(list: ItineraryDestinationOption[], offset: number) {
    return list.map((o, i) => {
      const index = offset + i;
      return (
        <button
          key={o.value}
          type="button"
          role="option"
          data-index={index}
          aria-selected={o.value === selectedValue}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(o.value)}
          className={
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none " +
            (index === highlight
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-muted")
          }
        >
          <span className="min-w-0 flex-1 whitespace-normal break-words">
            {destinationOptionLabel(o.label, o.privateName)}
          </span>
          {o.value === selectedValue && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        </button>
      );
    });
  }

  const offsets = destinationGroupNavOffsets(groups, { grouped, searching, expanded });
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  if (total === 0) {
    return (
      <p className="text-muted-foreground px-2 py-1.5 text-xs">
        No matching options.
      </p>
    );
  }
  if (!grouped) {
    return <div className="flex flex-col gap-0.5">{renderOptions(groups.flatMap((g) => g.options), 0)}</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((g) => {
        const key = g.country ?? "";
        // While searching every matching group stays open;
        // otherwise collapsed headings expand on click.
        const isOpen = searching || expanded.has(key);
        const rendered = renderOptions(g.options, offsets.get(key) ?? 0);
        return (
          <div key={key || "all"}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={`${g.country} destinations`}
              onClick={() => onToggleCountry(key)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold tracking-wide uppercase transition-colors outline-none"
            >
              <ChevronDown
                className={
                  "h-3.5 w-3.5 shrink-0 transition-transform " +
                  (isOpen ? "" : "-rotate-90")
                }
                aria-hidden
              />
              <span className="min-w-0 flex-1 text-left whitespace-normal break-words">{g.country}</span>
              <span className="shrink-0 tabular-nums">{g.options.length}</span>
            </button>
            {isOpen && rendered}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Searchable country-grouped itinerary destination selector
 * (native Travel CRM experience, WACRM data): a controlled
 * Popover combobox (same reliable pattern as the departure
 * selects and the flows TagSelect) with expandable/collapsible
 * country headings. Options group by country when the feed
 * provides it, otherwise render flat; collapsed groups expand on
 * click and all matching groups auto-expand while searching;
 * option rows show `Destination — Private` while the committed
 * field shows the public name only; search matches both names;
 * the stored master ID passes through untouched, so the existing
 * IDs→names submission pipeline is unchanged and private names
 * can never be submitted. Arrow keys move a component-owned
 * highlight (list scrolls to it only), Enter selects, Escape
 * dismisses. Exported for render tests.
 */
export function ItineraryDestinationSelect({
  value,
  options,
  inputId,
  onChange,
}: {
  value: string | undefined;
  options: ItineraryDestinationOption[];
  inputId: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const visible = filterDestinationOptions(options, query);
  const groups = groupDestinationOptionsByCountry(visible);
  const grouped = groups.length > 1 || groups[0]?.country !== null;
  const searching = query.trim() !== "";
  // Keyboard navigation walks the options currently shown: every
  // match while searching, otherwise only expanded groups' rows.
  // Headings stay mouse-operated so arrow flow never stalls.
  const navOptions = !grouped
    ? visible
    : searching
      ? visible
      : groups.flatMap((g) =>
          expanded.has(g.country ?? "") ? g.options : [],
        );
  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;

  function close() {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  }

  function pick(v: string) {
    onChange(v ?? "");
    close();
  }

  function scrollHighlightIntoView(index: number) {
    // Runs after paint so the highlighted row exists; nearest-only
    // so the list never jumps while typing (fires solely on
    // arrow-key navigation).
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function moveHighlight(delta: 1 | -1) {
    if (navOptions.length === 0) return;
    const next =
      highlight < 0 || highlight >= navOptions.length
        ? delta === 1
          ? 0
          : navOptions.length - 1
        : (highlight + delta + navOptions.length) % navOptions.length;
    setHighlight(next);
    scrollHighlightIntoView(next);
  }

  function toggleCountry(country: string) {
    setExpanded((prev) => toggleCountryExpanded(prev, country));
  }

  function onQuery(v: string) {
    setQuery(v);
    // Typing resets the highlight without touching scroll position.
    setHighlight(-1);
  }

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home") {
      if (navOptions.length === 0) return;
      e.preventDefault();
      setHighlight(0);
      scrollHighlightIntoView(0);
    } else if (e.key === "End") {
      if (navOptions.length === 0) return;
      e.preventDefault();
      setHighlight(navOptions.length - 1);
      scrollHighlightIntoView(navOptions.length - 1);
    } else if (e.key === "Enter") {
      const target =
        highlight >= 0 && highlight < navOptions.length
          ? navOptions[highlight]
          : navOptions[0];
      if (target) {
        e.preventDefault();
        pick(target.value);
      }
    }
    // Escape dismisses via the Popover and Tab moves focus out
    // (both propagate); every other key types into the input with
    // no popup-level handler to swallow it.
  }


  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setQuery("");
          setHighlight(-1);
        }
      }}
    >
      <PopoverTrigger
        id={inputId}
        aria-label="Destination"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      >
        <span className="min-w-0 flex-1 text-left whitespace-normal break-words">
          {selectedLabel !== null && selectedLabel !== "" ? (
            selectedLabel
          ) : (
            <span className="text-muted-foreground">Select</span>
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        {...ITINERARY_DROPDOWN_ABOVE}
        className="w-(--anchor-width) p-1.5"
      >
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search options…"
          aria-label="Search Destination options"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoFocus
          className="h-7 text-[13px]"
        />
        {/* Plain scroll viewport for the option list only: the
            search input above stays pinned, and the container never
            re-scrolls while typing (highlight scrolling happens
            solely on arrow-key moves). overscroll-contain keeps
            wheel scrolling from hijacking the dialog behind. Height
            caps at the space available above the trigger. */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Destination options"
          className="mt-1 max-h-[min(15rem,var(--available-height))] overflow-y-auto overscroll-contain"
        >
          <ItineraryDestinationList
            groups={groups}
            grouped={grouped}
            searching={searching}
            expanded={expanded}
            highlight={highlight}
            selectedValue={value}
            onToggleCountry={toggleCountry}
            onPick={pick}
            onHighlight={setHighlight}
            listRef={listRef}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Searchable dropdown for the dialog Departure Country/City
 * selects — a controlled Popover combobox (same reliable pattern
 * as the flows TagSelect): a real editable search input, a
 * substring filter over labels/values, and a plain scroll
 * viewport. Countries and cities submit their values verbatim.
 * Opening shows all options, typing filters immediately, and the
 * query resets on close. The selected label resolves explicitly
 * (never dependent on the filtered item list), so the trigger
 * keeps showing the pick while typing. Duplicate city values (one
 * bare name, several state-qualified labels) submit the bare name
 * either way.
 *
 * Why a Popover instead of the shared Select primitives: the
 * Select popup owns floating-ui typeahead/list-navigation on its
 * keydown path, which swallows printable keys, hijacks arrows and
 * Enter, and auto-scrolls the highlight — the exact "typed text
 * disappears / options jump" behavior reported here. The Popover
 * has no such handlers, so typing, caret keys, and focus behave
 * like a normal text field; arrow/Enter/Escape navigation below
 * is fully owned by this component with a stable scroll position
 * (scrolling happens only on arrow-key moves, never while typing).
 *
 * A small × clear affordance renders beside the chevron whenever
 * a value is selected. Activating it clears through onClear
 * without opening the dropdown and without submitting: pointer
 * and keyboard activation both stop propagation and suppress
 * the trigger default, and the element is a span (never a nested
 * button). The dialog wires the country clear to also reset the
 * city, so no invalid pairing can remain.
 *
 * Exported for render tests (same pattern as FunnelSelect).
 */
export function DepartureSearchSelect({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  options: LookupOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = filterCellOptions(
    options.map((o) => ({ value: o.value, label: o.label })),
    query,
  );
  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;
  const clear = () => (onClear ?? (() => onChange("")))();

  function close() {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  }

  function pick(v: string) {
    onChange(v ?? "");
    close();
  }

  function scrollHighlightIntoView(index: number) {
    // Runs after paint so the highlighted row exists; nearest-only
    // so the list never jumps while typing (this fires solely on
    // arrow-key navigation).
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function moveHighlight(delta: 1 | -1) {
    if (visible.length === 0) return;
    const next =
      highlight < 0
        ? delta === 1
          ? 0
          : visible.length - 1
        : (highlight + delta + visible.length) % visible.length;
    setHighlight(next);
    scrollHighlightIntoView(next);
  }

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Navigate options instead of moving the caret; the input
      // keeps focus and the list scrolls to the highlight only.
      e.preventDefault();
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home") {
      if (visible.length === 0) return;
      e.preventDefault();
      setHighlight(0);
      scrollHighlightIntoView(0);
    } else if (e.key === "End") {
      if (visible.length === 0) return;
      e.preventDefault();
      setHighlight(visible.length - 1);
      scrollHighlightIntoView(visible.length - 1);
    } else if (e.key === "Enter") {
      // Select the highlighted option, else the first visible one.
      const target =
        highlight >= 0 && highlight < visible.length
          ? visible[highlight]
          : visible[0];
      if (target) {
        e.preventDefault();
        pick(target.value);
      }
    }
    // Escape dismisses via the Popover and Tab moves focus out
    // (both propagate); every other key types into the input with
    // no popup-level handler to swallow it.
  }

  function onQuery(v: string) {
    setQuery(v);
    // Typing resets the highlight without touching scroll position.
    setHighlight(-1);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (disabled) return;
        setOpen(v);
        if (!v) {
          setQuery("");
          setHighlight(-1);
        }
      }}
    >
      <div className="relative">
        <PopoverTrigger
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            if (!disabled) setOpen((v) => !v);
          }}
          className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedLabel == null || selectedLabel === "" ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              selectedLabel
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </PopoverTrigger>
        {value !== "" && (
          <span
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
            aria-disabled={disabled}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (!disabled) clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                if (!disabled) clear();
              }
            }}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-8 inline-flex -translate-y-1/2 shrink-0 items-center rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden />
          </span>
        )}
      </div>
      <PopoverContent align="start" className="w-(--anchor-width) p-1.5">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search options…"
          aria-label={`Search ${label} options`}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoFocus
          className="h-7 text-[13px]"
        />
        {/* Plain scroll viewport for the option list only: the
            search input above stays pinned, and the container never
            re-scrolls while typing (highlight scrolling happens
            solely on arrow-key moves). overscroll-contain keeps
            wheel scrolling from hijacking the dialog behind. */}
        <div
          ref={listRef}
          role="listbox"
          aria-label={`${label} options`}
          className="mt-1 max-h-60 overflow-y-auto overscroll-contain"
        >
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              No matching options.
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {visible.map((o, i) => (
                <button
                  key={`${o.value}::${o.label}`}
                  type="button"
                  role="option"
                  data-index={i}
                  aria-selected={o.value === value}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(o.value)}
                  className={
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none " +
                    (i === highlight
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-muted")
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Exact Date / Month travel-timing selector for the creation
 * dialog (mirrors native Travel CRM: exactly one mode active).
 * Exact renders the existing date input unchanged (same format +
 * presence validation); Month renders month (January–December)
 * and year dropdowns following the native year range/default, and
 * never invents a day. Mode switches clear the inactive
 * representation via selectTravelTiming; the inline error covers
 * whichever mode is active. Exported for render tests.
 */
export function TravelTimingSelect({
  label,
  mode,
  travelStartDate,
  travelMonth,
  travelYear,
  error,
  onModeChange,
  onDateChange,
  onMonthChange,
  onYearChange,
}: {
  label: string;
  mode: TravelTimingMode;
  travelStartDate: string;
  travelMonth: string;
  travelYear: string;
  error: string | null;
  onModeChange: (mode: TravelTimingMode) => void;
  onDateChange: (value: string) => void;
  onMonthChange: (value: string) => void;
  onYearChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <div role="radiogroup" aria-label="Travel Timing" className="flex gap-4">
        {(
          [
            { value: "exact", label: "Exact Date" },
            { value: "month", label: "Month" },
          ] as const
        ).map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="radio"
              role="radio"
              aria-checked={mode === o.value}
              aria-label={o.label}
              checked={mode === o.value}
              onChange={() => onModeChange(o.value)}
              className="h-4 w-4"
            />
            {o.label}
          </label>
        ))}
      </div>
      {mode === "exact" ? (
        <Input
          aria-label={label}
          type="date"
          value={travelStartDate}
          onChange={(e) => onDateChange(e.target.value)}
          placeholder={label}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Select value={travelMonth} onValueChange={(v) => onMonthChange(v ?? "")}>
            <SelectTrigger aria-label="Travel month" className="h-8 w-full">
              <SelectValue placeholder="Month">
                {travelMonth !== ""
                  ? (TRAVEL_MONTH_NAMES[Number(travelMonth) - 1] ?? undefined)
                  : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TRAVEL_MONTH_NAMES.map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={travelYear} onValueChange={(v) => onYearChange(v ?? "")}>
            <SelectTrigger aria-label="Travel year" className="h-8 w-full">
              <SelectValue placeholder="Year">
                {travelYear !== "" ? travelYear : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {travelYearOptions().map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Per-lead "Create in Travel CRM" action (Phase 3: connected).
 *
 * Click → prepare (mapping + prefill, no external call unless the
 * payload is already complete) → missing-fields dialog when input
 * is genuinely needed → create → Created + Open link on a REAL
 * external lead ID. "Created" never renders without one.
 * Remount per run (key={runId}) so stale results never leak.
 */
export function TravelCrmAction({
  flowId,
  runId,
  onWorkspaceSynced,
}: {
  flowId: string;
  runId: string;
  /**
   * Fired after a successful create whose dialog edits were synced
   * back to the Workspace row (table reload + drawer patch live in
   * the page). Omitted callers simply skip the refresh.
   */
  onWorkspaceSynced?: (patch: WorkspaceRowPatch, runId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [travelDateError, setTravelDateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ leadId: string; leadUrl: string } | null>(null);
  const [dialog, setDialog] = useState<{
    mapping: MappingPayload;
    prefill: Record<string, unknown>;
    options: Record<string, LookupOption[] | null> | null;
    receivedOptions: LookupOption[] | null;
    destinations: LookupOption[] | null;
    cities: LookupOption[] | null;
    citiesByDestination: Record<string, LookupOption[]> | null;
    assignmentIssue: string | null;
    configuredServices: string[] | null;
  } | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [itineraryRows, setItineraryRows] = useState<ItineraryDialogRow[]>([]);
  // Travel-timing mode + Month-mode selection (mirrors native Travel
  // CRM: exactly one mode active; the year select defaults to the
  // current year like the native form). Prefill never carries
  // month/year (the WACRM backend does not produce them), so every
  // dialog opens on Exact Date.
  const [travelTiming, setTravelTiming] = useState<TravelTimingMode>("exact");
  const [travelMonth, setTravelMonth] = useState("");
  const [travelYear, setTravelYear] = useState(() => String(currentTravelYear()));
  const [travelers, setTravelers] = useState<TravelerForm>(() =>
    seedTravelerForm({}),
  );

  /** Switch timing modes, clearing the representation left behind. */
  function selectTravelTiming(mode: TravelTimingMode) {
    setTravelTiming(mode);
    if (mode === "month") {
      setValues((prev) => ({ ...prev, travelStartDate: "" }));
      setTravelDateError(null);
      // Auto-select the current calendar year when entering Month
      // mode (unless a year is already picked): the year must be a
      // valid selected value, never placeholder text.
      setTravelYear((prev) => (prev === "" ? String(currentTravelYear()) : prev));
    } else {
      setTravelMonth("");
      setTravelYear("");
    }
  }

  useEffect(() => {
    if (!dialog) return;
    if (dialogInputs().some((i) => i.field === "assignedToEmail")) {
      fetch("/api/account/members", { cache: "no-store" })
        .then((r) => r.json().catch(() => null))
        .then((json) => {
          const list = (json as { members?: TeamMember[] } | null)?.members;
          setMembers(Array.isArray(list) ? list : []);
        })
        .catch(() => setMembers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog !== null]);

  function dialogInputs(): DialogInput[] {
    if (!dialog) return [];
    return buildDialogInputs(
      dialog.mapping,
      dialog.prefill,
      dialog.options,
      dialog.assignmentIssue,
      dialog.receivedOptions,
      {
        destinations: dialog.destinations,
        cities: dialog.cities,
        citiesByDestination: dialog.citiesByDestination,
      },
    );
  }

  async function callApi(overrides?: Record<string, unknown>): Promise<PrepareResult | null> {
    const res = await fetch("/api/integrations/travel-crm/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        overrides ? { flow_id: flowId, flow_run_id: runId, overrides } : { flow_id: flowId, flow_run_id: runId },
      ),
    });
    return (await res.json().catch(() => null)) as PrepareResult | null;
  }

  function openDialog(json: PrepareResult & { mapping: MappingPayload; prefill: Record<string, unknown> }) {
    const seeded = seedValues(json.prefill);
    // Workspace creation-dialog default: a genuinely new entry
    // (no saved departure country from lead data, flow defaults,
    // or server default) opens with India pre-selected from the
    // copied catalog. Saved values are preserved verbatim; the
    // agent can still change the country freely, and Departure
    // City follows the effective country via the shared rule.
    // Departure City itself stays empty for the agent to pick.
    if (!seeded.departureCountry?.trim()) {
      seeded.departureCountry = DEFAULT_DEPARTURE_COUNTRY;
    }
    // Drop a prefilled city that cannot belong to the effective
    // country so reopening never shows an invalid pairing.
    const effectiveCountry =
      seeded.departureCountry?.trim() || DEFAULT_DEPARTURE_COUNTRY;
    if (
      seeded.departureCity?.trim() &&
      !isDepartureCityInCountry(effectiveCountry, seeded.departureCity)
    ) {
      delete seeded.departureCity;
    }
    setValues(seeded);
    setTravelDateError(null);
    // Timing always opens on Exact Date: prefill carries no
    // month/year (unsupported by the WACRM backend), and a stale
    // Month selection must never linger across dialog rounds.
    setTravelTiming("exact");
    setTravelMonth("");
    setTravelYear(String(currentTravelYear()));
    setItineraryRows(seedItineraryDialogRows(json.prefill));
    setTravelers(seedTravelerForm(json.prefill));
    setMembers(null);
    setDialog({
      mapping: json.mapping,
      prefill: json.prefill,
      options: json.options ?? null,
      receivedOptions: json.receivedOptions ?? null,
      destinations: json.destinations ?? null,
      cities: json.cities ?? null,
      citiesByDestination: json.citiesByDestination ?? null,
      assignmentIssue: json.assignmentIssue ?? null,
      configuredServices: Array.isArray(json.configuredServices)
        ? json.configuredServices.filter((s): s is string => typeof s === "string")
        : null,
    });
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const json = await callApi();
      if (!json) throw new Error("Request failed.");
      if (json.success && json.leadId && json.leadUrl) {
        setCreated({ leadId: json.leadId, leadUrl: json.leadUrl });
        return;
      }
      if (!json.success && json.code === "MISSING_FIELDS" && json.mapping && json.prefill) {
        openDialog(json as PrepareResult & { mapping: MappingPayload; prefill: Record<string, unknown> });
        return;
      }
      throw new Error(formatApiError(json.error ?? "Request failed.", json.fields));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const inputs = dialogInputs();
    const showTiming = inputs.some((i) => i.field === "travelStartDate");
    // Travel timing is required when shown: validate the ACTIVE mode
    // (dialog stays open) with an inline field error instead of
    // sending. Untouched when the timing field isn't rendered.
    if (showTiming) {
      const timingError = validateTravelTiming({
        mode: travelTiming,
        travelStartDate: values.travelStartDate ?? "",
        travelMonth,
        travelYear,
      });
      setTravelDateError(timingError);
      if (timingError) return;
    }
    const overrides: Record<string, unknown> = {};
    for (const input of inputs) {
      // Itinerary has its own row state — never a generic override.
      if (input.field === "itinerary") continue;
      // Services always sends (even empty): clearing every checkbox
      // must reach the server as an explicit empty selection rather
      // than vanishing into "no override".
      if (input.field === "services") {
        overrides.services = values.services ?? "";
        continue;
      }
      const raw = (values[input.field] ?? "").trim();
      if (input.field === "phone") continue;
      if (raw) overrides[input.field === "assignedToEmail" ? "assignedUserId" : input.field] = raw;
    }
    // Month mode sends numeric travelMonth/travelYear (never an
    // exact date — values.travelStartDate was cleared on switch, and
    // any stale value is deleted defensively below). Only applies
    // when the timing field is rendered (the only way Month mode
    // can be active). Exact mode keeps sending travelStartDate via
    // the generic loop above.
    if (showTiming && travelTiming === "month") {
      const timing = buildTravelTimingPayload({
        mode: "month",
        travelStartDate: "",
        travelMonth,
        travelYear,
      });
      if (timing.mode === "month") {
        overrides.travelMonth = timing.travelMonth;
        overrides.travelYear = timing.travelYear;
      }
      delete overrides.travelStartDate;
    }
    // Phone: the input shows the display form (Indian +91 stripped
    // for readability). Untouched values restore the exact stored
    // original; user edits send verbatim — a country code is never
    // inferred, so a typed 10-digit number stays 10 digits.
    if (inputs.some((i) => i.field === "phone")) {
      const rawPhone = (values.phone ?? "").trim();
      if (rawPhone) {
        const prefillPhone = dialog?.prefill.phone;
        overrides.phone = resolveDialogPhoneForSubmit(
          rawPhone,
          typeof prefillPhone === "string" ? prefillPhone : null,
        );
      }
    }
    if (inputs.some((i) => i.field === "itinerary")) {
      // Incomplete rows block with a row-numbered message (nothing
      // is discarded, nothing is sent); fully-empty rows stay
      // skippable so an empty editor defers to server defaults.
      const rowError = validateItineraryRows(itineraryRows);
      if (rowError) {
        setError(rowError);
        return;
      }
      try {
        const itin = itineraryDialogRowsToOverrides(itineraryRows);
        // Send only when the agent provided at least one complete
        // row; an empty editor leaves itinerary to server defaults
        // (which stay missing when unconfigured — never invented).
        if (itin.length > 0) overrides.itinerary = itin;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid itinerary.");
        return;
      }
    }
    if (inputs.some((i) => i.field === "travelers")) {
      const travelersError = validateTravelerForm(travelers);
      if (travelersError) {
        setError(travelersError);
        return;
      }
      const t = travelerFormToOverrides(travelers);
      overrides.adults = t.adults;
      if (t.childrenWithBed !== null) overrides.childrenWithBed = t.childrenWithBed;
      if (t.childrenWithoutBed !== null) overrides.childrenWithoutBed = t.childrenWithoutBed;
      if (t.infants !== null) overrides.infants = t.infants;
      overrides.childrenWithBedAges = t.childrenWithBedAges;
      overrides.childrenWithoutBedAges = t.childrenWithoutBedAges;
      overrides.infantAges = t.infantAges;
    }
    setBusy(true);
    setError(null);
    try {
      const json = await callApi(overrides);
      if (!json) throw new Error("Request failed.");
      if (json.success && json.leadId && json.leadUrl) {
        // Two-way sync: the server persisted dialog edits to the
        // Workspace row (only after the successful create above).
        // Surface sync failures with the dialog still open for
        // retry; the created lead is never duplicated by retrying.
        // The table refreshes only when synced values landed.
        const patch: WorkspaceRowPatch = {
          answers: {},
          name: null,
          phone: null,
          customValues: {},
          ...(json.workspaceSync?.rowPatch ?? {}),
        };
        const hasPatch =
          Object.keys(patch.answers).length > 0 ||
          Object.keys(patch.customValues).length > 0 ||
          patch.name !== null ||
          patch.phone !== null;
        const failures = json.workspaceSync?.failed ?? [];
        if (failures.length > 0) {
          const details = failures.map((f) => `${f.field}: ${f.error}`).join("; ");
          setError(`Lead created, but Workspace sync failed: ${details}. You can retry Create.`);
          if (hasPatch) onWorkspaceSynced?.(patch, runId);
          return;
        }
        if (hasPatch) onWorkspaceSynced?.(patch, runId);
        setDialog(null);
        setCreated({ leadId: json.leadId, leadUrl: json.leadUrl });
        return;
      }
      if (!json.success && json.code === "MISSING_FIELDS" && json.mapping && json.prefill) {
        const seeded = seedValues(json.prefill);
        setValues((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(seeded)) {
            if (!(k in next)) next[k] = v;
          }
          return next;
        });
        setItineraryRows((prev) =>
          prev.length > 0 ? prev : seedItineraryDialogRows(json.prefill ?? {}),
        );
        // Server echoes submitted traveler values in prefill, so a
        // re-round reseed preserves the agent's entries verbatim.
        setTravelers(seedTravelerForm(json.prefill ?? {}));
        setDialog({
          mapping: json.mapping,
          prefill: json.prefill,
          options: json.options ?? null,
          receivedOptions: json.receivedOptions ?? null,
          destinations: json.destinations ?? null,
          cities: json.cities ?? null,
          citiesByDestination: json.citiesByDestination ?? null,
          assignmentIssue: json.assignmentIssue ?? null,
          configuredServices: Array.isArray(json.configuredServices)
            ? json.configuredServices.filter((s): s is string => typeof s === "string")
            : null,
        });
        return;
      }
      throw new Error(formatApiError(json.error ?? "Request failed.", json.fields));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function set(field: string, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function inputControl(input: DialogInput) {
    // Grouped Travelers section: four compact counts in one row
    // plus optional per-child age fields that appear only while
    // their count is > 0. Same dialog styling as other inputs.
    if (input.kind === "travelers") {
      const cwbCount = travelerAgeCount(travelers.cwb);
      const cwobCount = travelerAgeCount(travelers.cwob);
      const infantCount = travelerAgeCount(travelers.infants);
      const setCount = (key: "adults" | "cwb" | "cwob" | "infants", v: string) => {
        setTravelers((prev) => {
          const next = { ...prev, [key]: v };
          if (key === "cwb") next.cwbAges = resizeAgeRows(prev.cwbAges, travelerAgeCount(v));
          if (key === "cwob") next.cwobAges = resizeAgeRows(prev.cwobAges, travelerAgeCount(v));
          if (key === "infants") next.infantAges = resizeAgeRows(prev.infantAges, travelerAgeCount(v));
          return next;
        });
      };
      const setAge = (
        group: "cwbAges" | "cwobAges" | "infantAges",
        count: number,
        index: number,
        v: string,
      ) => {
        setTravelers((prev) => {
          const base = resizeAgeRows(prev[group], count);
          base[index] = v;
          return { ...prev, [group]: base };
        });
      };
      const ageRows = (
        group: "cwbAges" | "cwobAges" | "infantAges",
        count: number,
        single: string,
        unit?: string,
      ) => {
        if (count <= 0) return null;
        const rows = [...travelers[group]];
        while (rows.length < count) rows.push("");
        return (
          <>
            {rows.slice(0, count).map((age, i) => {
              // Infant ages are months (native Travel CRM "Infant Age
              // (Months)"): the unit rides in the label/placeholder so
              // entering 6 unambiguously means 6 months. CWB/CWOB stay
              // plain ages in years.
              const label = unit ? `${single} ${i + 1} Age (${unit})` : `${single} ${i + 1} Age`;
              return (
                <div key={`${group}-${i}`} className="grid min-w-0 gap-1">
                  <Label htmlFor={`tmc-${group}-${i}`} className="text-xs">
                    {label}
                  </Label>
                  <Input
                    id={`tmc-${group}-${i}`}
                    aria-label={label}
                    type="number"
                    min={0}
                    className="h-8 w-full min-w-0"
                    value={age}
                    onChange={(e) => setAge(group, count, i, e.target.value)}
                    placeholder={unit ?? "Age (optional)"}
                  />
                </div>
              );
            })}
          </>
        );
      };
      return (
        <div className="space-y-2">
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                { key: "adults", label: "Adults", min: 1, placeholder: "1" },
                { key: "cwb", label: "CWB", min: 0, placeholder: "" },
                { key: "cwob", label: "CWOB", min: 0, placeholder: "" },
                { key: "infants", label: "Infants", min: 0, placeholder: "" },
              ] as const
            ).map((f) => (
              <div key={f.key} className="grid min-w-0 gap-1">
                <Label htmlFor={`tmc-travelers-${f.key}`} className="text-xs">
                  {f.label}
                </Label>
                <Input
                  id={`tmc-travelers-${f.key}`}
                  aria-label={f.label}
                  type="number"
                  min={f.min}
                  className="h-8 w-full min-w-0"
                  value={travelers[f.key]}
                  onChange={(e) => setCount(f.key, e.target.value)}
                  placeholder={f.placeholder || undefined}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            CWB = Child with Bed | CWOB = Child without Bed | Infants = Visa charges only
          </p>
          {(cwbCount > 0 || cwobCount > 0 || infantCount > 0) && (
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
              {ageRows("cwbAges", cwbCount, "CWB")}
              {ageRows("cwobAges", cwobCount, "CWOB")}
              {ageRows("infantAges", infantCount, "Infant", "Months")}
            </div>
          )}
        </div>
      );
    }
    if (input.field === "itinerary") {
      const destinations = input.options ?? [];
      const allCities = input.cities ?? [];
      if (destinations.length === 0 && allCities.length === 0) {
        return (
          <p className="text-muted-foreground text-xs">
            Could not load Travel CRM destinations. Destinations come from Travel
            CRM — no options are shown until it loads.
          </p>
        );
      }
      return (
        <div className="space-y-2">
          {itineraryRows.length === 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-2.5">
              <p className="text-muted-foreground text-xs">
                Empty itinerary — add a row to include one.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItineraryRows(addItineraryDialogRow([]))}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
          ) : (
            <>
              {itineraryRows.map((row, i) => {
                return (
                  <div key={i} className="grid grid-cols-[1fr_64px_auto] items-end gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor={`lead-itin-dest-${i}`} className="text-xs">Destination</Label>
                      <ItineraryDestinationSelect
                        value={resolveSelectValue(destinations, row.destination)}
                        options={destinations}
                        inputId={`lead-itin-dest-${i}`}
                        onChange={(v) =>
                          setItineraryRows((prev) =>
                            updateItineraryDialogDestination(prev, i, v ?? ""),
                          )
                        }
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`lead-itin-nights-${i}`} className="text-xs">Nights</Label>
                      <Input
                        id={`lead-itin-nights-${i}`}
                        aria-label="Nights"
                        type="number"
                        min={1}
                        className="h-8"
                        value={row.nights}
                        onChange={(e) =>
                          setItineraryRows((prev) =>
                            prev.map((r, idx) => (idx === i ? { ...r, nights: e.target.value } : r)),
                          )
                        }
                        placeholder="4"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setItineraryRows((prev) => removeItineraryDialogRow(prev, i))}
                      aria-label="Remove itinerary row"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItineraryRows((prev) => addItineraryDialogRow(prev))}
              >
                <Plus className="h-4 w-4" />
                Add More
              </Button>
            </>
          )}
        </div>
      );
    }
    const val = values[input.field] ?? "";
    if (input.field === "assignedToEmail") {
      return (
        <Select value={val} onValueChange={(v) => set(input.field, v ?? "")}>
          <SelectTrigger aria-label={input.label}>
            <SelectValue placeholder="Select team member" />
          </SelectTrigger>
          <SelectContent>
            {(members ?? []).map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.full_name ?? m.email ?? m.user_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (input.kind === "multi") {
      // Services choices are always the six supported labels (the
      // input options); each checkbox toggles independently. The
      // six-label fallback covers any input without an option list.
      const choices =
        input.field === "services" && input.options !== undefined && input.options !== null
          ? input.options.map((o) => o.label)
          : input.options && input.options.length > 0
            ? input.options.map((o) => o.label)
            : [...TRAVEL_CRM_SERVICE_LABELS];
      const current = splitServiceLabels(val);
      // Retired stored labels resolve to the current name, so
      // previously saved defaults keep rendering checked after
      // the rename; unchecking clears every spelling.
      const has = (label: string) =>
        current.some(
          (c) =>
            resolveDisplayServiceLabel(c).toLowerCase() === label.toLowerCase(),
        );
      const toggle = (label: string) => {
        const next = has(label)
          ? current.filter(
              (c) =>
                resolveDisplayServiceLabel(c).toLowerCase() !==
                label.toLowerCase(),
            )
          : [...current, label];
        set(input.field, joinServiceLabels(next));
      };
      return (
        <div className="grid gap-1.5" role="group" aria-label={input.label}>
          {choices.map((label) => (
            <label
              key={label}
              className="text-foreground flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={has(label)}
                onCheckedChange={() => toggle(label)}
                aria-label={label}
              />
              <span className="truncate">{label}</span>
            </label>
          ))}
        </div>
      );
    }
    if (input.kind === "select" && input.options && input.options.length > 0) {
      // Departure Country/City catalog selects (same catalog +
      // rule as Settings): cities follow the live selected
      // country; a country change clears an incompatible city.
      // Values submit through the normal override path (per-lead
      // only — saved Settings are never touched).
      if (input.field === "departureCountry" || input.field === "departureCity") {
        const prefillCountry =
          typeof dialog?.prefill.departureCountry === "string"
            ? (dialog.prefill.departureCountry as string)
            : "";
        // Effective country: live selection first (an explicit
        // clear to "" sticks — India is never forced back), then
        // server prefill, then the Workspace India default — so the
        // City select always offers the Indian catalog list when
        // India is pre-selected by default and never waits on an
        // empty country. Manual country changes flow through `values`
        // and reset an incompatible city via the shared rule below.
        const country = resolveEffectiveDepartureCountry(
          values.departureCountry,
          prefillCountry,
        );
        if (input.field === "departureCountry") {
          // The dialog value itself falls back to India when
          // neither state nor prefill carries a country, so the
          // modal opens pre-selected on genuinely new entries.
          // Searchable like the Travel CRM form; a pick clears an
          // incompatible city via the shared rule below, while the
          // × clear always resets the city too so no invalid
          // pairing can remain.
          const countryVal = val || country;
          return (
            <DepartureSearchSelect
              label={input.label}
              value={countryVal}
              options={input.options ?? []}
              placeholder={`Select ${input.label}`}
              onChange={(next) => {
                set("departureCountry", next);
                set(
                  "departureCity",
                  resolveDepartureCityOnCountryChange(next, values.departureCity ?? ""),
                );
              }}
              onClear={() => {
                set("departureCountry", "");
                set("departureCity", "");
              }}
            />
          );
        }
        const cities = departureCityOptions(country);
        // Remount per country so a previous search query can never
        // linger across a changed city list; the country change
        // above already cleared an incompatible city value.
        return (
          <DepartureSearchSelect
            key={`departureCity:${country}`}
            label={input.label}
            value={val}
            options={cities.map((o) => ({ value: o.value, label: o.label }))}
            placeholder={country ? "Select city" : "Pick country first"}
            disabled={!country}
            onChange={(v) => set(input.field, v ?? "")}
            onClear={() => set(input.field, "")}
          />
        );
      }
      // Funnel fields render through the shared Workspace
      // single-select surface (chips, Clear-first, search) — never
      // the plain dialog select below.
      const funnelField = FUNNEL_WORKSPACE_FIELD_NAMES[input.field];
      if (funnelField !== undefined) {
        return (
          <FunnelSelect
            label={input.label}
            value={val}
            options={input.options}
            fieldName={funnelField}
            onChange={(v) => set(input.field, v)}
          />
        );
      }
      return (
        <Select value={val} onValueChange={(v) => set(input.field, v ?? "")}>
          <SelectTrigger aria-label={input.label}>
            <SelectValue placeholder={`Select ${input.label}`} />
          </SelectTrigger>
          <SelectContent>
            {input.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (input.field === "travelStartDate") {
      // Exact Date / Month selector replaces the lone date input:
      // the mode lives in dialog state (never in `values`, so
      // month/year can never leak into backend overrides), and the
      // inline error covers whichever mode is active.
      return (
        <TravelTimingSelect
          label={input.label}
          mode={travelTiming}
          travelStartDate={val}
          travelMonth={travelMonth}
          travelYear={travelYear}
          error={travelDateError}
          onModeChange={selectTravelTiming}
          onDateChange={(v) => {
            set(input.field, v);
            setTravelDateError(validateTravelDateValue(v));
          }}
          onMonthChange={setTravelMonth}
          onYearChange={setTravelYear}
        />
      );
    }
    return (
      <>
        <Input
          aria-label={input.label}
          type={input.kind === "date" ? "date" : input.kind === "number" ? "number" : input.kind === "member" ? "text" : "text"}
          value={val}
          onChange={(e) => {
            set(input.field, e.target.value);
            // Selecting a valid Travel Date clears the inline error.
            if (input.field === "travelStartDate") {
              setTravelDateError(validateTravelDateValue(e.target.value));
            }
          }}
          placeholder={input.hint ?? input.label}
        />
        {input.field === "travelStartDate" && travelDateError !== null && (
          <p role="alert" className="text-xs text-red-500">
            {travelDateError}
          </p>
        )}
      </>
    );
  }

  /**
   * One dialog field block: label + control + hint, unchanged.
   * Shared by single fields and funnel-row cells so the row
   * changes only layout, never labels, values, or styling.
   */
  function dialogFieldBlock(input: DialogInput) {
    return (
      <div key={input.field} className="grid min-w-0 gap-1.5">
        <Label htmlFor={`tmc-${input.field}`}>{input.label}</Label>
        {inputControl(input)}
        {input.hint !== undefined && (
          <p className="text-xs text-muted-foreground">{input.hint}</p>
        )}
      </div>
    );
  }

  /**
   * Dialog inputs grouped into render rows: consecutive funnel
   * fields (Lead Source + Type + Stage) form one row rendered
   * side by side; every other field renders alone, preserving
   * the existing dialog order.
   */
  function dialogFieldRows(): DialogInput[][] {
    const rows: DialogInput[][] = [];
    let funnel: DialogInput[] = [];
    for (const input of dialogInputs()) {
      if (FUNNEL_ROW_FIELDS.includes(input.field)) {
        funnel.push(input);
        continue;
      }
      if (funnel.length > 0) {
        rows.push(funnel);
        funnel = [];
      }
      rows.push([input]);
    }
    if (funnel.length > 0) rows.push(funnel);
    return rows;
  }

  if (created !== null) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Created in Travel CRM</p>
        <Button type="button" variant="outline" className="w-full" render={<a href={created.leadUrl} target="_blank" rel="noreferrer" />}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open in Travel CRM
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={start}
      >
        {busy && !dialog ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating…
          </>
        ) : (
          <>
            <Plane className="mr-2 h-4 w-4" />
            Create in Travel CRM
          </>
        )}
      </Button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      <Dialog open={dialog !== null} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="flex max-h-[92dvh] w-[94vw] max-w-[94vw] flex-col sm:max-w-[62.5rem]">
          <DialogHeader>
            <DialogTitle>Complete Travel CRM fields</DialogTitle>
            <DialogDescription>
              Name and Phone are prefilled from the Workspace row and editable.
              Received, Type, and Stage are also prefilled and editable.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1">
            {dialogFieldRows().map((row) =>
              row.length > 1 ? (
                <div
                  key={row.map((i) => i.field).join("+")}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                >
                  {row.map((input) => dialogFieldBlock(input))}
                </div>
              ) : (
                dialogFieldBlock(row[0])
              ),
            )}
          </div>
          {error !== null && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={submit}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
