// ============================================================
// Workspace dropdown chips — Google Sheets-style value colors.
//
// Pure visual mapping for single_select BUSINESS options: the
// same option always resolves to the same chip (background +
// readable text), whether painted as the selected cell value,
// inside the open dropdown options, or in a read-only cell.
// One function serves all three, so selected values and options
// can never drift apart and no random/dynamic colors exist.
//
// Keyed by field (lowercase name) + option (trimmed,
// case-insensitive — display-only tolerance; storage still
// validates exact option equality). Unknown fields, unknown
// values, and EMPTY values resolve to null → existing neutral
// rendering is preserved byte-for-byte.
//
// "Assigned To" is deliberately ABSENT here: members keep the
// existing dynamic neutral roster (no hardcoded member colors,
// ever). Its Clear/Unassigned/member rows render as today.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

export interface SelectChip {
  /** Chip background (hex). */
  background: string;
  /** Readable text for the background (hex). */
  color: string;
}

const GREEN_DARK: SelectChip = { background: "#15803d", color: "#ffffff" };
const RED_STRONG: SelectChip = { background: "#dc2626", color: "#ffffff" };
const GRAY_LIGHT: SelectChip = { background: "#e5e7eb", color: "#374151" };
const GRAY_NEUTRAL: SelectChip = { background: "#e5e7eb", color: "#1f2937" };

/** Exact per-option chips by lowercase field name. */
const CHIP_MAP: Readonly<Record<string, Readonly<Record<string, SelectChip>>>> = {
  "call status": {
    connected: GREEN_DARK,
    "not answering": { background: "#fef3c7", color: "#78350f" },
    "switched off": GRAY_LIGHT,
    busy: { background: "#dbeafe", color: "#1e40af" },
    "call back later": { background: "#dcfce7", color: "#166534" },
    "invalid number": RED_STRONG,
  },
  "lead quality": {
    hot: GREEN_DARK,
    warm: { background: "#dcfce7", color: "#166534" },
    cold: { background: "#ffedd5", color: "#7c2d12" },
    fake: RED_STRONG,
  },
  "lead type": {
    fresh: { background: "#e0e7ff", color: "#3730a3" },
    hot: RED_STRONG,
    warm: { background: "#ffedd5", color: "#7c2d12" },
    cold: { background: "#dbeafe", color: "#1e40af" },
    prospect: { background: "#ede9fe", color: "#5b21b6" },
  },
  "quotation / package": {
    sent: GREEN_DARK,
    "not yet": RED_STRONG,
  },
  "stage": {
    "new lead": { background: "#dbeafe", color: "#1e40af" },
    contacted: { background: "#ccfbf1", color: "#0f766e" },
    qualified: { background: "#dcfce7", color: "#166534" },
    "quotation required": { background: "#fef3c7", color: "#78350f" },
    "quotation sent": { background: "#ffedd5", color: "#7c2d12" },
    "in negotiation": { background: "#ede9fe", color: "#5b21b6" },
    "ready to book": { background: "#ecfccb", color: "#3f6212" },
    "booking confirmed": GREEN_DARK,
    "follow up": { background: "#cffafe", color: "#0e7490" },
    amendment: { background: "#e0e7ff", color: "#3730a3" },
    lost: RED_STRONG,
    cancelled: { background: "#57534c", color: "#ffffff" },
    invalid: { background: "#fce7f3", color: "#9d174d" },
    "on hold": { background: "#92400e", color: "#ffffff" },
    "not connected": { background: "#e2e8f0", color: "#334155" },
  },
  "lead received": {
    website: GRAY_LIGHT,
    "social media": { background: "#ede9fe", color: "#5b21b6" },
    "facebook ads": { background: "#dbeafe", color: "#1e40af" },
    "instagram ads": { background: "#fce7f3", color: "#9d174d" },
    "google ads": { background: "#fef3c7", color: "#78350f" },
    whatsapp: { background: "#dcfce7", color: "#166534" },
    "phone call": { background: "#ccfbf1", color: "#0f766e" },
    referral: { background: "#ecfccb", color: "#3f6212" },
    "walk in": { background: "#cffafe", color: "#0e7490" },
    "repeat customer": { background: "#e0e7ff", color: "#3730a3" },
    partner: { background: "#ffedd5", color: "#7c2d12" },
    other: { background: "#f3f4f6", color: "#4b5563" },
  },
  "follow-up status": {
    "follow-up pending": { background: "#fef3c7", color: "#78350f" },
    "negotiation going on": { background: "#ede9fe", color: "#5b21b6" },
    booked: GREEN_DARK,
    lost: RED_STRONG,
    "no plan": { background: "#92400e", color: "#ffffff" },
  },
  "reason for lost lead": {
    "budget issue": { background: "#ffedd5", color: "#9a3412" },
    "no response": { background: "#fef3c7", color: "#78350f" },
    "already booked elsewhere": { background: "#ede9fe", color: "#5b21b6" },
    "date issue": { background: "#dbeafe", color: "#1e40af" },
    "just inquiry": GRAY_LIGHT,
    "travel cancelled": { background: "#ffe4e6", color: "#9f1239" },
  },
};

