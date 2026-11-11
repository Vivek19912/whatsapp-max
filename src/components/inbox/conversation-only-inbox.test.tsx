import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");

// Regression contract: the Inbox shows actual WhatsApp conversations
// only. The lead-only Assigned Leads feature (section, detail panel,
// API, client fetch) was removed; the Workspace→Inbox ownership
// synchronization underneath is preserved untouched.
describe("conversation-only inbox (no Assigned Leads)", () => {
  const page = src("src/app/(dashboard)/inbox/page.tsx");
  const list = src("src/components/inbox/conversation-list.tsx");

  it("renders no Assigned Leads section, heading, or refresh control", () => {
    for (const banned of [
      "AssignedLeadsSection",
      "LeadDetailPanel",
      "AssignedLead",
      "onSelectLead",
      "Assigned leads",
      "ASSIGNED LEADS",
      "fetchAssignedLeads",
      "/api/inbox/assigned-leads",
    ]) {
      expect(page).not.toContain(banned);
      expect(list).not.toContain(banned);
    }
  });

  it("keeps one conversation list, one search, one filter toolbar, one scroller", () => {
    expect(page).toContain("ConversationList");
    expect(page).toContain("MessageThread");
    expect(list).toContain('placeholder="Search conversations..."');
    expect(list).toContain("ScrollArea");
    expect(list.match(/<ScrollArea/g)?.length).toBe(1);
  });

  it("keeps the normal empty state for zero authorized conversations", () => {
    expect(list).toContain("No conversations found");
  });

  it("holds no lead-only selection, navigation, or realtime state", () => {
    for (const banned of [
      "activeLead",
      "leadSearchQuery",
      "threadContactIds",
      "threadForActiveLead",
      "handleSelectLead",
      "LeadDetail",
      "lead-only",
    ]) {
      expect(page).not.toContain(banned);
    }
    expect(list).not.toContain("onSearchQueryChange");
  });

  it("deletes the lead-only modules and API (no dead endpoints)", () => {
    for (const gone of [
      "src/components/inbox/assigned-leads-section.tsx",
      "src/components/inbox/lead-detail-panel.tsx",
      "src/components/inbox/assigned-leads.ts",
      "src/app/api/inbox/assigned-leads/route.ts",
    ]) {
      expect(existsSync(join(root, gone))).toBe(false);
    }
  });
});

describe("ownership synchronization stays intact (conversations only)", () => {
  it("preserves the strict Workspace adopter and its safeguards", () => {
    const sync = src("src/lib/inbox/assignment-sync.ts");
    expect(sync).toContain("resolveWorkspaceOwnerForContact");
    expect(sync).toContain("adoptWorkspaceOwnerForConversation");
    expect(sync).toContain(".is(\"assigned_agent_id\", null)");
    expect(sync).toContain("already-owned");
    expect(sync).toContain("conflict");
  });

  it("preserves outbound-created conversation ownership adoption", () => {
    const queue = src("src/lib/meta-lead-whatsapp/queue.ts");
    expect(queue).toContain("adoptWorkspaceOwnerForConversation");
    // Message persistence and idempotency behavior untouched.
    expect(queue).toContain("message_id");
    expect(queue).toContain("getOrCreateConversation");
  });

  it("preserves inbound adoption before chat auto-assignment", () => {
    const webhook = src("src/app/api/whatsapp/webhook/route.ts");
    const adoptAt = webhook.indexOf("adoptWorkspaceOwnerForConversation");
    const autoAt = webhook.indexOf("resolveAssignment(supabaseAdmin()");
    expect(adoptAt).toBeGreaterThan(-1);
    expect(autoAt).toBeGreaterThan(-1);
    expect(adoptAt).toBeLessThan(autoAt);
    // Converge engine-driven changes to the unique Workspace owner.
    expect(webhook).toContain("resolveWorkspaceOwnerForContact");
  });

  it("preserves automation ownership convergence", () => {
    const engine = src("src/lib/automations/engine.ts");
    expect(engine).toContain("resolveWorkspaceOwnerForContact");
    expect(engine).toContain("assigned to ${targetId}");
  });

  it("preserves the realtime publication for assignment changes", () => {
    const migration = src("supabase/migrations/165_workspace_values_realtime.sql");
    expect(migration).toContain(
      "ALTER PUBLICATION supabase_realtime ADD TABLE workspace_values"
    );
    // The Inbox resyncs the conversation list on those events —
    // reassignment moves threads between owners without polling.
    expect(src("src/app/(dashboard)/inbox/page.tsx")).toContain(
      "onWorkspaceValuesEvent"
    );
  });

  it("preserves the gated historical drift repair (dry-run first, NULL-only)", () => {
    expect(
      existsSync(join(root, "scripts/repair-inbox-assignment-drift.sql"))
    ).toBe(true);
  });

  it("changes no RLS posture", () => {
    expect(
      src("supabase/migrations/149_agent_inbox_permissions.sql")
    ).toContain("assigned_agent_id = auth.uid()");
  });
});
