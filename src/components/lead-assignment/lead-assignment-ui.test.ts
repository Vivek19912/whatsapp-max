// Lead Assignment UI + boundary regression pins (source assertions;
// the admin dashboard is too heavy to render in unit tests).
//
// Pins:
//   * sidebar entry, admin gating, robots, and the dashboard route;
//   * the 4-step rule form, SWRR validation, conflict preview,
//     coverage display, delete confirmation;
//   * Meta-only manual-assign wiring in Workspace;
//   * Chat Assignment, Flow Tables, and shared paths stay untouched.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/src/${p}`, "utf8");

describe("sidebar + route", () => {
  it("adds a Lead Assignment entry after Chat Assignment, admin-gated", () => {
    const sidebar = src("components/layout/sidebar.tsx");
    expect(sidebar).toContain('{ href: "/lead-assignment", label: "Lead Assignment"');
    const navIdx = sidebar.indexOf('"/lead-assignment"');
    expect(navIdx).toBeGreaterThan(sidebar.indexOf('"/chat-assignment"'));
    expect(sidebar).toContain('if (item.href === "/lead-assignment") return canEditSettings;');
    expect(existsSync(`${root}/src/app/(dashboard)/lead-assignment/page.tsx`)).toBe(true);
  });

  it("keeps the route out of search indexes", () => {
    expect(src("app/robots.ts")).toContain('"/lead-assignment"');
  });
});

describe("rule dashboard + form", () => {
  const panel = () =>
    src("components/lead-assignment/lead-assignment-panel.tsx");

  it("is admin-gated and lists rules with coverage", () => {
    const p = panel();
    expect(p).toContain('<RequireRole min="admin"');
    expect(p).toContain("Applies To");
    expect(p).toContain("Table coverage");
    expect(p).toContain("No rule — new leads stay unassigned");
    expect(p).toContain("Create Assignment Rule");
  });

  it("walks Tables → Mode → Members → Review", () => {
    const p = panel();
    expect(p).toContain('["Tables", "Mode", "Members", "Review"]');
    expect(p).toContain("Equal Round Robin");
    expect(p).toContain("Percentage-Based Distribution");
    expect(p).toContain("Assignment sequence");
    expect(p).toContain("must total exactly 100%");
    expect(p).toContain("Save Changes");
  });

  it("blocks invalid saves and previews conflicts", () => {
    const p = panel();
    expect(p).toContain("disabled={saving || draftError !== null}");
    expect(p).toContain("Saving will move it to this rule");
    expect(p).toContain('role="alert"');
    expect(p).toContain("Delete this rule?");
    expect(p).toContain("Recent activity");
  });

  it("never touches Chat Assignment sources", () => {
    const p = panel();
    expect(p).not.toContain("chat-assignment");
    expect(p).not.toContain("src/lib/assignment");
    expect(p).not.toContain("/api/account/assignment");
  });
});

describe("Lead Assignment member loading (same data as Team Members)", () => {
  it("filters eligibility on the API's `role` field, never `account_role`", () => {
    const p = src("components/lead-assignment/lead-assignment-panel.tsx");
    // Regression: the members API returns `role` (the DB column is
    // `account_role`, but it is renamed in the response). Reading
    // `account_role` yielded undefined for every member, so the
    // wizard showed "No eligible members found".
    expect(p).toContain("eligibleMemberIds");
    expect(p).not.toContain("account_role");
  });

  it("eligibility matches the backend rule and ignores presence", () => {
    const m = src("lib/lead-assignment/members.ts");
    expect(m).toContain('["admin", "agent"]');
    expect(m).toContain("isAssignableRole");
    const service = src("lib/lead-assignment/service.ts");
    // Single source of truth: the service reuses the same constant.
    expect(service).toContain('from "./members"');
  });

  it("the members API exposes `role` like the Team Members page uses", () => {
    const route = src("app/api/account/members/route.ts");
    expect(route).toContain("role: row.account_role");
  });
});

describe("Meta-only manual assignment wiring", () => {
  it("routes Meta assignee saves through the audited endpoint", () => {
    const page = src("app/(dashboard)/workspace/page.tsx");
    expect(page).toContain("saveAssignee={");
    expect(page).toContain("isMetaTable && isAssigneeField(f)");
    expect(page).toContain("/leads/${runId}/assign");
    expect(page).toContain("manualAssignMetaLead");
  });

  it("keeps the generic CustomCell save as the default path", () => {
    const cell = src("components/workspace/custom-cell.tsx");
    expect(cell).toContain("saveAssignee?: (raw: unknown) => Promise<string | null>");
    expect(cell).toContain("if (isAssigneeField(field) && saveAssignee) {");
    expect(cell).toContain("/api/flows/${flowId}/workspace-values");
  });
});

describe("Flow Tables and shared paths stay untouched", () => {
  it("no lead-assignment imports in Flow Table or shared write paths", () => {
    for (const file of [
      "lib/flows/flow-tables.ts",
      "app/api/flows/[id]/table/route.ts",
      "app/api/flows/[id]/workspace-values/route.ts",
      "components/workspace/custom-cell.tsx",
      "lib/flows/workspace-assignee.ts",
    ]) {
      expect(src(file)).not.toContain("lead-assignment");
    }
  });

  it("Chat Assignment engine and APIs are untouched", () => {
    expect(src("lib/assignment/engine.ts")).not.toContain("lead_assignment");
    expect(src("app/api/account/assignment/rules/route.ts")).not.toContain(
      "lead_assignment",
    );
    expect(src("components/settings/chat-assignment-panel.tsx")).not.toContain(
      "lead-assignment",
    );
  });

  it("ingestion only adds a best-effort hook after persistence", () => {
    const proc = src("lib/meta-lead-ads/process-lead.ts");
    expect(proc).toContain("maybeAutoAssignLead");
    // The hook runs after the lead + ledger writes, guarded so it
    // can never fail processing.
    const hookIdx = proc.indexOf("maybeAutoAssignLead(db, {");
    expect(hookIdx).toBeGreaterThan(proc.indexOf("return { outcome: \"processed\" };") - 2000);
    expect(proc.slice(hookIdx - 400, hookIdx)).toContain("ADDITIVE");
  });
});
