// ============================================================
// Workspace header colors — pure model (no React, no I/O).
//
// EXACT reference palette (never approximated):
//   #93c47d  default / remaining business column (green)
//   #6d9eeb  Phone Number (blue)
//   #ff9900  retired Name orange (never auto-assigned — explicit
//           customs and picker presets only)
//   #46bdc6  Follow-Up Status / Follow Up (teal)
//   #34a853  Final Remark (green)
//   #ea4335  Reason for Lost Lead (red)
//
// Plus two fixed semantics:
//   #f1f5f9  Row-number ("No.") column
//   #cbd5e1  Name column (Cool Gray — paints ONLY the Name header,
//           never dealt to generic columns)
//
// Resolution per visible set (deterministic, visible-order):
//   1. stored custom overrides win first (first-wins in
//      visible order — the API rejects duplicate customs with
//      409 and the picker blocks them, so first-wins is pure
//      defense);
//   2. semantic palette matches (phone/name/follow-up/remark/
//      lost) when the color is still free — Name resolves to Cool
//      Gray, which is reserved for the Name header alone;
//   3. UNUSED assignable palette colors are reassigned, in palette
//      order, to the remaining columns in visible order — so a
//      mapped color never disappears just because its column is
//      absent from this flow (e.g. no "Reason for Lost Lead"
//      column: #ea4335 still paints another visible column).
//      Retired orange (#ff9900) is excluded here: freeing it must
//      never repaint a neighbouring header, so only the other
//      five palette slots circulate;
//   4. beyond six non-custom columns, the deterministic
//      generated ring supplies overflow hues in visible order
//      (columns outnumber palette slots; uniqueness is
//      preserved while the pool lasts, no randomness);
//   5. ADJACENCY: after the passes above, a final left-to-right
//      repair over the given visible order guarantees no two
//      horizontally adjacent visible headers share a background.
//      When the pool is exhausted and reuse is unavoidable, the
//      repair cycles through the existing palette (reference,
//      then fallback ring, then overflow hues), picking the
//      first candidate that differs from its left neighbour —
//      so cycling never produces a consecutive repeat,
//      including the first/last columns of scrollable tables.
//
// Appending a column never changes an earlier column's color;
// customs never move; the same (visId, label) always resolves
// the same default while the pool lasts. Hiding, showing,
// reordering, or adding columns simply re-runs this builder on
// the new visible order, so neighbours are always rechecked.
//
// Text contrast (WCAG): the header text color is picked per
// background by contrast ratio — dark slate on light
// backgrounds, white on dark ones (e.g. #ea4335) — so
// readability never depends on the background. Backgrounds are
// flat fills only: no gradients, no heavy borders. Color is
// decorative only; labels and structure carry all information.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

/** Dark slate header text for light backgrounds. */
export const HEADER_TEXT_DARK = "#1e293b";
/** White header text for dark custom backgrounds. */
export const HEADER_TEXT_LIGHT = "#ffffff";

/**
 * Exact reference palette, in sequential fallback order. Lowercase
 * #rrggbb — the ONLY backgrounds the default assignment may use.
 */
export const HEADER_REFERENCE_PALETTE: readonly string[] = [
  "#93c47d", // default / remaining business column
  "#6d9eeb", // Phone Number
  "#ff9900", // retired Name orange (never auto-assigned)
  "#46bdc6", // Follow-Up Status / Follow Up
  "#34a853", // Final Remark
  "#ea4335", // Reason for Lost Lead
];

/**
 * Retired reference backgrounds: kept in the palette/pool
 * constants (and picker presets) for explicit customs, but never
 * dealt by the automatic assignment — freeing one must never
 * repaint another header. Name orange lives here: the Name header
 * paints Cool Gray via semantics while neighbours keep the exact
 * colors they had when orange was consumed.
 */
const RETIRED_REFERENCE_BACKGROUNDS: readonly string[] = ["#ff9900"];

/** True when the builder may deal this background automatically. */
function isAutoAssignable(cand: string): boolean {
  return !RETIRED_REFERENCE_BACKGROUNDS.some((r) => r === bgKey(cand));
}

