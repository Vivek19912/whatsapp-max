// Brand identity is sourced from the site-wide single source of truth
// (`@/lib/site`) so the homepage, legal pages, robots and sitemap stay
// in lockstep. Re-exported here so existing imports from this module
// keep working unchanged.
export {
  PRODUCT_NAME,
  COMPANY_NAME,
  WEBSITE_DOMAIN,
  SUPPORT_EMAIL,
} from "@/lib/site";

// Human-readable effective dates shown at the top of each document.
// Update these whenever the policies materially change. Kept separate so
// a privacy-policy update doesn't misdate the terms.
export const PRIVACY_EFFECTIVE_DATE = "October 26, 2026";
export const TERMS_EFFECTIVE_DATE = "July 25, 2026";
// Back-compat: existing imports keep working.
export const EFFECTIVE_DATE = PRIVACY_EFFECTIVE_DATE;
