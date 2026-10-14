import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import {
  loadWorkspaceLead,
  type TravelCrmAssignmentIssue,
} from "@/lib/integrations/travel-crm/lead";
import { resolveAccountOwnerEmail } from "@/lib/integrations/travel-crm/account-owner";
import {
  buildReceivedOptions,
  canonicalizeLeadSource,
  canonicalizeOptionLabel,
  canonicalizeServices,
  isTravelCrmReady,
  mapLeadToTravelCrm,
  type WacrmAnswerSource,
} from "@/lib/integrations/travel-crm/mapping";
import { splitServiceLabels } from "@/lib/integrations/travel-crm/services";
import { DEFAULT_DEPARTURE_COUNTRY } from "@/lib/integrations/travel-crm/departure-catalog";
import { readFlowItineraryDefaults, readFlowServiceLabels, readFlowDepartureDefaults } from "@/lib/integrations/travel-crm/flow-settings";
import {
  LEAD_STAGE_DEFAULT_VALUE,
  LEAD_TYPE_DEFAULT_VALUE,
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
  isLeadReceivedField,
  isLeadTypeField,
  isStageField,
} from "@/lib/flows/workspace-defaults";
import {
  buildItineraryLookups,
  cityLabelForValue,
  defaultsToDraftItinerary,
  destinationLabelForValue,
  normalizeItineraryDefaults,
} from "@/lib/integrations/travel-crm/itineraries";
import {
  getTravelCrmConfig,
  travelCrmLeadUrl,
} from "@/lib/integrations/travel-crm/config";
import {
  createTravelCrmLead,
  extractLookupOptions,
  fetchTravelCrmLookups,
  TravelCrmError,
  verifyTravelCrmLead,
  type LookupOption,
} from "@/lib/integrations/travel-crm/client";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";

export const dynamic = "force-dynamic";

/**
 * POST /api/integrations/travel-crm/leads — Phase 3 (connected).
 *
 * Two phases, one endpoint, no external call until the payload is
 * provably complete:
 *
 *   1. prepare  {flow_id, flow_run_id} → validates the lead,
 *      resolves the owner email, maps every field. When required
 *      input is still missing, returns MISSING_FIELDS with the
 *      prefilled draft + option lists (Travel CRM is NOT called).
 *      When everything is ready, creates immediately (one-click).
 *   2. create   {flow_id, flow_run_id, overrides} → merges
 *      user-supplied missing values (validated, member-checked),
 *      then creates when complete, else MISSING_FIELDS again.
 *
 * Success carries a REAL external lead ID + lead URL and flips
 * the idempotency link to `created`. A stored external ID short-
 * circuits as already-created without calling Travel CRM.
 * Credentials never leave the server (responses are asserted
 * secret-free in tests).
 */

const OVERRIDE_LABELS: Record<string, string> = {
  email: "Email",
  travelStartDate: "Travel Date",
  destination: "Destination",
  city: "City",
  nights: "Nights",
  departureCountry: "Departure Country",
  departureCity: "Departure City",
  rooms: "Rooms",
};
// NOTE: services, travelers (adults/children/infants/ages), and
// itinerary bypass OVERRIDE_LABELS via dedicated direct-draft
// override paths below (same pattern as Name/Phone), so dialog
// edits never collide with mapped answers or flow defaults as
// false ambiguities.
// NOTE: traveler counts (adults/children/infants) and age arrays
// intentionally bypass OVERRIDE_LABELS: they apply as direct-draft
// overrides below (same pattern as Name/Phone), so dialog edits
// never collide with mapped answers as false ambiguities.

const FUNNEL_FIELDS = ["leadSource", "leadType", "leadStage"] as const;

type Overrides = Record<string, unknown>;

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function invalidOverrides(message: string, fields?: Record<string, string[]>) {
  return NextResponse.json(
    { success: false, code: "INVALID_OVERRIDES", error: message, fields: fields ?? {} },
    { status: 400 },
  );
}

/**
 * Resolve stored destination/city master UUIDs to their display names
 * for the Travel CRM create payload.
 *
 * Travel CRM's lead itinerary `country`/`destination` fields are free
 * text and its Leads UI renders them verbatim, so WACRM must send NAMES
 * — exactly like manually-created Travel CRM leads (whose form stores the
 * destination/city display names). This resolves each row against the
 * ALREADY-FETCHED, workspace-scoped itinerary lookups (the same source
 * the dialog uses), never an unscoped database lookup:
 *   - `country`  matching a destination master UUID → that destination's label;
 *   - `destination` matching a city master UUID → that city's label;
 *   - any other value (free text, flow-answer names, or a UUID from
 *     another workspace absent from the scoped lookups) passes through
 *     unchanged.
 */
function resolveItineraryForSend(
  rows: ReadonlyArray<{
    country: string | null;
    destination: string | null;
    nights: number | null;
  }>,
  lookups: {
    destinations: ReadonlyArray<{ value: string; label: string }>;
    cities: ReadonlyArray<{ value: string; label: string }>;
  },
): Array<{ country: string; destination: string; nights: number; sequence: number }> {
  return rows.map((row, i) => ({
    country:
      destinationLabelForValue(lookups.destinations, row.country ?? "") ?? (row.country ?? ""),
    destination:
      cityLabelForValue(lookups.cities, row.destination ?? "") ?? (row.destination ?? ""),
    nights: (row.nights ?? 0) as number,
    sequence: i + 1,
  }));
}

/** Maximum traveler age accepted per entry (Travel CRM validates authoritatively). */
const MAX_TRAVELER_AGE = 99;

const TRAVELER_COUNT_FIELDS = [
  { key: "adults", label: "Adults", min: 1, required: true },
  { key: "childrenWithBed", label: "CWB", min: 0, required: false },
  { key: "childrenWithoutBed", label: "CWOB", min: 0, required: false },
  { key: "infants", label: "Infants", min: 0, required: false },
] as const;

const TRAVELER_AGE_FIELDS = [
  { key: "childrenWithBedAges", label: "CWB ages" },
  { key: "childrenWithoutBedAges", label: "CWOB ages" },
  { key: "infantAges", label: "Infant ages" },
] as const;

/**
 * Parse one traveler count override. Absent key → null (no
 * override); blank optional → null (omitted); blank required
 * (Adults) or non-integer/under-minimum → error message.
 */
