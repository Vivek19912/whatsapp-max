import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The one-time drift repair must only EVER fill currently-unassigned
// threads, scoped to one account and one verified owner. These pins
// guard the script against ever becoming an unconditional overwrite:
// no blind mass-update, no cross-account writes, dry-run first.
const sql = readFileSync(
  join(process.cwd(), "scripts", "repair-inbox-assignment-drift.sql"),
  "utf8"
);

describe("historical drift repair guardrails", () => {
  it("only fills NULL owners and never overwrites an assignment", () => {
    expect(sql).toMatch(/WHERE[\s\S]*?c\.assigned_agent_id IS NULL/i);
    expect(sql).toMatch(/UPDATE public\.conversations/i);
  });

  it("scopes both statements to the same account and owner", () => {
    expect(sql).toContain(":ACCOUNT_ID");
    expect(sql).toContain(":OWNER_ID");
    expect(sql).toMatch(/c\.account_id = :ACCOUNT_ID/);
  });

  it("offers a dry-run SELECT before any APPLY", () => {
    expect(sql).toMatch(/DRY RUN/i);
    expect(sql).toContain("SELECT");
  });

  it("copies only stable member UUIDs, never display strings", () => {
    expect(sql).toMatch(/value_text ~ /);
  });
});