/** Default / remaining business column background. */
export const HEADER_REFERENCE_DEFAULT = "#93c47d";
/** Row-number ("No.") column background. */
export const HEADER_REFERENCE_ROW = "#f1f5f9";
/** Phone Number column background. */
export const HEADER_REFERENCE_PHONE = "#6d9eeb";
/** Name column background (Cool Gray — paints only the Name header). */
export const HEADER_REFERENCE_NAME = "#cbd5e1";
/** Follow-Up Status / Follow Up column background. */
export const HEADER_REFERENCE_FOLLOW_UP = "#46bdc6";
/** Final Remark column background. */
export const HEADER_REFERENCE_FINAL_REMARK = "#34a853";
/** Reason for Lost Lead column background. */
export const HEADER_REFERENCE_LOST_REASON = "#ea4335";

/** hsl(degrees, %, %) → lowercase #rrggbb. */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/**
 * Fallback pastel ring for dynamic columns (flow answers, new
 * custom fields): 24 golden-angle hues at fixed pastel
 * saturation/lightness — distinct from each other and from
 * every curated default by construction (test-verified).
 */
export const HEADER_FALLBACK_PALETTE: readonly string[] = Array.from(
  { length: 24 },
  (_, i) => hslToHex(i * 137.5, 62, 87),
);

/** Full pool: reference palette first, generated ring after. */
export const HEADER_COLOR_POOL: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
  ...HEADER_FALLBACK_PALETTE,
];

/**
 * Beyond-pool overflow (pathological 40+ column tables):
 * continued golden-angle hues at a deeper lightness — still
 * deterministic hex, still probed for freeness by the builder.
 */
export function overflowHeaderColor(n: number): string {
  return hslToHex(n * 137.5 + 31, 62, 82);
}

/**
 * Preset swatches offered in the picker: exactly the reference
 * palette. Arbitrary (incl. dark) colors remain available via
 * the custom native color input, with auto text contrast.
 */
export const HEADER_COLOR_PRESETS: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
];

/** Every reference color, exported for the pairwise-uniqueness test. */
export const HEADER_CURATED_DEFAULTS: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
];

/** Visible-order cycling helper (no id hashing). */

/**
 * Semantic reference color for a column, or null when the column
 * carries no mapped meaning. Matching is case-insensitive on the
 * trimmed label, plus the two stable flow field ids:
 *   - Phone Number ("Phone No", "Phone Number", …) → blue
 *   - Name → Cool Gray (reserved: never dealt to other columns)
 *   - Follow-Up Status / Follow Up (exactly the status field —
 *     NOT "Next Follow-up Date & Time") → teal
 *   - Final Remark → green
 *   - Reason for Lost Lead / Reason of Lost → red
 */
function semanticReferenceColor(visId: string, label: string): string | null {
  if (visId === "core:row") return HEADER_REFERENCE_ROW;
  if (visId === "flow:phone") return HEADER_REFERENCE_PHONE;
  if (visId === "flow:name") return HEADER_REFERENCE_NAME;
  const name = typeof label === "string" ? label.trim().toLowerCase() : "";
  if (name === "row") return HEADER_REFERENCE_ROW;
  if (name.includes("phone")) return HEADER_REFERENCE_PHONE;
  if (name === "name") return HEADER_REFERENCE_NAME;
  if (
    name === "follow up" ||
    name.includes("follow-up status") ||
    name.includes("follow up status")
  ) {
    return HEADER_REFERENCE_FOLLOW_UP;
  }
  if (name.includes("final remark")) return HEADER_REFERENCE_FINAL_REMARK;
  if (
    name.includes("reason for lost lead") ||
    name.includes("reason of lost")
  ) {
    return HEADER_REFERENCE_LOST_REASON;
  }
  return null;
}

/** Fixed preferred default: semantic match, else the default green. */
function preferredDefaultColor(visId: string, label: string): string {
  return semanticReferenceColor(visId, label) ?? HEADER_REFERENCE_DEFAULT;
}

/**
 * Default header background for one column. Pure + stable:
 * same (visId, label) always yields the same color — the
 * semantic reference color when the column carries mapped
 * meaning, else the default green. NOTE: set-wide palette
 * reuse (unused mapped colors reassigned to visible columns)
 * lives in buildHeaderColorMap — this single-column form cannot
 * see its neighbours (kept for previews/fallbacks).
 */