function parseTravelerCount(
  raw: unknown,
  field: { key: string; label: string; min: number; required: boolean },
): { value: number | null; error: string | null } {
  if (raw === undefined) return { value: null, error: null };
  const text = asText(raw);
  if (text === null) {
    return field.required
      ? { value: null, error: `${field.label} is required.` }
      : { value: null, error: null };
  }
  if (!/^\d+$/.test(text)) {
    return { value: null, error: `${field.label} must be a whole number.` };
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < field.min) {
    return {
      value: null,
      error:
        field.min >= 1
          ? `${field.label} must be at least ${field.min}.`
          : `${field.label} cannot be negative.`,
    };
  }
  return { value: n, error: null };
}

/**
 * Parse one traveler age-array override. Absent key → null (no
 * override); blank entries are dropped (optional ages never
 * block); non-blank entries must be integers 0–99.
 */
function parseTravelerAges(
  raw: unknown,
  label: string,
): { value: number[] | null; error: string | null } {
  if (raw === undefined) return { value: null, error: null };
  if (!Array.isArray(raw)) {
    return { value: null, error: `${label} must be a list.` };
  }
  const out: number[] = [];
  for (const item of raw) {
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof item === "number" && Number.isFinite(item)
          ? String(item)
          : null;
    if (text === null || text === "") continue;
    if (!/^\d+$/.test(text)) {
      return { value: null, error: `${label} must be whole numbers.` };
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_TRAVELER_AGE) {
      return {
        value: null,
        error: `${label} must be between 0 and ${MAX_TRAVELER_AGE}.`,
      };
    }
    out.push(n);
  }
  return { value: out, error: null };
}

interface LinkRow {
  id: string;
  status: string;
  external_lead_id: string | null;
}

