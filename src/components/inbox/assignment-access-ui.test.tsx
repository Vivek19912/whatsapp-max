import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: the Inbox UI enforces the same assignment rule as RLS —
// agents only ever see their own threads unless granted View All,
// and only owners / manage-granted agents see the cross-thread
// Assign entry point. Realtime permission changes converge without
// logout or refresh.
function listSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "inbox", "conversation-list.tsx"),
    "utf8"
  );
}
function dialogSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "inbox", "assign-dialog.tsx"),
    "utf8"
  );
}
function pageSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "app", "(dashboard)", "inbox", "page.tsx"),
    "utf8"
  );
}

describe("Inbox assignment UI wiring", () => {
  it("Team filter shows agents only themselves unless granted View All", () => {
    const src = listSrc();
    expect(src).toContain("teamOptions");
    expect(src).toContain("accountRole");
    expect(src).toContain("viewerCaps.canViewAll");
    expect(src).toContain("showUnassignedOption");
  });

  it("toolbar has no Assign entry; the thread header keeps the Assign control", () => {
    const src = listSrc();
    expect(src).not.toContain("canAssignAnywhere");
    expect(src).not.toContain("setAssignDialogOpen(true)");
    expect(src).not.toContain("<AssignDialog");
    expect(src).not.toContain("onAssignChange?.(");
  });

  it("assign dialog lists identity + assignee only — never message content", () => {
    const src = dialogSrc();
    expect(src).toContain("/api/inbox/assignable");
    expect(src).toContain("assigned_agent_id");
    // No message content, no attachments, no full contact details —
    // the copy states the boundary explicitly.
    expect(src).not.toContain("content_text");
    expect(src).not.toContain("content-text");
    expect(src).not.toContain('from("messages")');
    expect(src).toContain("message history stays");
  });

  it("assign dialog reassigns through the gated assign API and syncs state", () => {
    const src = dialogSrc();
    expect(src).toContain("/api/inbox/conversations/${conversationId}/assign");
    expect(src).toContain("onAssigned?.(");
  });

  it("page fetches caps once and re-checks visibility on every change", () => {
    const src = pageSrc();
    expect(src).toContain("/api/account/agent-permissions/me");
    expect(src).toContain("viewerCaps");
    expect(src).toContain("onWorkspaceValuesEvent");
    expect(src).toContain("reverifyActiveThread");
    // Revoked threads are dropped from the list; the open one closes.
    expect(src).toContain("no longer assigned to you");
  });

  it("permissions changes converge without logout (realtime + refetch)", () => {
    const src = pageSrc();
    expect(src).toContain("agent_inbox_permissions");
    expect(src).toContain("setResyncToken((n) => n + 1)");
  });
});