/** "No. of Calls Tried" options 1–10 share one neutral chip. */
function callsTriedChip(value: string): SelectChip | null {
  return /^(10|[1-9])$/.test(value.trim()) ? GRAY_NEUTRAL : null;
}

/**
 * Assigned To member palette — ten distinct hues (light bg +
 * dark text). Gray is INTENTIONALLY absent: gray belongs to
 * Unassigned alone within this dropdown.
 */
export const MEMBER_CHIP_PALETTE: readonly SelectChip[] = [
  { background: "#dbeafe", color: "#1e40af" },
  { background: "#ede9fe", color: "#5b21b6" },
  { background: "#ffedd5", color: "#7c2d12" },
  { background: "#ccfbf1", color: "#0f766e" },
  { background: "#fce7f3", color: "#9d174d" },
  { background: "#dcfce7", color: "#166534" },
  { background: "#fef3c7", color: "#78350f" },
  { background: "#cffafe", color: "#0e7490" },
  { background: "#ecfccb", color: "#3f6212" },
  { background: "#e0e7ff", color: "#3730a3" },
];

/** The ONLY gray chip in the Assigned To dropdown. */
export const UNASSIGNED_CHIP: SelectChip = { ...GRAY_LIGHT };

/** djb2 — deterministic member→palette start slot, no dependencies. */
function hashUserId(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Chip for one team member — deterministic AND unique within the
 * CURRENT roster: members are processed in roster order, each
 * probing from its hash start for the first palette slot no
 * earlier member took. Appending a teammate never recolors
 * earlier members; a new member takes another free color while
 * one exists. Returns null for ids outside the roster (removed
 * members / legacy values render plain, preserved as-is).
 */
export function assigneeChipFor(
  userId: string,
  rosterUserIds: ReadonlyArray<string>,
): SelectChip | null {
  const index = rosterUserIds.indexOf(userId);
  if (index < 0) return null;
  const used = new Set<number>();
  let pick = 0;
  for (let i = 0; i <= index; i++) {
    const start = hashUserId(rosterUserIds[i]) % MEMBER_CHIP_PALETTE.length;
    pick = start;
    for (let k = 0; k < MEMBER_CHIP_PALETTE.length; k++) {
      const slot = (start + k) % MEMBER_CHIP_PALETTE.length;
      if (!used.has(slot)) {
        pick = slot;
        break;
      }
    }
    used.add(pick);
  }
  return MEMBER_CHIP_PALETTE[pick];
}

/**
 * Chip for one dropdown value, or null when the value stays
 * neutral (unknown field/value, Assigned To members, Clear,
 * Unassigned, and — always — empty values which keep "—").
 */
export function getSelectChip(
  fieldName: string,
  value: string | null | undefined,
): SelectChip | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const field = (fieldName ?? "").trim().toLowerCase();
  if (field === "no. of calls tried") return callsTriedChip(value);
  const options = CHIP_MAP[field];
  if (!options) return null;
  return options[value.trim().toLowerCase()] ?? null;
}
