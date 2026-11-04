import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring contract for assignment sync in the Inbox thread + list.
// The thread needs browser + Supabase APIs to render, so (matching
// this repo's established pattern) integration points are pinned as
// source assertions; behaviour lives in assignment-sync.test.ts and
// the assign route tests.
const threadSrc = readFileSync(
  join(process.cwd(), "src", "components", "inbox", "message-thread.tsx"),
  "utf8"
);
const listSrc = readFileSync(
  join(process.cwd(), "src", "components", "inbox", "conversation-list.tsx"),
  "utf8"
);

describe("Inbox assignment sync wiring", () => {
  it("conversation rows show no assignee line (header owns that display)", () => {
    // The redundant "Assigned to X" row text was removed: rows show
    // name, preview, timestamp, unread, pins, and tags only. The
    // header keeps the assignee display (see page test below).
    expect(listSrc).not.toContain("Assigned to {assigneeName}");
    expect(listSrc).not.toContain("assigneeName");
  });

  it("header Assign control is editable only with assignment authority", () => {
    // Owners/admins/Manage-granted agents get the dropdown; View
    // All-only and plain agents get a read-only name label (no
    // chevron, no menu, no Unassign). Caps arrive via prop from the
    // page, which fetches them once from /me.
    expect(threadSrc).toContain("viewerCaps");
    expect(threadSrc).toContain("NO_INBOX_CAPS");
    expect(threadSrc).toContain("canManageAssignments");
    expect(threadSrc).toContain("accountRole");
    // Editable branch keeps the full dropdown + Unassign action.
    expect(threadSrc).toContain("<DropdownMenu>");
    expect(threadSrc).toContain("Unassign");
    // Read-only branch renders a plain label with no menu trigger.
    expect(threadSrc).toContain("Assigned to ${assignLabel}");
  });

  it("header shows the assignee name (fallback only when unknown)", () => {
    expect(threadSrc).toContain("currentAssignee?.full_name ?? \"Assigned\"");
    expect(threadSrc).toContain("assignedAgentId ?");
  });

  it("resolves names from the full team roster, not the RLS-narrowed profiles read", () => {
    expect(threadSrc).toContain('fetch("/api/account/members")');
    expect(threadSrc).not.toContain('.from("profiles")');
  });

  it("reassigns through the syncing API route, not a direct table write", () => {
    expect(threadSrc).toContain("/api/inbox/conversations/${conversation.id}/assign");
    expect(threadSrc).toContain("JSON.stringify({ user_id: agentId })");
    // The only remaining direct conversations write is the unread-count
    // reset; assignment goes through the route (no assigned_agent_id PUT).
    expect(threadSrc).not.toContain("update({ assigned_agent_id: agentId })");
  });

  it("conversation rows carry no assignee prop (header owns that display)", () => {
    expect(listSrc).not.toContain("assigneeName");
    expect(listSrc).not.toContain("assigneeNameById");
    expect(listSrc).not.toContain("Assigned to {assigneeName}");
  });
});
