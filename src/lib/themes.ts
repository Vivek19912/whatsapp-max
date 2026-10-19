/**
 * Single source of truth for the color-theme catalog.
 *
 * The CSS variables themselves live in `src/app/globals.css` under
 * `html[data-theme="..."]` blocks — that file is the one we paste
 * theme tokens into. This module only carries the metadata the UI
 * (settings picker, no-flash boot script) needs.
 *
 * Adding a new theme is a two-step change:
 *   1. Append the new `html[data-theme="<id>"]` block in globals.css
 *      with every token from an existing theme (use violet as the
 *      shape reference).
 *   2. Add an entry below. The order here drives the picker grid.
 */

export const THEME_IDS = [
  "violet",
  "emerald",
  "cobalt",
  "amber",
  "rose",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "cobalt";

export const STORAGE_KEY = "wacrm.theme";

/**
 * MODE — the light/dark dimension, orthogonal to the accent theme.
 *
 * The CSS variables live in `src/app/globals.css` under
 * `html[data-mode="..."]` blocks (neutral surfaces only). Applied
 * at runtime via `document.documentElement.dataset.mode`. Dark is
 * the historical default and stays the app's identity; light is the
 * opt-in eye-strain-friendly alternative.
 *
 * Persisted under its own localStorage key so it composes freely
 * with the accent choice (you can run Violet-light or Violet-dark).
 */
export const MODES = ["light", "dark"] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "dark";

export const MODE_STORAGE_KEY = "wacrm.mode";

export function isMode(value: unknown): value is Mode {
  return (
    typeof value === "string" && (MODES as ReadonlyArray<string>).includes(value)
  );
}

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  /**
   * Static swatch color for the picker chip. Hard-coded so the boot
   * script / picker cards don't need a getComputedStyle round trip
   * before the page settles. Must mirror `--primary` of the same
   * theme in globals.css.
   */
  swatch: string;
}

export const THEMES: ReadonlyArray<ThemeMeta> = [
  {
    id: "violet",
    name: "Violet",
    tagline: "The default — confident, slightly playful.",
    swatch: "oklch(0.526 0.247 293)",
  },
  {
    id: "emerald",
    name: "Emerald",
    tagline: "Growth-coded, nods at messaging without copying WhatsApp green.",
    swatch: "oklch(0.62 0.16 162)",
  },
  {
    id: "cobalt",
    name: "Cobalt",
    tagline: "Clean B2B-SaaS blue — calm and product-y.",
    swatch: "oklch(0.585 0.2 254)",
  },
  {
    id: "amber",
    name: "Amber",
    tagline: "Warm and friendly — feels good for SMB teams.",
    swatch: "oklch(0.745 0.16 65)",
  },
  {
    id: "rose",
    name: "Rose",
    tagline: "Bold and modern — D2C, creator-economy, lifestyle.",
    swatch: "oklch(0.645 0.22 16)",
  },
];

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    (THEME_IDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * FONT — the typeface dimension, orthogonal to accent + mode.
 *
 * The CSS lives in `src/app/globals.css` under `html[data-font="..."]`
 * blocks, each overriding `--font-sans`. Web faces are vendored as WOFF2
 * files and loaded with `next/font/local` in `src/app/layout.tsx` (with
 * `preload: false` for the non-default ones); Helvetica / Arial / SF Pro
 * are system stacks — SF Pro only renders on Apple devices and falls
 * back to the platform UI font elsewhere.
 *
 * Adding a font is a three-step change: add its WOFF2 file under
 * src/app/fonts and load it in layout.tsx, add its
 * `html[data-font="<id>"]` block in globals.css, and add an entry below.
 */

export const FONT_IDS = [
  "inter",
  "roboto",
  "helvetica",
  "arial",
  "sf-pro",
  "open-sans",
  "poppins",
  "montserrat",
  "lato",
  "nunito-sans",
] as const;

export type FontId = (typeof FONT_IDS)[number];

export const DEFAULT_FONT: FontId = "inter";

export const FONT_STORAGE_KEY = "wacrm.font";

export function isFontId(value: unknown): value is FontId {
  return (
    typeof value === "string" &&
    (FONT_IDS as ReadonlyArray<string>).includes(value)
  );
}

export interface FontMeta {
  id: FontId;
  name: string;
  /**
   * CSS font-family used to render this card's preview text in the
   * picker. Mirrors the `--font-sans` value of the matching
   * `html[data-font]` block in globals.css.
   */
  preview: string;
}

export const FONTS: ReadonlyArray<FontMeta> = [
  {
    id: "inter",
    name: "Inter",
    preview: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "roboto",
    name: "Roboto",
    preview: "var(--font-roboto), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "helvetica",
    name: "Helvetica",
    preview: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    id: "arial",
    name: "Arial",
    preview: "Arial, Helvetica, sans-serif",
  },
  {
    id: "sf-pro",
    name: "SF Pro",
    preview:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", sans-serif',
  },
  {
    id: "open-sans",
    name: "Open Sans",
    preview: "var(--font-open-sans), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "poppins",
    name: "Poppins",
    preview: "var(--font-poppins), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "montserrat",
    name: "Montserrat",
    preview: "var(--font-montserrat), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "lato",
    name: "Lato",
    preview: "var(--font-lato), ui-sans-serif, system-ui, sans-serif",
  },
  {
    id: "nunito-sans",
    name: "Nunito Sans",
    preview: "var(--font-nunito-sans), ui-sans-serif, system-ui, sans-serif",
  },
];
