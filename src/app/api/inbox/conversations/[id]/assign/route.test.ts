import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: POST /api/inbox/conversations/[id]/assign writes the
// Inbox assignee AND mirrors it into the Workspace Assigned To cell,
// account-scoped, with the same permission bar as before.
const routeSrc = readFileSync(
  join(
    process.cwd(),
    "src",
    "app",
    "api",
    "inbox",
    "conversations",
    "[id]",
    "assign",
    "route.ts"
  ),
  "utf8"
);

describe("inbox assign route", () => {
  it("requires agent+ (same bar as the direct client write it replaces)", () => {
    expect(routeSrc).toContain('requireRole("agent")');
  });

  it("validates the member id and 404s unknown/foreign conversations", () => {
    expect(routeSrc).toContain("UUID_RE");
    expect(routeSrc).toContain("Choose a team member from this account.");
    expect(routeSrc).toContain(".eq(\"account_id\", ctx.accountId)");
    expect(routeSrc).not.toContain("phone");
  });

  it("writes conversations.assigned_agent_id then mirrors to Workspace", () => {
    expect(routeSrc).toContain(".update({ assigned_agent_id: userId })");
    expect(routeSrc).toContain("mirrorConversationAssignmentToWorkspace");
  });

  it("never applies migrations, never touches other tenants", () => {
    expect(routeSrc).not.toContain("migration");
    expect(routeSrc).not.toContain("service_role");
  });
});
