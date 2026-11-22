// Lead Quality column — manual-send wiring contract.
//
// Pins the full loop without touching the network or DB:
// defaults spec → header tooltip → save path stores only → shared
// preview assembly → explicit send endpoint → event send. Pure
// file-content guards so a future refactor cannot silently
// reintroduce auto-send or invent payload data.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(`${root}/${rel}`, "utf8");

const defaults = read("src/lib/flows/workspace-defaults.ts");
const chips = read("src/lib/flows/workspace-select-chips.ts");
const leadQuality = read("src/lib/meta-crm/lead-quality.ts");
const matching = read("src/lib/meta-crm/matching.ts");
const preview = read("src/lib/meta-crm/preview.ts");
const feedback = read("src/lib/meta-crm/feedback.ts");
const valuesRoute = read("src/app/api/flows/[id]/workspace-values/route.ts");
const previewRoute = read("src/app/api/integrations/meta-crm/preview/route.ts");
const sendRoute = read("src/app/api/integrations/meta-crm/manual-send/route.ts");
const configRoute = read("src/app/api/integrations/meta-crm/config/route.ts");
const processLead = read("src/lib/meta-lead-ads/process-lead.ts");
const page = read("src/app/(dashboard)/workspace/page.tsx");
const component = read("src/components/workspace/meta-crm-send-section.tsx");
const customCell = read("src/components/workspace/custom-cell.tsx");
const cron = read("src/app/api/integrations/meta-lead-ads/cron/route.ts");
const migration = read("supabase/migrations/175_meta_crm_feedback.sql");