export function defaultHeaderColor(visId: string, label: string): string {
  return preferredDefaultColor(visId, label);
}

export interface HeaderColumnRef {
  visId: string;
  label: string;
  /**
   * Legacy/alternate custom keys to honour for stored overrides
   * (migration only). The Workspace table keys flow headers by
   * render key (`sys:<key>` / `flow:<key>`) so a system column and
   * a flow answer sharing one logical key never collapse to a
   * single map entry — but overrides persisted under the legacy
   * `flow:<key>` id still apply via this fallback list.
   */
  fallbackIds?: ReadonlyArray<string>;
}

/** Normalized (lowercase, trimmed) comparison key for backgrounds. */
function bgKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Effective header backgrounds for a visible column set:
 *
 *   1. valid stored customs, first-wins in visible order
 *      (a duplicated custom — only possible via a raced write
 *      the API now rejects — falls back to a free default);
 *      legacy `fallbackIds` customs apply when the primary id
 *      has no override (stored-key migration);
 *   2. semantic reference colors for mapped columns, when free;
  *   3. UNUSED assignable reference palette colors, in palette
  *      order, assigned to the remaining columns in visible order
  *      — a mapped color never disappears just because its column
  *      is absent from this flow (retired orange excepted: it is
  *      never dealt, so freeing it repaints no other header);
 *   4. beyond the six palette slots, the deterministic
 *      generated ring in pool order, then overflow hues;
 *   5. positional adjacency: every pick must differ from the
 *      immediately preceding visible header (palette cycles
 *      pick another existing color instead of naively repeating
 *      from the first slot when that would duplicate).
 *
 * Deterministic: same visible order (+ customs) always yields
 * the same map. Appending a column never changes an earlier
 * fixed column's color; customs never move.
 *
 * IMPORTANT: pass columns in current visible/display order with
 * one entry PER RENDERED header (hidden columns excluded,
 * display reorders applied, system/flow key collisions kept as
 * separate entries with distinct visIds). The builder assigns
 * positionally, so hide/show/reorder/add callers must rebuild
 * with the new order. Keyed-map callers must use unique ids per
 * rendered header (e.g. the flow render key `sys:<key>` /
 * `flow:<key>`); sharing one id between two rendered headers
 * forces them onto one map entry and no map-level repair can
 * separate them — use assignHeaderBackgrounds (positional)
 * for the rendered sequence instead.
 */
export function buildHeaderColorMap(
  columns: ReadonlyArray<HeaderColumnRef>,
  customs?: Readonly<Record<string, string>> | null,
): Record<string, string> {
  const backgrounds = assignHeaderBackgrounds(columns, customs);
  const map: Record<string, string> = {};
  columns.forEach((col, i) => {
    map[col.visId] = backgrounds[i];
  });
  return map;
}

/** Valid stored custom for a column (primary id, then legacy fallbacks). */
function customFor(
  col: HeaderColumnRef,
  customs: Readonly<Record<string, string>> | null | undefined,
): string | null {
  const ids: ReadonlyArray<string> = [
    col.visId,
    ...(col.fallbackIds ?? []),
  ];
  for (const id of ids) {
    const raw = customs?.[id];
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        return normalizeHeaderColor(raw);
      } catch {
        // Invalid stored value → try next id, else default path.
      }
    }
  }
  return null;
}

/**
 * Positional header backgrounds for the EXACT rendered visible
 * order — one background per entry, index-aligned with the input.
 * This is the primitive the Workspace table renders from: it
 * cannot collapse (duplicate ids keep separate slots) and needs
 * no key lookup, so there is no miss/fallback path that can
 * repaint neighbours with the per-column green default.
 *
 * Assignment (visible order throughout, customs → semantics →
 * unused assignable palette → unused assignable pool → unused
 * overflow → cycle): customs win first-wins globally, semantic
 * reference colors win when still free (a mapped color never
 * disappears just because its column sits later in the order),
 * then unused colors fill in visible order. A final left-to-right sweep guarantees every
 * background differs from its predecessor — normally a no-op
 * (the passes above already keep every slot unique while the
 * pool lasts), rewriting only the later slot with the first
 * unused-or-cycled existing color that differs when reuse is
 * unavoidable. Appending never moves earlier slots while the
 * pool lasts; hide/show/reorder/add rebuild with the new order.
 */