async function readLink(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
): Promise<LinkRow | null> {
  const { data, error } = await supabase
    .from("travel_crm_lead_links")
    .select("id, status, external_lead_id")
    .eq("account_id", accountId)
    .eq("flow_run_id", runId)
    .eq("integration_type", "travel-crm")
    .maybeSingle();
  if (error || !data) return null;
  return data as LinkRow;
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const flowId = typeof body?.flow_id === "string" ? body.flow_id.trim() : "";
    const runId =
      typeof body?.flow_run_id === "string" ? body.flow_run_id.trim() : "";
    if (!flowId || !runId) {
      return NextResponse.json(
        { success: false, code: "INVALID_REQUEST", error: "flow_id and flow_run_id are required." },
        { status: 400 },
      );
    }
    const overrides =
      body?.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
        ? (body.overrides as Overrides)
        : {};

    const { baseUrl, secret } = getTravelCrmConfig();
    if (!secret) {
      return NextResponse.json(
        {
          success: false,
          code: "TRAVEL_CRM_NOT_CONFIGURED",
          error:
            "Travel CRM integration is not configured. Set TRAVEL_CRM_BASE_URL and TRAVEL_CRM_INTEGRATION_SECRET on the server.",
        },
        { status: 503 },
      );
    }

    const loaded = await loadWorkspaceLead(supabase, {
      accountId,
      flowId,
      runId,
    });
    if (!loaded) {
      return NextResponse.json(
        { success: false, code: "LEAD_NOT_FOUND", error: "Workspace lead not found." },
        { status: 404 },
      );
    }

    // Existing real link → verify it still exists, then Created
    // state with no external create call and no duplicate. The
    // stored ID alone proves nothing: a lead deleted in Travel CRM
    // would otherwise wedge this run on a dead link forever. Only
    // a CONFIRMED absence (explicit exists:false) clears the
    // association so the normal flow below can re-create; transport
    // errors, auth failures, and ambiguous responses keep the link
    // and behave exactly as before. Verification needs the owner
    // email for tenant scoping, so assignment resolution moves
    // above this check (no behavior change — pure reorder).
    const ownerEmail = await resolveAccountOwnerEmail(supabase, accountId);
    try {
      const existing = await readLink(supabase, accountId, runId);
      if (existing?.external_lead_id) {
        let stale = false;
        if (ownerEmail) {
          try {
            const check = await verifyTravelCrmLead(
              baseUrl,
              secret,
              existing.external_lead_id,
              fetch,
              { ownerEmail },
            );
            stale = !check.exists;
          } catch (err) {
            console.error("[travel-crm] link verification inconclusive (keeping link):", err instanceof Error ? err.message : err);
          }
        }
        if (stale) {
          try {
            await supabase
              .from("travel_crm_lead_links")
              .delete()
              .eq("account_id", accountId)
              .eq("flow_run_id", runId)
              .eq("integration_type", "travel-crm");
          } catch (err) {
            console.error("[travel-crm] stale link clear failed:", err);
          }
        } else {
          return NextResponse.json({
            success: true,
            code: "CREATED",
            leadId: existing.external_lead_id,
            leadUrl: travelCrmLeadUrl(baseUrl, existing.external_lead_id),
            alreadyExists: true,
          });
        }
      }
    } catch (err) {
      console.error("[travel-crm] link read failed:", err);
    }

    // --- Travel CRM assignment: ALWAYS the WACRM workspace owner. ---
    // Business rule: the Travel CRM lead must be assigned to the OWNER of
    // the WACRM workspace (resolved server-side from the authenticated
    // account's own rows — never request input). The WACRM lead's
    // Workspace "Assigned To" value and the dialog's assignedUserId
    // override are intentionally NEVER used for Travel CRM assignment:
    // the creation payload is pinned to the owner email, so Travel CRM
    // finds the owner's matching user and assigns there. Unresolvable
    // owner email gates creation with "assignment-required" instead of
    // sending null (Travel CRM would never silently pick another user).
    // (ownerEmail itself is resolved above, before the link check, so
    // stale-link verification can scope to the correct tenant.)
    const overrideEmail: string | null = ownerEmail;
    const overrideIssue: TravelCrmAssignmentIssue | null = ownerEmail
      ? null
      : "assignment-required";

    // --- Overrides: free inputs become extra mapping candidates. ---
    // --- NOTE: services bypasses this path (dedicated override
    // --- below) so dialog edits never collide with mapped answers
    // --- or flow defaults as false ambiguities. ---
    const extraAnswers: WacrmAnswerSource[] = [];
    for (const [field, label] of Object.entries(OVERRIDE_LABELS)) {
      const raw = overrides[field];
      if (raw === undefined) continue;
      const text = asText(raw);
      if (text !== null) extraAnswers.push({ key: `override:${field}`, label, value: text });
    }

    const { draft, ...mapping } = mapLeadToTravelCrm(
      {
        contact: loaded.contact,
        answers: [...loaded.answers, ...extraAnswers],
        custom: loaded.custom,
        adSourcePlatform: loaded.adSourcePlatform,
      },
      overrideEmail,
      // Exact flow-derived Workspace "Name" column (same derivation
      // the table renders): its answer prefills Travel CRM Name,
      // WhatsApp contact name is the fallback. Never a merge.
      { flowNameColumnKey: loaded.flowNameColumnKey ?? null },
    );

    // Pre-override snapshots for the post-create Workspace two-way
    // sync: only dialog edits (values differing from these) are
    // written back, and only after a successful Travel CRM create.
    const initialCustomerName = draft.customerName;
    const initialPhone = draft.phone;

    // --- Dialog Name/Phone overrides: editable prefilled values at
    // --- the top of the dialog. Reuses the canonical WACRM values
    // --- (draft) as the base; an explicit non-empty override wins
    // --- after the same validation the mapper applies
    // --- (name ≥2 chars, phone ≥5 digits). Invalid rejects with
    // --- INVALID_OVERRIDES, never stored. Empty/absent leaves the
    // --- mapped value untouched.
    const rawName = overrides.customerName;
    if (rawName !== undefined) {
      const text = asText(rawName);
      if (text !== null) {
        if (text.trim().length < 2) {
          return invalidOverrides("Enter a valid name.", {
            customerName: ["Enter a valid name."],
          });
        }
        draft.customerName = text.trim();
        mapping.fields.customerName = {
          status: "available",
          source: { kind: "flow-default", key: "override:customerName" },
        };
        if (!mapping.available.includes("customerName")) {
          mapping.available.push("customerName");
        }
        mapping.missing = mapping.missing.filter((f) => f !== "customerName");
        mapping.ambiguous = mapping.ambiguous.filter((a) => a.field !== "customerName");
        mapping.invalid = mapping.invalid.filter((v) => v.field !== "customerName");
        mapping.ready = isTravelCrmReady(mapping.fields);
      }
    }
    const rawPhone = overrides.phone;
    if (rawPhone !== undefined) {
      const text = asText(rawPhone);
      if (text !== null) {
        if (text.replace(/\D/g, "").length < 5) {
          return invalidOverrides("Enter a valid phone number.", {
            phone: ["Enter a valid phone number."],
          });
        }
        draft.phone = text.trim();
        mapping.fields.phone = {
          status: "available",
          source: { kind: "flow-default", key: "override:phone" },
        };
        if (!mapping.available.includes("phone")) {
          mapping.available.push("phone");
        }
        mapping.missing = mapping.missing.filter((f) => f !== "phone");
        mapping.ambiguous = mapping.ambiguous.filter((a) => a.field !== "phone");
        mapping.invalid = mapping.invalid.filter((v) => v.field !== "phone");
        mapping.ready = isTravelCrmReady(mapping.fields);
      }
    }

    // --- Dialog traveler overrides (Travelers section): validated
    // --- counts and age arrays applied straight onto the draft
    // --- (same direct pattern as Name/Phone), so dialog edits never
    // --- collide with mapped answers as false ambiguities. Adults is
    // --- required (≥1); children/infants are optional (≥0, empty
    // --- omitted); ages are optional (blank entries dropped, the
    // --- rest must be integers 0–99). Invalid rejects with
    // --- INVALID_OVERRIDES, never stored. Editing here never
    // --- mutates saved Workspace defaults.
    for (const field of TRAVELER_COUNT_FIELDS) {
      const parsed = parseTravelerCount(overrides[field.key], field);
      if (parsed.error) {
        return invalidOverrides(parsed.error, { [field.key]: [parsed.error] });
      }
      if (parsed.value !== null) {
        (draft as unknown as Record<string, unknown>)[field.key] = parsed.value;
        mapping.fields[field.key] = {
          status: "available",
          source: { kind: "flow-default", key: `override:${field.key}` },
        };
        if (!mapping.available.includes(field.key)) {
          mapping.available.push(field.key);
        }
        mapping.missing = mapping.missing.filter((f) => f !== field.key);
        mapping.ambiguous = mapping.ambiguous.filter((a) => a.field !== field.key);
        mapping.invalid = mapping.invalid.filter((v) => v.field !== field.key);
      }
    }
    for (const field of TRAVELER_AGE_FIELDS) {
      const parsed = parseTravelerAges(overrides[field.key], field.label);
      if (parsed.error) {
        return invalidOverrides(parsed.error, { [field.key]: [parsed.error] });
      }
      if (parsed.value !== null) {
        (draft as unknown as Record<string, unknown>)[field.key] = parsed.value;
      }
    }
    mapping.ready = isTravelCrmReady(mapping.fields);

    // --- Flow service defaults are applied after live options
    // --- resolve (below), so only canonicalizable labels count. ---

    // --- Funnel fields (Type/Stage/Received): the dialog shows
    // --- them as editable Workspace-style dropdowns prefilled from
    // --- the SELECTED row. An explicit dialog pick always wins (the
    // --- agent edited it); otherwise the usable STORED row value
    // --- applies. Explicit overrides still apply when the row has
    // --- nothing stored (backward compatibility), then Type/Stage
    // --- identity defaults (Fresh/New Lead), then existing Received
    // --- inference.
    const funnel: Record<(typeof FUNNEL_FIELDS)[number], string | null> = {
      leadSource: asText(overrides.leadSource),
      leadType: asText(overrides.leadType),
      leadStage: asText(overrides.leadStage),
    };

    /**
     * Exact Workspace display value for one business column:
     * stored value → field default → Type/Stage identity defaults
     * (Fresh/New Lead; Received has none). Mirrors what the table
     * renders — never invented, never another field.
     */
    const rowBusinessField = (
      match: (field: { name: string }) => boolean,
    ): { id: string | null; stored: string | null; display: string | null } => {
      const field = loaded.custom.find(
        (f) => typeof f.name === "string" && match({ name: f.name }),
      );
      const stored = asText(field?.value) ?? asText(field?.defaultValue);
      return { id: field?.id ?? null, stored, display: stored };
    };
    const rowType = rowBusinessField(isLeadTypeField);
    const rowStage = rowBusinessField(isStageField);
    const rowReceived = rowBusinessField(isLeadReceivedField);
    // Workspace field ids for the two-way sync (same columns the
    // row values above came from — unknown columns never sync).
    const rowFieldIds: Record<(typeof FUNNEL_FIELDS)[number], string | null> = {
      leadType: rowType.id,
      leadStage: rowStage.id,
      leadSource: rowReceived.id,
    };
    const rowDisplay = {
      leadType: rowType.display ?? LEAD_TYPE_DEFAULT_VALUE,
      leadStage: rowStage.display ?? LEAD_STAGE_DEFAULT_VALUE,
      leadSource: rowReceived.display,
    };
    const rowStored: Record<(typeof FUNNEL_FIELDS)[number], string | null> = {
      leadType: rowType.stored,
      leadStage: rowStage.stored,
      leadSource: rowReceived.stored,
    };
    // --- Option lists for the dialog (best-effort; dialog degrades
    // --- to text inputs, Travel CRM validates authoritatively).
    // --- receivedOptions ALWAYS carries exactly the 12 required
    // --- Received labels, each with the live enum value when the
    // --- live lookups provide a match. Destinations/cities come
    // --- from the SAME upstream lookups payload (never hardcoded).
    let options: Record<string, LookupOption[] | null> | null = null;
    let receivedOptions = buildReceivedOptions(null);
    // Live Type/Stage enums for payload resolution (set alongside
    // options when lookups succeed; the dialog-facing options lists
    // above are canonical Workspace sets, never resolution targets).
    let liveTypeOptions: LookupOption[] | null = null;
    let liveStageOptions: LookupOption[] | null = null;
    let itineraryLookups: {
      destinations: Array<{ value: string; label: string }>;
      cities: Array<{ value: string; label: string; destinationValue: string | null }>;
      citiesByDestination: Record<string, Array<{ value: string; label: string }>>;
    } = { destinations: [], cities: [], citiesByDestination: {} };
    let sendServices = draft.services;
    try {
      // Same owner-email locator as the lookups proxy: scopes the
      // upstream itinerary destination/city feed to the current
      // workspace's linked Travel CRM account, so a shared
      // integration secret can never surface another account's
      // master data here.
      const lookups = await fetchTravelCrmLookups(baseUrl, secret, fetch, {
        ownerEmail,
      });
      const builtItinerary = buildItineraryLookups(lookups);
      itineraryLookups = builtItinerary;
      options = {
        leadSource: extractLookupOptions(lookups, "leadSources"),
        leadType: extractLookupOptions(lookups, "leadTypes"),
        leadStage: extractLookupOptions(lookups, "leadStages"),
        services: extractLookupOptions(lookups, "serviceTypes"),
        destinations: builtItinerary.destinations,
        cities: builtItinerary.cities as unknown as LookupOption[],
      };
      receivedOptions = buildReceivedOptions(options.leadSource);
      // --- Live funnel enums (captured pre-canonical-rebuild):
      // --- payload validation, row canonicalization, and identity
      // --- defaults resolve against THESE — never the canonical
      // --- dialog lists — so unresolvable values stay
      // --- missing/invalid instead of passing as fallback labels.
      liveTypeOptions = options.leadType;
      liveStageOptions = options.leadStage;
      // --- Type/Stage dialog options are the exact canonical
      // --- Workspace label sets (same labels, order, and chips as
      // --- the Workspace columns), each carrying its live Travel
      // --- CRM enum value when the live lookups provide a match.
      // --- Labels with no live match keep the label itself as the
      // --- value (never an invented enum): submitting one rejects
      // --- with INVALID_OVERRIDES naming the live values, and
      // --- Travel CRM validates authoritatively. The dialog submits
      // --- the option values, so the funnel intake, row fill, and
      // --- two-way sync below operate unchanged.
      for (const [target, labels] of [
        ["leadType", LEAD_TYPE_OPTIONS],
        ["leadStage", STAGE_OPTIONS],
      ] as const) {
        const live = target === "leadType" ? liveTypeOptions : liveStageOptions;
        options[target] = labels.map((label) => ({
          value: canonicalizeOptionLabel(label, live) ?? label,
          label,
        }));
      }
      for (const f of FUNNEL_FIELDS) {
        // leadSource validates against the dialog list (live enums
        // + audited fallbacks, as before); Type/Stage validate
        // against live enums only.
        const allowed =
          f === "leadSource"
            ? options[f]?.map((o) => o.value)
            : (f === "leadType" ? liveTypeOptions : liveStageOptions)?.map((o) => o.value);
        const value = funnel[f];
        if (value !== null && allowed && allowed.length > 0 && !allowed.includes(value)) {
          return invalidOverrides(`Invalid ${f} selection.`, {
            [f]: [`Choose one of: ${allowed.join(", ")}.`],
          });
        }
      }
      const serviceAllowed = options.services?.map((o) => o.value);
      const canonicalServices = canonicalizeServices(draft.services, options.services ?? null);
      sendServices = canonicalServices;
      if (serviceAllowed && serviceAllowed.length > 0) {
        const unknown = canonicalServices.filter((s) => !serviceAllowed.includes(s));
        if (unknown.length > 0) {
          return invalidOverrides(`Unknown service: ${unknown.join(", ")}.`, {
            services: [`Choose from: ${serviceAllowed.join(", ")}.`],
          });
        }
      }
    } catch (err) {
      console.error("[travel-crm] lookups fetch failed:", err instanceof Error ? err.message : err);
      options = null;
    }

    // --- Dialog services override (Services checkboxes): the
    // --- agent's explicit per-lead selection, applied straight onto
    // --- the draft (same direct pattern as Name/Phone/travelers) so
    // --- edits never collide with mapped answers or flow defaults
    // --- as false ambiguities. Accepts the dialog's "; "-joined
    // --- string or an array. Empty clears to missing (services are
    // --- required, so creation blocks until at least one is picked).
    // --- Unknown labels reject with the same validation as mapped
    // --- values. Stored Workspace defaults are never modified here.
    if (overrides.services !== undefined) {
      const rawList = Array.isArray(overrides.services)
        ? overrides.services.map((v) => String(v).trim()).filter(Boolean)
        : splitServiceLabels(asText(overrides.services) ?? "");
      if (rawList.length === 0) {
        draft.services = [];
        sendServices = [];
        mapping.fields.services = { status: "missing" };
        if (!mapping.missing.includes("services")) mapping.missing.push("services");
        mapping.available = mapping.available.filter((f) => f !== "services");
      } else {
        const canonical = options
          ? canonicalizeServices(rawList, options.services ?? null)
          : [...rawList];
        const allowed = options?.services?.map((o) => o.value);
        if (allowed && allowed.length > 0) {
          const unknown = canonical.filter((s) => !allowed.includes(s));
          if (unknown.length > 0) {
            return invalidOverrides(`Unknown service: ${unknown.join(", ")}.`, {
              services: [`Choose from: ${allowed.join(", ")}.`],
            });
          }
        }
        draft.services = canonical;
        sendServices = canonical;
        mapping.fields.services = {
          status: "available",
          source: { kind: "flow-default", key: "override:services" },
        };
        if (!mapping.available.includes("services")) mapping.available.push("services");
        mapping.missing = mapping.missing.filter((f) => f !== "services");
        mapping.ambiguous = mapping.ambiguous.filter((a) => a.field !== "services");
        mapping.invalid = mapping.invalid.filter((v) => v.field !== "services");
      }
      mapping.ready = isTravelCrmReady(mapping.fields);
    }

    // --- Workspace row source for Type/Stage/Received (Group 3
    // --- business columns of the selected row). An explicit dialog
    // --- override always wins (the agent edited it); otherwise the
    // --- usable STORED row value applies. Explicit overrides still
    // --- apply when the row has nothing stored (backward
    // --- compatibility), then Type/Stage identity defaults
    // --- (Fresh/New Lead), then existing Received inference. A
    // --- stored row value matching no live option is surfaced as
    // --- invalid (blocked + informative) — never silently
    // --- substituted. The mapper is untouched.
    const rowResolved: Record<(typeof FUNNEL_FIELDS)[number], string | null> = {
      leadSource: null,
      leadType: null,
      leadStage: null,
    };
    for (const f of FUNNEL_FIELDS) {
      const stored = rowStored[f];
      if (stored === null) continue;
      if (!options) {
        rowResolved[f] = stored;
        if (funnel[f] === null) funnel[f] = stored;
        continue;
      }
      // Resolution targets are the live enums (leadSource's dialog
      // list is live-backed; Type/Stage use the hoisted live lists,
      // never the canonical dialog sets).
      const resolveList =
        f === "leadSource" ? options[f] : f === "leadType" ? liveTypeOptions : liveStageOptions;
      const allowed = resolveList?.map((o) => o.value);
      if (!allowed || allowed.length === 0) {
        rowResolved[f] = stored;
        if (funnel[f] === null) funnel[f] = stored;
        continue;
      }
      const resolved = canonicalizeOptionLabel(stored, resolveList);
      if (resolved !== null) {
        rowResolved[f] = resolved;
        if (funnel[f] === null) funnel[f] = resolved;
      } else if (funnel[f] === null) {
        mapping.fields[f] = { status: "invalid", reason: "unknown-option" };
        mapping.invalid.push({ field: f, reason: "unknown-option" });
      }
    }
    if (funnel.leadType === null && !mapping.invalid.some((v) => v.field === "leadType")) {
      const resolved = canonicalizeOptionLabel(
        LEAD_TYPE_DEFAULT_VALUE,
        liveTypeOptions,
      );
      if (resolved !== null) funnel.leadType = resolved;
    }
    if (funnel.leadStage === null && !mapping.invalid.some((v) => v.field === "leadStage")) {
      const resolved = canonicalizeOptionLabel(
        LEAD_STAGE_DEFAULT_VALUE,
        liveStageOptions,
      );
      if (resolved !== null) funnel.leadStage = resolved;
    }

    // --- Resolve inferred Received against live Travel CRM options.
    // --- An explicit user override always wins. An inference that
    // --- matches a live option resolves to its enum value; one that
    // --- doesn't match falls back to missing for manual selection.
    // --- Without live options the inference is kept as-is and
    // --- Travel CRM validates authoritatively on send. ---
    if (funnel.leadSource === null && draft.leadSource !== null) {
      if (options) {
        const canonical = canonicalizeLeadSource(draft.leadSource, options.leadSource);
        if (canonical !== null) {
          funnel.leadSource = canonical;
        } else {
          mapping.fields.leadSource = { status: "missing" };
          mapping.missing = mapping.missing.filter((f) => f !== "leadSource");
          mapping.missing.push("leadSource");
          mapping.available = mapping.available.filter((f) => f !== "leadSource");
          draft.leadSource = null;
        }
      } else {
        funnel.leadSource = draft.leadSource;
      }
    }

    // --- Funnel mapping reconciliation: the mapper always reports
    // --- leadSource/leadType/leadStage as missing (they have no
    // --- WACRM equivalent), but the route resolves them above from
    // --- overrides → Workspace row → Type/Stage identity defaults
    // --- (Fresh/New Lead). Once resolved, the mapping must reflect
    // --- reality: an available field must never stay in missing[]/
    // --- ambiguous[]/invalid[] — otherwise the dialog keeps asking
    // --- for a value the UI already shows and the MISSING_FIELDS
    // --- payload reports a lie. Unresolved ambiguities/invalid
    // --- stored values stay flagged (never silently cleared).
    for (const f of FUNNEL_FIELDS) {
      const value = funnel[f];
      if (value !== null && value !== "") {
        mapping.fields[f] = {
          status: "available",
          source: { kind: "flow-default", key: "funnel-resolved" },
        };
        mapping.missing = mapping.missing.filter((x) => x !== f);
        mapping.ambiguous = mapping.ambiguous.filter((a) => a.field !== f);
        mapping.invalid = mapping.invalid.filter((v) => v.field !== f);
        if (!mapping.available.includes(f)) mapping.available.push(f);
      } else if (
        mapping.fields[f]?.status !== "ambiguous" &&
        mapping.fields[f]?.status !== "invalid"
      ) {
        mapping.fields[f] = { status: "missing" };
        if (!mapping.missing.includes(f)) mapping.missing.push(f);
      }
    }

    // --- Flow service defaults: fill missing services only, after
    // --- live options resolve. Lead data and dialog overrides always
    // --- win (mapping resolved them first); defaults that cannot be
    // --- canonicalized against live options are left missing so the
    // --- dialog asks. No configuration → services stay missing.
    // --- Stored flow configuration is never modified here.
    // --- The same configured labels (read once below) drive the
    // --- dialog Services section, so it shows ONLY the per-flow
    // --- configuration — never the full live catalog.
    const flowServiceLabels = await readFlowServiceLabels(supabase, accountId, flowId);
    if (mapping.fields.services?.status === "missing") {
      if (flowServiceLabels.length > 0) {
        const canonical = options
          ? canonicalizeServices(flowServiceLabels, options.services ?? null)
          : [...flowServiceLabels];
        const allowed = options?.services?.map((o) => o.value);
        if (!allowed || allowed.length === 0 || canonical.every((s) => allowed.includes(s))) {
          draft.services = canonical;
          sendServices = canonical;
          mapping.fields.services = {
            status: "available",
            source: { kind: "flow-default", key: "flow-default" },
          };
          mapping.available.push("services");
          mapping.missing = mapping.missing.filter((f) => f !== "services");
          mapping.ready = isTravelCrmReady(mapping.fields);
        }
      }
    }

    // --- Flow departure defaults: fill missing departure fields
    // --- only, mirroring the service-defaults pattern. Stored
    // --- stable identifiers are applied verbatim; lead data and
    // --- dialog overrides always win (mapping resolved them first).
    // --- No configuration invents nothing (empty stays empty).
    // --- Stored flow configuration is never modified here.
    if (
      mapping.fields.departureCountry?.status === "missing" ||
      mapping.fields.departureCity?.status === "missing"
    ) {
      const flowDeparture = await readFlowDepartureDefaults(supabase, accountId, flowId);
      if (flowDeparture !== null) {
        if (
          mapping.fields.departureCountry?.status === "missing" &&
          flowDeparture.country
        ) {
          draft.departureCountry = flowDeparture.country;
          mapping.fields.departureCountry = {
            status: "available",
            source: { kind: "flow-default", key: "flow-default" },
          };
          mapping.available.push("departureCountry");
          mapping.missing = mapping.missing.filter((f) => f !== "departureCountry");
        }
        if (
          mapping.fields.departureCity?.status === "missing" &&
          flowDeparture.city
        ) {
          draft.departureCity = flowDeparture.city;
          mapping.fields.departureCity = {
            status: "available",
            source: { kind: "flow-default", key: "flow-default" },
          };
          mapping.available.push("departureCity");
          mapping.missing = mapping.missing.filter((f) => f !== "departureCity");
        }
        mapping.ready = isTravelCrmReady(mapping.fields);
      }
    }

    // --- Workspace creation-dialog default: Departure Country = India.
    // --- Applies ONLY when the field is still missing after lead data,
    // --- dialog overrides, and saved per-flow departure defaults all
    // --- resolved to nothing (i.e. a genuinely new entry with no saved
    // --- value). Existing saved values (lead answers, flow defaults,
    // --- explicit overrides) always win and are never overwritten.
    // --- Departure City stays empty for the agent to pick from the
    // --- Indian catalog list. Stored flow configuration is never
    // --- modified here; the value rides the normal draft/prefill path
    // --- so initialization, validation, and submission all see India.
    if (mapping.fields.departureCountry?.status === "missing") {
      draft.departureCountry = DEFAULT_DEPARTURE_COUNTRY;
      mapping.fields.departureCountry = {
        status: "available",
        source: { kind: "flow-default", key: "workspace-default:departureCountry" },
      };
      if (!mapping.available.includes("departureCountry")) {
        mapping.available.push("departureCountry");
      }
      mapping.missing = mapping.missing.filter((f) => f !== "departureCountry");
      mapping.ready = isTravelCrmReady(mapping.fields);
    }

    // --- Dialog itinerary override (multi-row editor): wins over
    // --- both lead data and flow defaults. Validated strictly —
    // --- invalid rows reject with INVALID_OVERRIDES, never stored.
    // --- Editing here never mutates saved Workspace defaults.
    const rawItineraryOverride = overrides.itinerary;
    if (rawItineraryOverride !== undefined) {
      if (!Array.isArray(rawItineraryOverride)) {
        return invalidOverrides("Invalid itinerary.", {
          itinerary: ["Itinerary must be a list."],
        });
      }
      let parsed: Array<{ destination: string; city: string; nights: number }>;
      try {
        parsed = normalizeItineraryDefaults(rawItineraryOverride);
      } catch (err) {
        return invalidOverrides(
          err instanceof Error ? err.message : "Invalid itinerary.",
          { itinerary: [err instanceof Error ? err.message : "Invalid itinerary."] },
        );
      }
      if (parsed.length > 0) {
        draft.itinerary = defaultsToDraftItinerary(parsed);
        mapping.fields.itinerary = {
          status: "available",
          source: { kind: "flow-default", key: "override:itinerary" },
        };
        if (!mapping.available.includes("itinerary")) mapping.available.push("itinerary");
        mapping.missing = mapping.missing.filter((f) => f !== "itinerary");
        mapping.ready = isTravelCrmReady(mapping.fields);
      } else {
        // Explicit empty override clears any mapped/default rows —
        // itinerary stays missing so the dialog keeps asking.
        draft.itinerary = [];
        mapping.fields.itinerary = { status: "missing" };
        if (!mapping.missing.includes("itinerary")) mapping.missing.push("itinerary");
        mapping.available = mapping.available.filter((f) => f !== "itinerary");
        mapping.ready = isTravelCrmReady(mapping.fields);
      }
    }

    // --- Flow itinerary defaults: fill missing itinerary only.
    // --- Lead data and dialog overrides always win (mapping
    // --- resolved them first); no configuration invents nothing
    // --- (empty stays empty). Stored flow configuration is never
    // --- modified here.
    if (mapping.fields.itinerary?.status === "missing") {
      const flowItinerary = await readFlowItineraryDefaults(supabase, accountId, flowId);
      if (flowItinerary.length > 0) {
        draft.itinerary = defaultsToDraftItinerary(flowItinerary);
        mapping.fields.itinerary = {
          status: "available",
          source: { kind: "flow-default", key: "flow-default" },
        };
        mapping.available.push("itinerary");
        mapping.missing = mapping.missing.filter((f) => f !== "itinerary");
        mapping.ready = isTravelCrmReady(mapping.fields);
      }
    }

    const funnelComplete = FUNNEL_FIELDS.every((f) => funnel[f] !== null);
    const canCreate =
      mapping.ready && overrideIssue === null && funnelComplete;

    /**
     * Dialog value for one funnel field: the exact value the
     * Workspace row displays (stored → field default → Type/Stage
     * identity defaults; Received additionally falls back to the
     * override-aware mapper inference), resolved against the
     * DIALOG option list — never gated on live-enum resolution, so
     * the selects open prefilled even when live lookups are
     * unreachable or lack a match. The payload funnel above is
     * untouched: Travel CRM still receives live enums only, and
     * Travel CRM validates authoritatively on send.
     */
    const dialogFunnelValue = (
      list: LookupOption[] | null,
      ...candidates: Array<string | null>
    ): string | null => {
      const first = candidates.find((c) => c !== null) ?? null;
      // No option list (lookups unreachable): the dialog renders
      // the canonical label fallbacks (value = label), so the
      // row-display label itself is the matching value.
      if (!list || list.length === 0) return first;
      for (const candidate of candidates) {
        if (candidate === null) continue;
        const resolved = canonicalizeOptionLabel(candidate, list);
        if (resolved !== null) return resolved;
      }
      return null;
    };

    const prefill = {
      customerName: draft.customerName,
      phone: draft.phone,
      email: draft.email,
      travelStartDate: draft.travelStartDate,
      destination: draft.itinerary[0]?.country ?? null,
      city: draft.itinerary[0]?.destination ?? null,
      nights: draft.itinerary[0]?.nights ?? null,
      itinerary: draft.itinerary.map((row) => ({
        destination: row.country ?? "",
        city: row.destination ?? "",
        nights: row.nights ?? 0,
      })),
      adults: draft.adults,
      childrenWithBed: draft.childrenWithBed,
      childrenWithoutBed: draft.childrenWithoutBed,
      infants: draft.infants,
      childrenWithBedAges: draft.childrenWithBedAges,
      childrenWithoutBedAges: draft.childrenWithoutBedAges,
      infantAges: draft.infantAges,
      departureCountry: draft.departureCountry,
      departureCity: draft.departureCity,
      services: draft.services,
      rooms: draft.rooms,
      assignedToEmail: overrideEmail,
      // Dialog-prefilled funnel values: the row-display chain
      // above, resolved to dialog option values (NOT the payload
      // funnel — that stays live-enum-only). Empty stays empty;
      // Type/Stage fall back to Fresh/New Lead via rowDisplay.
      leadSource: dialogFunnelValue(
        receivedOptions,
        rowDisplay.leadSource,
        draft.leadSource,
        funnel.leadSource,
      ),
      leadType: dialogFunnelValue(
        options?.leadType ?? null,
        rowDisplay.leadType,
        funnel.leadType,
      ),
      leadStage: dialogFunnelValue(
        options?.leadStage ?? null,
        rowDisplay.leadStage,
        funnel.leadStage,
      ),
      // Exact Workspace row display values for the read-only dialog
      // block (stored → field default → Type/Stage identity
      // defaults; Received has none). Empty stays empty here even
      // when the payload enums above resolved otherwise.
      rowLeadSource: rowDisplay.leadSource,
      rowLeadType: rowDisplay.leadType,
      rowLeadStage: rowDisplay.leadStage,
    };

    // Dialog Services section shows ONLY the flow-configured labels
    // (preselected exactly as in Settings). The creation payload
    // still uses draft.services (canonical enums) — only the
    // dialog-facing prefill carries labels. Without configuration
    // the draft value stands (lead data or empty).
    if (flowServiceLabels.length > 0) {
      prefill.services = [...flowServiceLabels];
    }

    if (!canCreate) {
      return NextResponse.json({
        success: false,
        code: "MISSING_FIELDS",
        mapping: {
          available: mapping.available,
          missing: mapping.missing,
          ambiguous: mapping.ambiguous,
          invalid: mapping.invalid,
          ready: mapping.ready,
        },
        prefill,
        options,
        receivedOptions,
        destinations: itineraryLookups.destinations,
        cities: itineraryLookups.cities,
        citiesByDestination: itineraryLookups.citiesByDestination,
        // Per-flow service configuration for the dialog Services
        // section: exactly these labels render as checkboxes ([] when
        // unconfigured — never the full live catalog).
        configuredServices: [...flowServiceLabels],
        assignedOwnerEmail: overrideEmail,
        assignmentIssue: overrideIssue,
        link: await safeLinkState(supabase, accountId, runId),
      });
    }

    // --- Create: claim pending link, call, flip to created. ---
    try {
      await ensurePendingLink(supabase, accountId, runId, userId);
    } catch (err) {
      console.error("[travel-crm] link upsert failed:", err);
    }
    let result;
    try {
      result = await createTravelCrmLead(baseUrl, secret, {
        wacrmAccountId: accountId,
        flowRunId: runId,
        customerName: draft.customerName as string,
        phone: draft.phone as string,
        email: draft.email,
        leadSource: funnel.leadSource as string,
        leadType: funnel.leadType as string,
        leadStage: funnel.leadStage as string,
        assignedToEmail: overrideEmail as string,
        dateOfBirth: draft.dateOfBirth,
        travelStartDate: draft.travelStartDate,
        departureCountry: draft.departureCountry,
        departureCity: draft.departureCity,
        rooms: draft.rooms,
        adults: draft.adults,
        childrenWithBed: draft.childrenWithBed,
        childrenWithoutBed: draft.childrenWithoutBed,
        infants: draft.infants,
        childrenWithBedAges: draft.childrenWithBedAges,
        childrenWithoutBedAges: draft.childrenWithoutBedAges,
        infantAges: draft.infantAges,
        services: sendServices,
        itinerary: resolveItineraryForSend(draft.itinerary, itineraryLookups),
      });
    } catch (err) {
      await markLinkFailed(supabase, accountId, runId, err);
      if (err instanceof TravelCrmError) {
        return NextResponse.json(
          {
            success: false,
            code: err.code,
            error: err.message,
            fields: err.fields ?? {},
          },
          { status: err.code === "TRAVEL_CRM_UNAUTHORIZED" ? 401 : err.code === "TRAVEL_CRM_UNAVAILABLE" ? 502 : 400 },
        );
      }
      return NextResponse.json(
        { success: false, code: "TRAVEL_CRM_ERROR", error: "Travel CRM request failed." },
        { status: 502 },
      );
    }

    // A retried key that Travel CRM deduplicated server-side still
    // yields the real ID — adopt it, never invent one.
    if (!result.leadId) {
      await markLinkFailed(supabase, accountId, runId, "empty lead id");
      return NextResponse.json(
        { success: false, code: "TRAVEL_CRM_ERROR", error: "Travel CRM returned no lead ID." },
        { status: 502 },
      );
    }
    try {
      const { error } = await supabase
        .from("travel_crm_lead_links")
        .update({ status: "created", external_lead_id: result.leadId, last_error: null })
        .eq("account_id", accountId)
        .eq("flow_run_id", runId)
        .eq("integration_type", "travel-crm");
      if (error) throw error;
    } catch (err) {
      console.error("[travel-crm] link finalize failed:", err);
    }

    // --- Workspace two-way sync (dialog edits → selected row) ---
    // Runs ONLY here, after a successful create with a real lead
    // ID — never before, never on failure. Reuses the existing
    // stores with their exact semantics (no new tables/fields):
    //   Received/Type/Stage → workspace_values upsert, scoped by
    //     account + flow + run + the column's own field id (same
    //     shape as the CustomCell PUT; unknown columns are never
    //     created);
    //   flow-answer Name     → workspace_flow_overrides upsert keyed
    //     by the exact flow column key (flow-overrides PUT parity);
    //   contact fallback Name + Phone → contacts row update scoped
    //     by id + account (phone stays canonical; phone_normalized
    //     follows via its generated column).
    // Only values that differ from the row source are written, so
    // untouched fields cause zero writes. A sync failure never
    // fails the created lead — it is reported in
    // workspaceSync.failed for the dialog to surface + retry.
    const workspaceSync: {
      updated: string[];
      failed: Array<{ field: string; error: string }>;
      rowPatch: {
        answers: Record<string, string | null>;
        name: string | null;
        phone: string | null;
        customValues: Record<string, string | null>;
      };
    } = {
      updated: [],
      failed: [],
      rowPatch: { answers: {}, name: null, phone: null, customValues: {} },
    };
    const failSync = (field: string, err: unknown) => {
      workspaceSync.failed.push({
        field,
        error: err instanceof Error ? err.message : "Workspace sync failed.",
      });
    };
    const labelForFunnelEnum = (
      f: (typeof FUNNEL_FIELDS)[number],
      enumValue: string,
    ): string => {
      const list =
        f === "leadSource"
          ? (receivedOptions && receivedOptions.length > 0
              ? receivedOptions
              : (options?.leadSource ?? null))
          : (options?.[f] ?? null);
      return list?.find((o) => o.value === enumValue)?.label ?? enumValue;
    };
    for (const f of FUNNEL_FIELDS) {
      const dialogEnum = asText(overrides[f]);
      if (dialogEnum === null) continue;
      if (dialogEnum === rowResolved[f]) continue;
      const fieldId = rowFieldIds[f];
      if (fieldId === null) continue;
      const label = labelForFunnelEnum(f, dialogEnum);
      try {
        const { error } = await supabase
          .from("workspace_values")
          .upsert(
            {
              account_id: accountId,
              field_id: fieldId,
              flow_run_id: runId,
              value_text: label,
            },
            { onConflict: "field_id,flow_run_id" },
          );
        if (error) throw error;
        workspaceSync.updated.push(f);
        // Custom-field cells render from customValues — carry the
        // field id + label so the table and drawer repaint instantly.
        workspaceSync.rowPatch.customValues[fieldId] = label;
      } catch (err) {
        failSync(f, err);
      }
    }
    {
      const dialogName = asText(overrides.customerName);
      if (dialogName !== null && dialogName !== initialCustomerName) {
        if (loaded.flowNameColumnKey) {
          try {
            const { error } = await supabase
              .from("workspace_flow_overrides")
              .upsert(
                {
                  account_id: accountId,
                  flow_id: flowId,
                  flow_run_id: runId,
                  field_key: loaded.flowNameColumnKey,
                  value_text: dialogName,
                },
                { onConflict: "account_id,flow_id,flow_run_id,field_key" },
              );
            if (error) throw error;
            workspaceSync.updated.push("customerName");
            workspaceSync.rowPatch.answers[loaded.flowNameColumnKey] = dialogName;
          } catch (err) {
            failSync("customerName", err);
          }
        } else if (loaded.contactId) {
          try {
            const { error } = await supabase
              .from("contacts")
              .update({ name: dialogName })
              .eq("id", loaded.contactId)
              .eq("account_id", accountId);
            if (error) throw error;
            workspaceSync.updated.push("customerName");
            workspaceSync.rowPatch.name = dialogName;
          } catch (err) {
            failSync("customerName", err);
          }
        }
      }
      // Phone syncs from the payload-canonical draft value (the
      // exact number Travel CRM received, "+"-form like contacts
      // already store) — never the raw override text.
      const dialogPhoneRaw = asText(overrides.phone);
      if (dialogPhoneRaw !== null && draft.phone && loaded.contactId) {
        if (normalizePhone(draft.phone) !== normalizePhone(initialPhone ?? "")) {
          try {
            const { error } = await supabase
              .from("contacts")
              .update({ phone: draft.phone })
              .eq("id", loaded.contactId)
              .eq("account_id", accountId);
            if (error) throw error;
            workspaceSync.updated.push("phone");
            workspaceSync.rowPatch.phone = draft.phone;
          } catch (err) {
            failSync("phone", err);
          }
        }
      }
    }
    return NextResponse.json({
      success: true,
      code: "CREATED",
      leadId: result.leadId,
      leadUrl: travelCrmLeadUrl(baseUrl, result.leadId),
      alreadyExists: result.alreadyExists,
      workspaceSync,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function safeLinkState(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
): Promise<{ status: string; externalLeadId: string | null } | null> {
  try {
    const row = await readLink(supabase, accountId, runId);
    if (!row) return null;
    return { status: row.status, externalLeadId: row.external_lead_id };
  } catch (err) {
    console.error("[travel-crm] link read failed:", err);
    return null;
  }
}

async function ensurePendingLink(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.from("travel_crm_lead_links").insert({
    account_id: accountId,
    flow_run_id: runId,
    integration_type: "travel-crm",
    status: "pending",
    created_by: userId,
  });
  if (error && !isUniqueViolation(error)) throw error;
}

async function markLinkFailed(
  supabase: SupabaseClient,
  accountId: string,
  runId: string,
  err: unknown,
): Promise<void> {
  try {
    const message =
      err instanceof TravelCrmError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Travel CRM request failed.";
    await supabase
      .from("travel_crm_lead_links")
      .update({ status: "failed", last_error: message.slice(0, 1000) })
      .eq("account_id", accountId)
      .eq("flow_run_id", runId)
      .eq("integration_type", "travel-crm");
  } catch (nested) {
    console.error("[travel-crm] link failure-mark failed:", nested);
  }
}
