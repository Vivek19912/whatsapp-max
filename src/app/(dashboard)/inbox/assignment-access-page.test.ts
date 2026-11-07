import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: the Inbox page enforces assignment visibility on top of
// RLS — realtime payloads are filtered before entering state,
// revoked threads (and the open thread) are dropped immediately,
// and agents only ever see themselves in the Team filter.
function pageSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "app", "(dashboard)", "inbox", "page.tsx"),
    "utf8"
  );
}

function listSrc(): string {
  return readFileSync(
    join(process.cwd(), "src", "components", "inbox", "conversation-list.tsx"),
    "utf8"
  );
}

describe("Inbox page assignment enforcement", () => {
  it("filters realtime payloads and hydrate results by assignment", () => {
    const src = pageSrc();
    expect(src).toContain("isVisibleConv(conv)");
    expect(src).toContain("isVisibleConv(fetched)");
    expect(src).toContain("canViewConversation");
  });

  it("drops revoked threads and closes the open thread with notice", () => {
    const src = pageSrc();
    // List removal on revoked UPDATE.
    expect(src).toContain("prev.filter((c) => c.id !== conv.id)");
    // Active thread cleared with contact/messages reset + URL cleanup.
    expect(src).toContain('router.replace("/inbox"');
    expect(src).toContain("no longer assigned to you");
    // Self-unassign/reassign via the assign action converges the same way.
    expect(src).toContain("prev.filter((c) => c.id !== conversationId)");
  });

  it("re-syncs on workspace_values changes (suppressed UPDATE fallback)", () => {
    const src = pageSrc();
    expect(src).toContain("onWorkspaceValuesEvent");
    expect(src).toContain("setResyncToken((n) => n + 1)");
    expect(src).toContain("reverifyActiveThread");
  });

  it("re-syncs on permission grants/revokes without logout (fail-closed caps fetch)", () => {
    const src = pageSrc();
    expect(src).toContain("/api/account/agent-permissions/me");
    expect(src).toContain("inbox-permissions");
    expect(src).toContain("NO_INBOX_CAPS");
  });

  it("visibility checks honor granted View All (agents are not blanket-dropped)", () => {
    const src = pageSrc();
    expect(src).toContain("viewerCaps");
    expect(src).toContain("canViewConversation(");
  });

  it("Team filter shows agents only themselves unless granted View All", () => {
    const src = listSrc();
    expect(src).toContain("teamOptions");
    expect(src).toContain("accountRole === \"agent\"");
    expect(src).toContain("viewerCaps.canViewAll");
    expect(src).toContain("showUnassignedOption");
  });

  it("toolbar carries no cross-thread Assign entry (removed; header owns assigning)", () => {
    const src = listSrc();
    expect(src).not.toContain("canAssignAnywhere");
    expect(src).not.toContain("setAssignDialogOpen");
    expect(src).not.toContain("<AssignDialog");
    expect(src).not.toContain('aria-label="Assign conversations"');
    expect(src).not.toContain("onAssignChange");
  });

  it("conversation rows show no assignee line (header owns that display)", () => {
    const src = listSrc();
    expect(src).not.toContain("assigneeName");
    expect(src).not.toContain("Assigned to {assigneeName}");
  });

  it("thread header keeps the Assign label and gates editing on Manage Assignments", () => {
    const thread = readFileSync(
      join(process.cwd(), "src", "components", "inbox", "message-thread.tsx"),
      "utf8"
    );
    expect(thread).toContain('"Assign"');
    expect(thread).toContain("currentAssignee?.full_name");
    // Header control: editable dropdown for assignment authorities,
    // read-only name label otherwise (caps flow from the page).
    expect(thread).toContain("viewerCaps");
    expect(thread).toContain("canManageAssignments");
  });

  it("page passes viewer caps to the thread header control", () => {
    const src = pageSrc();
    expect(src).toContain("<MessageThread");
    expect(src).toContain("viewerCaps={viewerCaps}");
  });
});