export function assignHeaderBackgrounds(
  columns: ReadonlyArray<HeaderColumnRef>,
  customs?: Readonly<Record<string, string>> | null,
): string[] {
  const backgrounds: string[] = new Array(columns.length);
  const used = new Set<string>();

  // Pass 1 — customs, first-wins in visible order.
  const needy: number[] = [];
  columns.forEach((col, i) => {
    const custom = customFor(col, customs);
    if (custom !== null && !used.has(bgKey(custom))) {
      backgrounds[i] = custom;
      used.add(bgKey(custom));
    } else {
      needy.push(i);
    }
  });

  // Pass 2 — semantic reference colors, when still free.
  const stillNeedy: number[] = [];
  for (const i of needy) {
    const pref = semanticReferenceColor(columns[i].visId, columns[i].label);
    if (pref !== null && !used.has(bgKey(pref))) {
      backgrounds[i] = pref;
      used.add(bgKey(pref));
    } else {
      stillNeedy.push(i);
    }
  }

  // Pass 3 — unused palette, then pool, then overflow hues, in
  // visible order; positional cycle when everything is taken.
  // Retired backgrounds (Name orange) are skipped in the palette
  // and pool scans so freeing one never repaints another header.
  for (const i of stillNeedy) {
    let pick: string | null = null;
    for (const cand of HEADER_REFERENCE_PALETTE) {
      if (!used.has(bgKey(cand)) && isAutoAssignable(cand)) {
        pick = cand;
        break;
      }
    }
    if (pick === null) {
      for (const cand of HEADER_COLOR_POOL) {
        if (!used.has(bgKey(cand)) && isAutoAssignable(cand)) {
          pick = cand;
          break;
        }
      }
    }
    if (pick === null) {
      for (let n = 0; n < 500; n++) {
        const cand = overflowHeaderColor(n);
        if (!used.has(bgKey(cand))) {
          pick = cand;
          break;
        }
      }
    }
    if (pick === null) {
      const pos = stillNeedy.indexOf(i);
      pick = HEADER_COLOR_POOL[pos % HEADER_COLOR_POOL.length];
    }
    backgrounds[i] = pick;
    used.add(bgKey(pick));
  }

  // Pass 4 — positional adjacency sweep: backgrounds[i] must
  // differ from backgrounds[i - 1] (normalized). A no-op while
  // the pool lasts (every slot is already unique). When reuse is
  // unavoidable, the later slot takes the first UNUSED existing
  // color that differs, else cycles to the first existing color
  // that differs — never a naive repeat that duplicates the
  // predecessor. First/last columns are the ends of the same
  // sweep, so the scrollable tail obeys the same rule.
  for (let i = 1; i < columns.length; i++) {
    if (bgKey(backgrounds[i]) === bgKey(backgrounds[i - 1])) {
      const prev = backgrounds[i - 1];
      let replacement: string | null = null;
      for (const cand of HEADER_REFERENCE_PALETTE) {
        if (!used.has(bgKey(cand)) && bgKey(cand) !== bgKey(prev)) {
          replacement = cand;
          break;
        }
      }
      if (replacement === null) {
        for (const cand of HEADER_COLOR_POOL) {
          if (!used.has(bgKey(cand)) && bgKey(cand) !== bgKey(prev)) {
            replacement = cand;
            break;
          }
        }
      }
      if (replacement === null) {
        for (let n = 0; n < 500; n++) {
          const cand = overflowHeaderColor(n);
          if (!used.has(bgKey(cand)) && bgKey(cand) !== bgKey(prev)) {
            replacement = cand;
            break;
          }
        }
      }
      if (replacement === null) {
        for (const cand of HEADER_REFERENCE_PALETTE) {
          if (bgKey(cand) !== bgKey(prev) && isAutoAssignable(cand)) {
            replacement = cand;
            break;
          }
        }
      }
      if (replacement === null) {
        for (const cand of HEADER_COLOR_POOL) {
          if (bgKey(cand) !== bgKey(prev) && isAutoAssignable(cand)) {
            replacement = cand;
            break;
          }
        }
      }
      // Defensive only (the palette holds ≥2 distinct entries).
      backgrounds[i] = replacement ?? prev;
      used.add(bgKey(backgrounds[i]));
    }
  }

  return backgrounds;
}

