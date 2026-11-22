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
const preview = read("src/lib/meta-crm/preview.ts");
const feedback = read("src/lib/meta-crm/feedback.ts");
const valuesRoute = read("src/app/api/flows/[id]/workspace-values/route.ts");
const previewRoute = read("src/app/api/integrations/meta-crm/preview/route.ts");
const sendRoute = read("src/app/api/integrations/meta-crm/manual-send/route.ts");
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
    expect(preview).toContain("buildLeadQualityPreviewId");
    expect(previewRoute).toContain("assembleLeadQualityPreview");
  });

  it("only the explicit send endpoint enqueues, with stale-preview protection", () => {
    expect(sendRoute).toContain("enqueueLeadQualityEvent");
    expect(sendRoute).toContain("scheduleCrmDrainSoon");
    expect(sendRoute).toContain("stale_preview");
    expect(sendRoute).toContain('requireRole("agent")');
  });

  it("the drawer shows the preview with an explicit Send button", () => {
    expect(page).toContain("MetaCrmSendSection");
    expect(component).toContain("Send to Meta");
    expect(component).toContain("/api/integrations/meta-crm/preview");
    expect(component).toContain("/api/integrations/meta-crm/manual-send");
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
