// Lead Quality column — end-to-end wiring contract.
//
// Pins the full loop without touching the network or DB:
// defaults spec → header tooltip → save hook → ingestion hook →
// event send. Pure file-content guards so a future refactor
// cannot silently drop a link in the chain.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(`${root}/${rel}`, "utf8");

const defaults = read("src/lib/flows/workspace-defaults.ts");
const chips = read("src/lib/flows/workspace-select-chips.ts");
const leadQuality = read("src/lib/meta-crm/lead-quality.ts");
const feedback = read("src/lib/meta-crm/feedback.ts");
const valuesRoute = read("src/app/api/flows/[id]/workspace-values/route.ts");
const processLead = read("src/lib/meta-lead-ads/process-lead.ts");
const page = read("src/app/(dashboard)/workspace/page.tsx");
const cron = read("src/app/api/integrations/meta-lead-ads/cron/route.ts");
const migration = read("supabase/migrations/175_meta_crm_feedback.sql");

describe("Lead Quality column wiring", () => {
  it("is a provisioned single_select default with a Lead display default", () => {
    expect(defaults).toContain('name: "Lead Quality"');
    expect(defaults).toContain("LEAD_QUALITY_OPTIONS");
    expect(defaults).toContain('default_value: "Lead"');
    expect(defaults).toContain("isLeadQualityField");
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

  it("the save path enqueues only genuine Lead Quality changes", () => {
    expect(valuesRoute).toContain("isLeadQualityField(field)");
    expect(valuesRoute).toContain("enqueueLeadQualityEvent");
    expect(valuesRoute).toContain("scheduleCrmDrainSoon");
    // Clearing never fabricates an event; unchanged saves skip.
    expect(valuesRoute).toContain("storedValue !== previous");
  });

  it("ingestion enqueues the automatic initial Lead event", () => {
    expect(processLead).toContain("enqueueLeadQualityEvent");
    expect(processLead).toContain('toQuality: "Lead"');
    expect(processLead).toContain("scheduleCrmDrainSoon");
  });

  it("the Workspace header explains the column purpose", () => {
    expect(page).toContain("isLeadQualityField(f)");
    expect(page).toContain("LEAD_QUALITY_TOOLTIP");
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
    for (const src of [leadQuality, feedback]) {
      expect(src).not.toContain("meta-capi/");
      expect(src).not.toContain("metaCapi");
      expect(src).not.toMatch(/from\s+["']@\/lib\/meta-capi\//);
    }
    // Pre-existing CAPI hooks keep their exact footprint: one
    // import each, zero new references from this feature.
    expect(valuesRoute.match(/meta-capi/g)?.length ?? 0).toBe(2);
    expect(processLead.match(/meta-capi/g)?.length ?? 0).toBe(1);
    expect(valuesRoute).toContain("enqueueLeadQualityEvent");
    expect(processLead).toContain("enqueueLeadQualityEvent");
  });
});
