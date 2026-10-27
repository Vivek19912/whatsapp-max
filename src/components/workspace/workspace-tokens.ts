"use client";

/**
 * Workspace design tokens — one source of truth for the control
 * sizes, spacing rhythm, and dialog widths used across the
 * Workspace header, table controls, filters, and configuration
 * dialogs. Components reference these instead of inventing their
 * own ad-hoc values, so the toolbar, table headers, filters, and
 * dialogs feel like one application.
 *
 * Visual rules encoded here:
 * - Single control height for toolbar/controls row (h-9) with a
 *   compact variant (h-8) for dense popover triggers.
 * - Semantic color tokens only (bg-card, text-foreground, …) so
 *   every surface follows the active light/dark theme.
 * - Dialog widths by content type: md (simple forms), lg
 *   (two-section configs), xl (wide editors like assignment).
 * - Consistent section heading + description styles.
 */

export const WS_CONTROL_HEIGHT = "h-9" as const;
export const WS_CONTROL_HEIGHT_SM = "h-8" as const;

/** Primary toolbar action button (header row). */
export const WS_ACTION_BUTTON =
  "h-9 gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground shadow-xs hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

/** Secondary control-row button (matches Columns/Filters triggers). */
export const WS_CONTROL_BUTTON =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-muted-foreground shadow-xs hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

/** Text input shared by the search field and dialog forms. */
export const WS_INPUT = "h-9 rounded-lg border-border bg-card text-sm shadow-xs";

/** Compact input for dense popover/dialog interiors. */
export const WS_INPUT_SM = "h-8 rounded-lg border-border bg-card text-[13px] shadow-xs";

/** Section heading inside cards and dialog sections. */
export const WS_SECTION_TITLE = "text-sm font-semibold text-foreground";

/** Section description below a heading. */
export const WS_SECTION_HINT = "text-xs text-muted-foreground";

/** Field label above an input/select. */
export const WS_FIELD_LABEL = "text-xs font-medium text-foreground";

/** Muted helper text below a field. */
export const WS_FIELD_HINT = "text-xs text-muted-foreground";

/** Dialog width presets by content type. */
export const WS_DIALOG_WIDTH = {
  /** Simple confirmations and short forms. */
  md: "sm:max-w-lg",
  /** Two-section configurations (sheets, WhatsApp, Travel CRM). */
  lg: "sm:max-w-2xl",
  /** Wide editors (assignment). Full width on mobile. */
  xl: "sm:max-w-3xl lg:max-w-4xl",
} as const;

export type WsDialogWidth = keyof typeof WS_DIALOG_WIDTH;

/** Status badge tone for Active/Paused/Off states. */
export function wsStatusTone(active: boolean): "default" | "secondary" | "outline" {
  return active ? "default" : "secondary";
}
