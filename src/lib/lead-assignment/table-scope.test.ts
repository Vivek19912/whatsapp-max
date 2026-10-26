// Per-table assignment scope protection — the feature must not
// leak into Google Sheets synchronization or the Travel CRM.
//
// Flow Tables receive assignment, but the Flow runtime
// (flows/engine.ts → lead-assignment/table-assignment.ts) must
// never import the Meta Sheets sync system: no functions, no
// state, no side effects. Likewise nothing here touches
// travel-crm modules or tables.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("per-table assignment — Flow runtime stays Sheets-free", () => {
  it("flows/engine.ts never imports the Meta Sheets sync system", () => {
    const s = src("src/lib/flows/engine.ts");
    expect(s).not.toContain("meta-lead-sheets");
    expect(s).not.toContain("meta_lead_sheets");
    expect(s).not.toContain("META_SHEETS");
    expect(s).not.toContain("drainSheetsQueue");
    expect(s).not.toContain("maybeEnqueueSheetsSync");
  });

  for (const file of [
    "src/lib/lead-assignment/table-assignment.ts",
    "src/lib/lead-assignment/table-config.ts",
    "src/lib/lead-assignment/table-helpers.ts",
    "src/lib/lead-assignment/table-notify.ts",
    "src/lib/lead-assignment/table-validation.ts",
  ]) {
    it(`${file} never imports the Sheets sync or Travel CRM systems`, () => {
      const s = src(file);
      expect(s).not.toContain("meta-lead-sheets");
      expect(s).not.toContain("meta_lead_sheets");
      expect(s).not.toContain("travel-crm");
      expect(s).not.toContain("travel_crm");
    });
  }

  for (const file of [
    "src/app/api/flows/[id]/assignment/route.ts",
    "src/app/api/flows/[id]/assignment/pause/route.ts",
    "src/app/api/flows/[id]/assignment/retry/route.ts",
    "src/app/api/flows/[id]/assignment/notifications/route.ts",
  ]) {
    it(`${file} never imports the Sheets sync or Travel CRM systems`, () => {
      const s = src(file);
      expect(s).not.toContain("meta-lead-sheets");
      expect(s).not.toContain("meta_lead_sheets");
      expect(s).not.toContain("travel-crm");
      expect(s).not.toContain("travel_crm");
    });
  }
});

describe("per-table assignment — legacy behavior preserved", () => {
  it("Meta ingestion keeps the legacy global-rule fallback", () => {
    const s = src("src/lib/meta-lead-ads/process-lead.ts");
    expect(s).toContain("maybeAutoAssignTableLead");
    // Per-table first, legacy global rules when the table has none.
    expect(s).toContain("maybeAutoAssignLead");
    expect(s).toContain("notifyHandled");
  });

  it("the global rules API and panel are untouched", () => {
    for (const file of [
      "src/lib/lead-assignment/rules.ts",
      "src/lib/lead-assignment/validation.ts",
      "src/lib/lead-assignment/algorithms.ts",
      "src/app/api/lead-assignment/rules/route.ts",
    ]) {
      const s = src(file);
      expect(s).not.toContain("table-helpers");
      expect(s).not.toContain("lead_assignment_table_configs");
    }
    // service.ts only re-exports the shared helpers (same
    // behavior, Sheets import untouched, no new tables referenced).
    const service = src("src/lib/lead-assignment/service.ts");
    expect(service).toContain("maybeEnqueueSheetsSync");
    expect(service).toContain('from "./table-helpers"');
    expect(service).not.toContain("lead_assignment_table_configs");
  });

  it("migration 138 is additive: no legacy tables altered, no data deleted", () => {
    const s = src("supabase/migrations/138_lead_assignment_per_table.sql");
    expect(s).toContain("lead_assignment_table_configs");
    expect(s).toContain("lead_assignment_table_assignees");
    expect(s).toContain("lead_assignment_table_config_state");
    expect(s).toContain("lead_assignment_notifications");
    expect(s).not.toContain("DROP TABLE");
    expect(s).not.toContain("DELETE FROM");
    expect(s).not.toContain("ALTER TABLE public.flows");
    expect(s).not.toContain("ALTER TABLE public.flow_runs");
    expect(s).not.toContain("ALTER TABLE public.workspace_values");
    expect(s).not.toContain("ALTER TABLE public.lead_assignment_rules");
    expect(s).not.toContain("ALTER TABLE public.meta_lead_forms");
    // The migration-127 legacy state table (rule_id + form_id)
    // must not be redefined or touched here: 138 previously
    // declared CREATE TABLE lead_assignment_table_state, which
    // IF NOT EXISTS silently skipped (the legacy table already
    // exists) while the RLS policy referenced a config_id column
    // that was never created — ERROR 42703. The per-table engine
    // uses its own distinctly named table instead.
    expect(s).not.toContain("CREATE TABLE IF NOT EXISTS public.lead_assignment_table_state");
    expect(s).not.toContain("ALTER TABLE public.lead_assignment_table_state");
    expect(s).not.toContain("ON public.lead_assignment_table_state");
  });

  it("the legacy state table keeps its (rule_id, form_id) shape", () => {
    const legacy = src("supabase/migrations/127_lead_assignment.sql");
    expect(legacy).toContain("CREATE TABLE IF NOT EXISTS public.lead_assignment_table_state");
    expect(legacy).toContain("rule_id UUID NOT NULL");
    expect(legacy).toContain("form_id UUID NOT NULL");
    expect(legacy).not.toContain("config_id");
    // The legacy engine still keys state by (rule_id, form_id);
    // the per-table engine keys its own table by config_id.
    const legacy127 = src("supabase/migrations/127_lead_assignment.sql");
    expect(legacy127).toContain("UNIQUE (rule_id, form_id)");
    const service = src("src/lib/lead-assignment/service.ts");
    expect(service).toContain('from("lead_assignment_table_state")');
    expect(service).not.toContain("lead_assignment_table_config_state");
    const engine = src("src/lib/lead-assignment/table-assignment.ts");
    expect(engine).toContain("lead_assignment_table_config_state");
    expect(engine).not.toContain('from("lead_assignment_table_state")');
    const config = src("src/lib/lead-assignment/table-config.ts");
    expect(config).toContain("lead_assignment_table_config_state");
    expect(config).not.toContain('from("lead_assignment_table_state")');
  });
});

describe("per-table assignment — Travel CRM untouched", () => {
  it("no assignment file references travel-crm settings or leads", () => {
    for (const file of [
      "src/lib/lead-assignment/table-assignment.ts",
      "src/lib/lead-assignment/table-config.ts",
      "src/lib/lead-assignment/table-notify.ts",
      "src/components/workspace/table-assignment-dialog.tsx",
    ]) {
      const s = src(file);
      expect(s).not.toContain("travel-crm");
      expect(s).not.toContain("TravelCrm");
    }
  });
});
