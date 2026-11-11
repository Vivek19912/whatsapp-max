import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: Inbox owners manage per-agent Inbox permissions from the
// Team Members page — two independent checkboxes with the exact
// spec'd descriptions, owner-only UI and API, visible current state.
function teamSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "team-members", "team-members-view.tsx"),
    "utf8"
  );
}
function dialogSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "team-members", "agent-permissions-dialog.tsx"),
    "utf8"
  );
}

describe("Team Members inbox-permissions UI", () => {
  it("shows an Access control per agent, owner-only, never for owners/self", () => {
    const src = teamSrc();
    expect(src).toContain("setPermMember");
    expect(src).toContain('Inbox permissions for');
    expect(src).toContain("isOwner");
    // Only agents get the control (owners already have everything),
    // never yourself, and only rendered for the owner role.
    expect(src).toMatch(/member\.role === 'agent'/);
    expect(src).toContain("!isSelf");
  });

  it("shows both checkboxes with the exact spec descriptions", () => {
    const src = dialogSrc();
    expect(src).toContain("Manage Assignments");
    expect(src).toContain(
      "Can reassign Workspace leads and Inbox conversations to any salesperson."
    );
    expect(src).toContain("View All Conversations");
    // (JSX wraps the line; assert the phrases, not the whitespace.)
    expect(src).toContain("Can view all Inbox conversations, including conversations");
    expect(src).toContain("assigned to other agents and unassigned conversations.");
    // Independent controls (two checkboxes, no radio/enable-all).
    const boxes = src.match(/<Checkbox/g) ?? [];
    expect(boxes.length).toBe(2);
  });

  it("current grants are visible in the row and the dialog loads them", () => {
    expect(teamSrc()).toContain("can_manage_assignments");
    expect(teamSrc()).toContain("can_view_all");
    expect(teamSrc()).toContain("Can assign");
    expect(teamSrc()).toContain("Views all");
    expect(dialogSrc()).toContain("agent-permissions?user_id=");
  });

  it("saves through the owner-only PUT endpoint, never directly", () => {
    expect(dialogSrc()).toContain("method: \"PUT\"");
    expect(dialogSrc()).toContain("/api/account/agent-permissions");
    expect(dialogSrc()).not.toContain("supabase");
  });
});
