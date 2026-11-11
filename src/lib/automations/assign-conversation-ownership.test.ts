import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The automation `assign_conversation` step performs an unconditional
// thread-owner overwrite. For Meta-linked contacts with exactly one
// Workspace owner, the thread must converge to that owner instead of
// the automation target; unrelated contacts keep existing behavior.
// The resolution logic itself is unit-tested in
// assignment-sync.test.ts — these pins guard the call site.
const src = readFileSync(
  join(process.cwd(), "src", "lib", "automations", "engine.ts"),
  "utf8"
);

describe("automation assign_conversation respects Workspace ownership", () => {
  it("resolves the Workspace owner before overwriting the thread", () => {
    expect(src).toContain("resolveWorkspaceOwnerForContact");
  });

  it("keeps the automation target when there is no unique Workspace owner", () => {
    // Fallback path: configured target stands for unrelated contacts.
    expect(src).toContain("fall back to the configured target");
    expect(src).toContain("return `assigned to ${targetId}`");
  });

  it("scopes the ownership write to the automation account and contact", () => {
    const block = src.slice(src.indexOf("case 'assign_conversation'"));
    const end = block.indexOf("case 'assign_person'");
    const step = end === -1 ? block : block.slice(0, end);
    expect(step).toContain(".eq('account_id', args.automation.account_id)");
    expect(step).toContain(".eq('contact_id', args.contactId)");
    expect(step).not.toContain("assigned_agent_id: agentId }");
  });
});
