import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring contract: the WhatsApp webhook must adopt the Workspace
// owner onto newly created threads AND existing unowned threads,
// BEFORE general chat auto-assign runs — and never overwrite an
// explicit assignment. These pins guard the ordering; the adoption
// semantics themselves are covered by assignment-sync.test.ts.
const src = readFileSync(
  join(process.cwd(), "src", "app", "api", "whatsapp", "webhook", "route.ts"),
  "utf8"
);

describe("webhook Workspace-owner adoption ordering", () => {
  it("invokes the strict adopter for created or unowned threads", () => {
    expect(src).toContain("adoptWorkspaceOwnerForConversation");
    expect(src).toContain("convResult.created");
    // Unowned-existing-thread branch: adoption runs when the row
    // carries no owner yet.
    expect(src).toContain("assigned_agent_id");
  });

  it("runs adoption before chat auto-assign", () => {
    const adoptAt = src.indexOf("adoptWorkspaceOwnerForConversation");
    const autoAt = src.indexOf("resolveAssignment(supabaseAdmin()");
    expect(adoptAt).toBeGreaterThan(-1);
    expect(autoAt).toBeGreaterThan(-1);
    expect(adoptAt).toBeLessThan(autoAt);
  });

  it("refreshes the local owner so auto-assign sees the adopted value", () => {
    // Without this, auto-assign would evaluate the stale null and
    // could overwrite the just-adopted Workspace owner.
    expect(src).toContain("conversation.assigned_agent_id = outcome.ownerId");
  });
});
