import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: agents holding Manage Assignments may reassign Workspace
// Meta Lead Ads leads (same permission as Inbox reassignment, no
// View All needed). Owners/admins unchanged; plain agents stay blocked.
function src(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const page = () => src("src", "app", "(dashboard)", "workspace", "page.tsx");
const dialog = () =>
  src("src", "components", "team-members", "agent-permissions-dialog.tsx");
const wsValues = () =>
  src("src", "app", "api", "flows", "[id]", "workspace-values", "route.ts");
const leadsAssign = () =>
  src("src", "app", "api", "flows", "[id]", "leads", "[runId]", "assign", "route.ts");

describe("Workspace reassignment via Manage Assignments", () => {
  it("page resolves the Manage grant and gates Assigned To on it", () => {
    expect(page()).toContain("/api/account/agent-permissions/me");
    expect(page()).toContain("canManageAssignments");
    expect(page()).toContain("!canManageAssignments");
    expect(page()).toContain("isAssigneeField(f)");
  });

  it("agent without the grant stays read-only (fail closed)", () => {
    // Lookup failure keeps reassignment disabled.
    expect(page()).toContain("setCanManageAssignments(false)");
    // Owners/admins default to allowed.
    expect(page()).toContain("accountRole === 'owner' || accountRole === 'admin'");
  });

  it("leads assign API admits managing agents, blocks plain agents", () => {
    expect(leadsAssign()).toContain("caps.canManageAssignments");
    expect(leadsAssign()).toContain("Only admins or agents with Manage Assignments");
    expect(leadsAssign()).not.toContain("view_all");
  });

  it("workspace-values API admits managing agents for the Assignee cell", () => {
    expect(wsValues()).toContain("caps.canManageAssignments");
    expect(wsValues()).toContain(
      "Only admins or agents with Manage Assignments can reassign leads"
    );
    // View All is never consulted for assignment.
    const manageBlock = wsValues().slice(
      wsValues().indexOf("if (role === \"agent\")")
    );
    expect(manageBlock).not.toContain("canViewAll");
  });

  it("permission description covers Workspace + Inbox", () => {
    expect(dialog()).toContain("Manage Assignments");
    expect(dialog()).toContain(
      "Can reassign Workspace leads and Inbox conversations to any salesperson."
    );
    expect(dialog()).not.toContain("Can assign any conversation to any salesperson.");
  });

  it("no View All requirement is introduced", () => {
    expect(page()).not.toContain("canViewAll");
    // The Meta assignee save still goes through the audited endpoint.
    expect(page()).toContain("manualAssignMetaLead");
    expect(page()).toContain("/leads/${runId}/assign");
  });
});
