// ============================================================
// Travel CRM per-flow default services.
//
// The six service labels offered in Workspace → Travel CRM
// Settings and in the per-lead dialog. Stored as labels (never
// Travel CRM database IDs); the existing canonicalizeServices
// mechanism resolves them to Travel CRM enum values against
// live lookup options at send time.
// ============================================================

/** Exact service labels, in display order. */
export const TRAVEL_CRM_SERVICE_LABELS: readonly string[] = [
  "Cruise",
  "Flight",
  "Hotel",
  "Vehicle",
  "Sightseeing",
  "Add-on Service (Rail, Passport, etc.)",
];

/**
 * Retired display labels kept ONLY for backward compatibility
 * with previously stored settings and dialog values (stored as
 * labels, never Travel CRM database IDs). Never offered in the
 * UI — accepted by validation and resolved to the same enum so
 * existing selections keep submitting unchanged.
 */
export const TRAVEL_CRM_LEGACY_SERVICE_LABELS: readonly string[] = [
  "Vehicle (disposal)",
];

/**
 * The six WACRM service display labels → their Travel CRM API enum
 * values.
 *
 * The live Travel CRM catalog (`serviceTypes`) derives its labels from
 * the enum via `labelForLookup` (title-cased enum words: "Vehicle
 * Transfer", "Other Add On", …), which does NOT match WACRM's display
 * labels for VEHICLE_TRANSFER ("Vehicle") and OTHER_ADD_ON
 * ("Add-on Service (Rail, Passport, etc.)"). This explicit map is the
 * single authority that resolves WACRM's display labels to the exact
 * Travel CRM enum, so the payload always carries an enum value — never
 * a display label — while users keep seeing the same six options.
 * Keys are the exact labels from TRAVEL_CRM_SERVICE_LABELS plus the
 * retired labels from TRAVEL_CRM_LEGACY_SERVICE_LABELS (matched
 * case-insensitively during canonicalization).
 */
export const TRAVEL_CRM_SERVICE_VALUE_BY_LABEL: Readonly<Record<string, string>> = {
  Cruise: "CRUISE",
  Flight: "FLIGHT",
  Hotel: "HOTEL",
  Vehicle: "VEHICLE_TRANSFER",
  // Retired label — previously stored settings/values only.
  "Vehicle (disposal)": "VEHICLE_TRANSFER",
  Sightseeing: "SIGHTSEEING",
  "Add-on Service (Rail, Passport, etc.)": "OTHER_ADD_ON",
};

export const TRAVEL_CRM_MAX_SERVICES = 20;
export const TRAVEL_CRM_MAX_SERVICE_LENGTH = 80;

/**
 * Validate + normalize a services list for storage. Trims,
 * drops empties, dedupes (case-insensitive) preserving order.
 * Throws with a human-readable message on invalid input.
 */
export function normalizeServiceLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Services must be a list.");
  }
  if (value.length > TRAVEL_CRM_MAX_SERVICES) {
    throw new Error(`Select at most ${TRAVEL_CRM_MAX_SERVICES} services.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error("Each service must be text.");
    }
    const label = raw.trim();
    if (!label) continue;
    if (label.length > TRAVEL_CRM_MAX_SERVICE_LENGTH) {
      throw new Error(`Service "${label.slice(0, 40)}" is too long.`);
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Current user-visible label for a stored service value. Retired
 * labels resolve to their successor ("Vehicle (disposal)" →
 * "Vehicle") so previously saved selections keep rendering
 * checked under the new name; every other value passes through
 * untouched. Display-only — stored values, payloads, and enums
 * are never rewritten here.
 */
export function resolveDisplayServiceLabel(value: string): string {
  const key = value.trim().toLowerCase();
  const legacyIndex = TRAVEL_CRM_LEGACY_SERVICE_LABELS.findIndex(
    (l) => l.toLowerCase() === key,
  );
  if (legacyIndex !== -1) {
    const successor = TRAVEL_CRM_SERVICE_VALUE_BY_LABEL[
      TRAVEL_CRM_LEGACY_SERVICE_LABELS[legacyIndex]
    ];
    const current = TRAVEL_CRM_SERVICE_LABELS.find(
      (l) => TRAVEL_CRM_SERVICE_VALUE_BY_LABEL[l] === successor,
    );
    if (current) return current;
  }
  return value;
}
/**
 * True when every label is one of the six offered services
 * (case-insensitive). Stored settings should only ever contain
 * offered labels; anything else is rejected at the API boundary.
 * Retired labels (previously stored selections) keep validating
 * so existing settings are never rejected after a rename.
 */
export function isOfferedServiceLabel(value: string): boolean {
  const key = value.trim().toLowerCase();
  return (
    TRAVEL_CRM_SERVICE_LABELS.some((l) => l.toLowerCase() === key) ||
    TRAVEL_CRM_LEGACY_SERVICE_LABELS.some((l) => l.toLowerCase() === key)
  );
}

/** Split a semicolon-joined services string (dialog value state). */
export function splitServiceLabels(value: string): string[] {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Join services for dialog value state / override payloads. */
export function joinServiceLabels(values: readonly string[]): string {
  return values.map((v) => v.trim()).filter(Boolean).join("; ");
}