/**
 * True when every pair of horizontally adjacent visible columns
 * has different effective backgrounds. Helper for tests and
 * page-wiring assertions — the invariant buildHeaderColorMap
 * guarantees for the visible order it was given (callers must
 * pass unique ids per rendered header; duplicate ids collapse
 * to one map entry, so prefer areAdjacentBackgroundsDistinct on
 * the positional assignHeaderBackgrounds output for rendered
 * sequences).
 */
export function areAdjacentHeaderColorsDistinct(
  columns: ReadonlyArray<HeaderColumnRef>,
  colorMap: Readonly<Record<string, string>>,
): boolean {
  for (let k = 1; k < columns.length; k++) {
    const a = colorMap[columns[k - 1].visId];
    const b = colorMap[columns[k].visId];
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (normalizeRenderedColor(a) === normalizeRenderedColor(b)) return false;
  }
  return true;
}

/**
 * Positional adjacency check over rendered backgrounds:
 * `backgrounds[i] !== backgrounds[i - 1]` for every adjacent
 * pair, compared on normalized colors (equivalent colors in
 * different formats count as equal). This is the assertion the
 * Workspace table must satisfy over its final ordered header
 * list, including the scrollable tail.
 */
export function areAdjacentBackgroundsDistinct(
  backgrounds: ReadonlyArray<string>,
): boolean {
  for (let k = 1; k < backgrounds.length; k++) {
    const a = backgrounds[k - 1];
    const b = backgrounds[k];
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (normalizeRenderedColor(a) === normalizeRenderedColor(b)) return false;
  }
  return true;
}

/**
 * Normalize a rendered background for comparison: lowercase
 * #rrggbb for hex (`#rgb` expanded), `rgb()`/`rgba()` converted
 * to hex, surrounding whitespace ignored. Unparseable values
 * degrade to their trimmed lowercase form (never throws), so
 * equivalent colors in different formats still compare equal.
 */
export function normalizeRenderedColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  try {
    return normalizeHeaderColor(trimmed);
  } catch {
    // Fall through to rgb()/rgba() below.
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/.exec(
    trimmed,
  );
  if (rgb) {
    const [, r, g, b] = rgb;
    const to = (n: string) =>
      Math.max(0, Math.min(255, Number(n)))
        .toString(16)
        .padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }
  return trimmed;
}

/**
 * Normalize a color to lowercase #rrggbb. Accepts #rgb / #rrggbb
 * (any case, surrounding whitespace tolerated). Throws on
 * anything else — the API and the picker share this gate.
 */
export function normalizeHeaderColor(value: unknown): string {
  if (typeof value !== "string") throw new Error("Color must be a hex value.");
  const trimmed = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  throw new Error("Color must be a hex value like #6d9eeb.");
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Readable header text for a background: whichever of dark slate
 * / white contrasts more (WCAG ratio). Pastels → dark slate; a
 * dark custom pick → white, automatically.
 */
export function headerTextColor(background: string): string {
  let bg = HEADER_TEXT_DARK;
  try {
    bg = normalizeHeaderColor(background);
  } catch {
    return HEADER_TEXT_DARK;
  }
  const lum = relativeLuminance(bg);
  const dark = contrastRatio(lum, relativeLuminance(HEADER_TEXT_DARK));
  const light = contrastRatio(lum, relativeLuminance(HEADER_TEXT_LIGHT));
  return light > dark ? HEADER_TEXT_LIGHT : HEADER_TEXT_DARK;
}

/** True when the background takes the dark (white-text) path. */
export function isDarkHeaderColor(background: string): boolean {
  return headerTextColor(background) === HEADER_TEXT_LIGHT;
}

/**
 * Effective header background for ONE column: the stored custom
 * override when present and valid, else the default. (Set-wide
 * uniqueness lives in buildHeaderColorMap; this stays for
 * single-cell previews such as the manager dots.)
 */
export function resolveHeaderColor(
  visId: string,
  label: string,
  customs: Readonly<Record<string, string>> | null | undefined,
): string {
  const raw = customs?.[visId];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return normalizeHeaderColor(raw);
    } catch {
      // Corrupt stored value degrades to the default — never blank.
    }
  }
  return defaultHeaderColor(visId, label);
}
