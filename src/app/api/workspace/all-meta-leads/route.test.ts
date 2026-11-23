import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const routeSrc = () =>
  readFileSync(`${root}/src/app/api/workspace/all-meta-leads/route.ts`, "utf8");
const rpcSrc = () =>
  readFileSync(`${root}/supabase/migrations/179_all_meta_leads.sql`, "utf8");
const pageSrc = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const viewSrc = () =>
  readFileSync(`${root}/src/components/workspace/all-meta-leads-view.tsx`, "utf8");

describe("all-meta-leads — backend canonical source + dedup", () => {
  it("uses meta_lead_submissions as canonical source joined to authoritative flow_runs", () => {
    const s = routeSrc();
    expect(s).toContain("get_all_meta_leads");
    expect(s).toContain("meta_lead_submissions");
    // Identity is account_id + meta_lead_id (RPC DISTINCT ON).
    expect(rpcSrc()).toContain("DISTINCT ON (s.meta_lead_id)");
  });

  it("displays only processed leads with a live run (no failed/ignored, no NULL/deleted runs)", () => {
    const rpc = rpcSrc();
    expect(rpc).toContain("s.status = 'processed'");
    // INNER JOIN excludes NULL/deleted flow_run_id (SET NULL on delete).
    expect(rpc).toContain("JOIN flow_runs");
    expect(rpc).not.toContain("LEFT JOIN flow_runs");
  });

  it("includes hidden + disabled forms (no hidden/enabled filtering)", () => {
    const s = routeSrc();
    // Backend fetches ALL Meta flows — never filters by hidden tables.
    expect(s).toContain("meta_lead_ads");
    expect(s).toContain('.eq("kind", "meta_lead_ads")');
    expect(s).not.toContain("workspace_hidden_tables");
    expect(s).not.toContain("hiddenTableIds");
    // No enabled=true gating (enabled is only returned for display).
    expect(s).not.toContain('.eq("enabled", true)');
    // RPC has no hidden-tables predicate and no enabled gating either
    // (comments mention hidden/disabled by design — check code, not prose).
    expect(rpcSrc()).not.toContain("workspace_hidden_tables");
    expect(rpcSrc()).not.toMatch(/WHERE[^;]*enabled\s*=\s*true/i);
  });

  it("keeps dummy test leads visible (no dashboard dummy exclusion)", () => {
    expect(routeSrc()).not.toContain("is_meta_dummy_phone_lead");
    expect(rpcSrc()).not.toContain("is_meta_dummy_phone_lead");
  });

  it("retains originating flowId + runId on every row (actions use the original)", () => {
    const s = routeSrc();
    expect(s).toContain("runId: r.run_id");
    expect(s).toContain("flowId: r.flow_id");
    // Page passes originating flowId to follow-up, assign, Travel CRM, CRM send.
    const p = pageSrc();
    expect(p).toContain("originFlowId");
    expect(p).toContain("manualAssignMetaLead");
  });

  it("enforces account isolation + agent View All grants server-side", () => {
    const s = routeSrc();
    expect(s).toContain("getCurrentAccount");
    expect(s).toContain("resolveWorkspaceVisibility");
    expect(s).toContain("account_id");
    expect(rpcSrc()).toContain("SECURITY INVOKER");
    expect(rpcSrc()).toContain("auth.uid()");
  });

  it("avoids N+1 with batched queries for fields, values, media, recordings", () => {
    const s = routeSrc();
    expect(s).toContain(".in(\"flow_id\", flowIds)");
    expect(s).toContain(".in(\"flow_run_id\", runIds)");
    expect(s).toContain("mediaByConversation");
    expect(s).toContain("latestRecordingByContact");
  });
});

describe("all-meta-leads — server-side search/filter/pagination", () => {
  it("searches name, phone, Meta Lead ID, and form answer text", () => {
    const rpc = rpcSrc();
    expect(rpc).toContain("c.name ILIKE");
    expect(rpc).toContain("c.phone ILIKE");
    expect(rpc).toContain("s.meta_lead_id ILIKE");
    expect(rpc).toContain("r.vars::text ILIKE");
    expect(rpc).toContain("s.answers::text ILIKE");
  });

  it("filters by date, assignee, table, stage, type, call/follow-up status", () => {
    const rpc = rpcSrc();
    expect(rpc).toContain("p_started_from");
    expect(rpc).toContain("p_assignee");
    expect(rpc).toContain("p_flow_id");
    expect(rpc).toContain("p_stage");
    expect(rpc).toContain("p_lead_type");
    expect(rpc).toContain("p_call_status");
    expect(rpc).toContain("p_followup_status");
  });

  it("paginates the filtered set with total + assignedTotal", () => {
    const rpc = rpcSrc();
    expect(rpc).toContain("LIMIT v_page_size OFFSET v_offset");
    expect(rpc).toContain("'total'");
    expect(rpc).toContain("assigned_total");
  });
});

describe("all-meta-leads — frontend virtual view", () => {
  it("adds All Meta Leads as the first selector option", () => {
    const p = pageSrc();
    expect(p).toContain("ALL_META_LEADS_ID");
    expect(p).toContain("ALL_META_LEADS_LABEL");
    expect(p).toContain("[ALL_META_LEADS_ID, ...");
  });

  it("keeps individual tables unchanged (existing fetch + render path intact)", () => {
    const p = pageSrc();
    expect(p).toContain("/api/flows/${flowId}/table");
    expect(p).toContain("buildWorkspaceTableQuery");
    expect(p).toContain("resolveInitialFlowId");
  });

  it("Form Answers is a single column (no per-question columns)", () => {
    const v = viewSrc();
    const lib = readFileSync(`${root}/src/lib/workspace/all-meta-leads.ts`, "utf8");
    expect(v).toContain("ALL_META_COLUMN_IDS.answers");
    expect(lib).toContain("Form Answers");
    expect(v).toContain("AllMetaAnswersCell");
    // No per-question column generation here.
    expect(v).not.toContain("buildFlowTableColumns");
  });

  it("reuses existing styling, pagination, and horizontal scrolling", () => {
    const v = viewSrc();
    expect(v).toContain("WorkspacePagination");
    expect(v).toContain("WorkspaceSearchField");
    expect(v).toContain("WorkspaceFilters");
    expect(v).toContain("overflow-x-auto");
    expect(v).toContain("Badge");
  });
});