describe("Lead Quality column wiring", () => {
  it("is a provisioned single_select default with a Lead display default", () => {
    expect(defaults).toContain('name: "Lead Quality"');
    expect(defaults).toContain("LEAD_QUALITY_OPTIONS");
    expect(defaults).toContain('default_value: "Lead"');
    expect(defaults).toContain("isLeadQualityField");
  });

  it("offers Lead as an explicit option (new specs and legacy columns)", () => {
    expect(defaults).toContain('"Lead",');
    expect(leadQuality).toContain('"Lead",');
    // Legacy four-option columns gain Lead at render + validation
    // time (no migration, no option rewrite).
    expect(customCell).toContain("LEAD_QUALITY_DEFAULT_VALUE");
    expect(valuesRoute).toContain("allowLeadDefault");
  });

  it("paints status chips without touching legacy Hot/Warm/Cold/Fake", () => {
    expect(chips).toContain('"lead quality"');
    expect(chips).toContain('"disqualified lead"');
    expect(chips).toContain("hot:");
  });

  it("maps the five CRM events and never invents others", () => {
    expect(leadQuality).toContain('"Lead"');
    expect(leadQuality).toContain('"BookingConfirmed"');
    expect(leadQuality).toContain('"DisqualifiedLead"');
    expect(leadQuality).toContain("system_generated");
    expect(leadQuality).toContain("user_data");
  });

  it("the save path NEVER enqueues — it stores the status only", () => {
    expect(valuesRoute).toContain("isLeadQualityField(field)");
    expect(valuesRoute).not.toContain("enqueueLeadQualityEvent");
    expect(valuesRoute).not.toContain("scheduleCrmDrainSoon");
    // Clearing and unchanged saves also stay send-free.
    expect(valuesRoute).toContain("crmEvent: null");
  });

  it("ingestion NEVER enqueues — capture stays event-free", () => {
    expect(processLead).not.toContain("enqueueLeadQualityEvent");
    expect(processLead).not.toContain("scheduleCrmDrainSoon");
    expect(processLead).not.toContain('toQuality: "Lead"');
  });

  it("the preview comes from the shared builder, never invented data", () => {
    expect(preview).toContain("assembleLeadQualityPreview");
    expect(preview).toContain("buildCrmEventPayload");
    expect(preview).toContain("buildCrmRequestBody");
    expect(preview).toContain("buildLeadQualityPreviewId");
    expect(preview).toContain("resolveLeadMatchHashes");
    expect(previewRoute).toContain("assembleLeadQualityPreview");
  });

  it("only the explicit send endpoint enqueues, with stale-preview protection", () => {
    expect(sendRoute).toContain("enqueueLeadQualityEvent");
    expect(sendRoute).toContain("scheduleCrmDrainSoon");
    expect(sendRoute).toContain("stale_preview");
    expect(sendRoute).toContain('requireRole("agent")');
    // The delivered timestamp is the occurrence, never the click time.
    expect(sendRoute).toContain("occurrenceTimeIso");
  });

  it("CRM Feedback never touches the Meta Lead Ads connection token", () => {
    // Genuine backend separation: no import, no call, no fallback —
    // verification, preview gating, and delivery all resolve the
    // dedicated encrypted CRM credential instead.
    expect(feedback).not.toContain("getUserToken");
    expect(feedback).toContain("getCrmAccessToken");
    expect(feedback).toContain("meta_crm_config");
    expect(preview).toContain("no_token");
    expect(preview).toContain("getCrmAccessToken");
  });

  it("a missing token migration fails loudly, never as a bare 500", () => {
    // Regression for the deployed "Internal server error" toast:
    // when migration 176 is absent, PostgREST rejects with a plain
    // 42703 object — routes must map it to an actionable message.
    expect(feedback).toContain("isMissingAccessTokenColumn");
    expect(feedback).toContain("176_meta_crm_dedicated_token");
    expect(configRoute).toContain("migration_missing");
    expect(configRoute).toContain("tokenMigrationMissing");
  });

  it("the payload honors the documented CRM wire format", () => {
    // `data` wrapper, numeric-when-safe lead_id, hashed matching,
    // system_generated + crm event_source. No `event_id` is ever
    // emitted to Meta — dedup stays application-side (ledger).
    expect(leadQuality).toContain("buildCrmRequestBody");
    expect(leadQuality).toContain("serializeCrmRequestBody");
    expect(leadQuality).toContain("validateMetaLeadId");
    expect(leadQuality).toContain("isSafeJsonInteger");
    expect(leadQuality).toContain("CrmRequestBody");
    expect(leadQuality).toContain("data: [event]");
    expect(leadQuality).not.toContain("JSON.stringify({ data: [args.payload] })");
    expect(leadQuality).not.toContain("event_id: args.eventUuid");
    // Raw contact data never reaches the builder — hashes only.
    expect(matching).toContain("sha256Hex");
    expect(matching).toContain("normalizeEmailForMeta");
    expect(matching).toContain("normalizePhoneForMeta");
    // Invalid identifiers are rejected, never coerced or substituted.
    expect(leadQuality).toContain("invalid_input");
    expect(feedback).toContain("invalid_input");
  });

  it("occurrence timestamps come from stored history, never the send moment", () => {
    expect(preview).toContain("occurrenceTimeIso");
    expect(preview).toContain("updated_at");
    expect(preview).toContain("meta_created_time");
    expect(preview).toContain("invalid_timestamp");
    // Retries reuse the stored occurrence — the drain never refreshes it.
    expect(feedback).toContain("eventTimeIso: row.event_time");
    expect(feedback).toContain("invalid_input");
  });

  it("the drawer shows the preview with an explicit Send button", () => {
    expect(page).toContain("MetaCrmSendSection");
    expect(component).toContain("Send to Meta");
    expect(component).toContain("/api/integrations/meta-crm/preview");
    expect(component).toContain("/api/integrations/meta-crm/manual-send");
    // Full outgoing body, occurrence + send times, warnings, copy.
    expect(component).toContain("requestBody");
    expect(component).toContain("Event time");
    expect(component).toContain("Sent at");
    expect(component).toContain("Copy Payload");
    expect(component).toContain("Refresh Status");
    // Queued is never shown as Sent.
    expect(component).toContain('"queued"');
    // Saving a status opens the drawer on the edited lead.
    expect(page).toContain("setCrmPreviewBump");
  });

  it("the Workspace header explains the manual purpose", () => {
    expect(page).toContain("isLeadQualityField(f)");
    expect(page).toContain("LEAD_QUALITY_TOOLTIP");
    expect(leadQuality).toContain("never sends");
  });

  it("the existing cron sweep drains CRM events additively", () => {
    expect(cron).toContain("drainCrmEventsQueue");
    expect(cron).toContain("crmFeedback");
  });

  it("the migration stores only non-secret metadata with tenant RLS", () => {
    expect(migration).toContain("meta_crm_config");
    expect(migration).toContain("meta_crm_events");
    expect(migration).toContain("is_account_member(account_id");
    expect(migration).not.toContain("access_token");
  });

  it("retired CAPI stays untouched", () => {
    // New modules import/use no CAPI code at all (comments may
    // name it only to declare independence).
    for (const src of [leadQuality, preview, feedback]) {
      expect(src).not.toContain("meta-capi/");
      expect(src).not.toContain("metaCapi");
      expect(src).not.toMatch(/from\s+["']@\/lib\/meta-capi\//);
    }
    // Pre-existing CAPI hooks keep their exact footprint: one
    // import each, zero new references from this feature.
    expect(valuesRoute.match(/meta-capi/g)?.length ?? 0).toBe(2);
    expect(processLead.match(/meta-capi/g)?.length ?? 0).toBe(1);
    expect(valuesRoute).not.toContain("enqueueLeadQualityEvent");
    expect(processLead).not.toContain("enqueueLeadQualityEvent");
  });
});
