import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: every Inbox/server action that touches a conversation,
// its messages, or its media enforces the assignment rule —
// owner/admin: any thread; agent: only own assigned threads;
// viewer: legacy read-all. RLS is the backstop; these routes add
// explicit checks with the right 403/404 semantics.
function src(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const assign = () =>
  src("src", "app", "api", "inbox", "conversations", "[id]", "assign", "route.ts");
const send = () =>
  src("src", "app", "api", "whatsapp", "send", "route.ts");
const react = () =>
  src("src", "app", "api", "whatsapp", "react", "route.ts");
const media = () =>
  src("src", "app", "api", "whatsapp", "media", "[mediaId]", "route.ts");
const pins = () =>
  src("src", "app", "api", "inbox", "pins", "route.ts");

describe("assignment enforcement on conversation actions", () => {
  it("assign route gates on the current assignee (agents: own threads only)", () => {
    expect(assign()).toContain("canActOnConversation");
    expect(assign()).toContain("assigned_agent_id");
    // No oracle: invisible threads 404 like missing ones.
    expect(assign()).toContain("return notFound()");
    // Still validates the new owner is a same-account member.
    expect(assign()).toContain("Choose a team member from this account.");
  });

  it("assign route admits managing agents to any thread (without granting reads)", () => {
    // Caps resolve server-side and ride into the shared gate; reads
    // stay governed by the separate visibility check + RLS.
    expect(assign()).toContain("resolveViewerCaps");
    expect(assign()).toContain("canActOnConversation");
  });

  it("send route gates existing threads; contact-initiated sends stay agent+", () => {
    expect(send()).toContain("canActOnConversation");
    expect(send()).toContain("Conversation not found");
    expect(send()).toContain("isAgentOrAbove");
  });

  it("react route gates on the parent thread assignment", () => {
    expect(react()).toContain("canActOnConversation");
    expect(react()).toContain("assigned_agent_id");
  });

  it("media route gates archived media by parent-thread assignment (view-all aware)", () => {
    expect(media()).toContain("canViewConversation");
    expect(media()).toContain("resolveViewerCaps");
    expect(media()).toContain("Media not found");
  });

  it("pin creation gates on visibility (view-all aware); unpin stays ungated (own rows only)", () => {
    expect(pins()).toContain("canViewConversation");
    expect(pins()).toContain("resolveViewerCaps");
    // Only the POST path carries the gate; DELETE touches nothing
    // but the caller's own rows.
    const posts = pins().match(/canViewConversation/g) ?? [];
    expect(posts.length).toBeGreaterThanOrEqual(1);
  });

  it("workspace assignment paths honor the Manage Assignments grant", () => {
    const ws = src(
      "src",
      "app",
      "api",
      "flows",
      "[id]",
      "workspace-values",
      "route.ts"
    );
    expect(ws).toContain("canManageAssignments");
    expect(ws).toContain("Only admins can reassign leads");
    const manual = src(
      "src",
      "app",
      "api",
      "flows",
      "[id]",
      "leads",
      "[runId]",
      "assign",
      "route.ts"
    );
    expect(manual).toContain("Manage Assignments");
    expect(manual).toContain('requireRole("agent")');
  });

  it("authorization is explicit even where the service role is used", () => {
    // Gating reads (roster/membership checks, media thread lookup)
    // run on the caller's RLS identity; the assign route uses the
    // service role (a managing agent may touch threads RLS hides from
    // them) but re-establishes every boundary explicitly: account
    // scoping, capability gate, roster validation.
    expect(assign()).toContain("canActOnConversation");
    expect(assign()).toContain("resolveViewerCaps");
    expect(assign()).toContain("supabaseAdmin()");
    expect(assign()).toContain('.eq("account_id", ctx.accountId)');
    expect(send()).toContain("requireAuthenticatedUser");
    expect(react()).toContain("requireAuthenticatedUser");
    expect(media()).toContain("requireAuthenticatedUser");
    expect(pins()).toContain("ctx.supabase");
  });

  it("every Workspace assignment write converges the linked thread (no silent drift)", () => {
    // Regression: Workspace showed an owner while the Inbox thread
    // stayed unassigned (agent saw 1 of 20 threads). All four
    // Workspace-side writers must mirror to conversations:
    //   1. Workspace cell edits (clear + set) via the service role
    //      (caller RLS would deny cross-assignee updates),
    //   2. manual (re)assignments via the shared service,
    //   3. per-table auto-assignments,
    //   4. legacy global auto-assignments (already mirrored).
    const ws = src(
      "src", "app", "api", "flows", "[id]", "workspace-values", "route.ts"
    );
    const wsMirrors = ws.match(/mirrorRunAssignmentToConversation\(\s*supabaseAdmin\(\)/g) ?? [];
    expect(wsMirrors.length).toBe(2);

    // The manual assign route mirrors with the service role AFTER
    // the service validated everything (owner/manage gate,
    // same-account roster, run in this account+flow) — a caller
    // client would be RLS-denied on others' threads.
    const manual = src(
      "src", "app", "api", "flows", "[id]", "leads", "[runId]", "assign", "route.ts"
    );
    const routeMirrors = manual.match(/mirrorRunAssignmentToConversation\(\s*supabaseAdmin\(\)/g) ?? [];
    expect(routeMirrors.length).toBe(1);    const service = src("src", "lib", "lead-assignment", "service.ts");
    expect(service).toContain("manualAssign");
    const manualBlock = service.slice(service.indexOf("export async function manualAssign"));
    expect(manualBlock).toContain("mirrorRunAssignmentToConversation");
    const engine = src("src", "lib", "lead-assignment", "table-assignment.ts");
    expect(engine).toContain("mirrorRunAssignmentToConversation(db, accountId, runId, selected.user_id)");
  });
});
