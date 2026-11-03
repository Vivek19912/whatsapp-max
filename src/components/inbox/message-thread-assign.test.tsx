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

  it("conversation rows display the assignee; unassigned rows show nothing", () => {
    expect(listSrc).toContain("assigneeName");
    expect(listSrc).toContain("Assigned to {assigneeName}");
    expect(listSrc).toContain("assigneeNameById");
    // Unassigned: prop resolves null, row renders no line.
    expect(listSrc).toContain("?? null)");
  });
});
