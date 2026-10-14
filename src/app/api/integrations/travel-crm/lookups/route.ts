import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getTravelCrmConfig } from "@/lib/integrations/travel-crm/config";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import { fetchTravelCrmLookups } from "@/lib/integrations/travel-crm/client";
import { buildItineraryLookups } from "@/lib/integrations/travel-crm/itineraries";

export const dynamic = "force-dynamic";

/**
 * GET /api/integrations/travel-crm/lookups — itinerary lookup proxy.
 *
 * Server-only Travel CRM fetch (Bearer secret never leaves the
 * server; responses are secret-free): proxies the EXISTING
 * upstream lookups endpoint
 *   GET {base}/api/integrations/wacrm/lookups
 * and returns ONLY the itinerary-relevant slice parsed from its
 * real payload — never hardcoded WACRM values:
 *
 *   { destinations: [{value,label,countryName,privateName}],
 *     cities: [{value,label,destinationValue}],
 *     citiesByDestination: {<destinationValue>: [{value,label}]} }
 *
 * `countryName`/`privateName` are forwarded verbatim from the
 * upstream feed (null when it omits them) for country-grouped,
 * private-name-searchable dropdowns; they are display/search
 * metadata only and never enter stored values.
 *
 * Lookup bootstrap: the account owner's email (resolved server-side
 * from the authenticated account's own rows — never request input)
 * travels as an `assignedToEmail` query locator so Travel CRM can
 * associate its credential on first use. The secret itself stays in
 * the Authorization header only. A missing locator degrades to the
 * previous behavior (plain credential-only fetch).
 *
 * Empty arrays mean "Travel CRM provided nothing usable" — the
 * UI must show loading/error states, never fake options.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { baseUrl, secret } = getTravelCrmConfig();
    if (!secret) {
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_NOT_CONFIGURED",
          error: "Travel CRM integration is not configured.",
          destinations: [],
          cities: [],
          citiesByDestination: {},
        },
        { status: 503 },
      );
    }
    let lookups: Record<string, unknown>;
    try {
      const ownerEmail = await resolveAccountOwnerEmail(ctx.supabase, ctx.accountId);
      lookups = await fetchTravelCrmLookups(
        baseUrl,
        secret,
        fetch,
        ownerEmail ? { ownerEmail } : undefined,
      );
    } catch (err) {
      console.error(
        "[travel-crm] itinerary lookups fetch failed:",
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_UNAVAILABLE",
          error: "Could not load Travel CRM destinations.",
          destinations: [],
          cities: [],
          citiesByDestination: {},
        },
        { status: 502 },
      );
    }
    const built = buildItineraryLookups(lookups);
    return NextResponse.json({
      success: true,
      destinations: built.destinations,
      cities: built.cities,
      citiesByDestination: built.citiesByDestination,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
