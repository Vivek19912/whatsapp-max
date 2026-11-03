import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract: Add User always creates Agents — no role picker.
// The dialog must not render a Role dropdown, and the creation
// request must not carry a client-chosen role (the server pins
// every new user to agent and rejects anything else).
const src = readFileSync(
  join(process.cwd(), "src", "components", "team-members", "add-user-dialog.tsx"),
  "utf8"
);

describe("AddUserDialog always-agent contract", () => {
  it("renders no Role field or role options", () => {
    expect(src).not.toContain("add-user-role");
    expect(src).not.toMatch(/>Role</);
    expect(src).not.toContain("SelectItem");
    expect(src).not.toContain("CreatableRole");
    expect(src).not.toContain("ROLE_DESCRIPTIONS");
  });

  it("sends no client-chosen role with the creation request", () => {
    expect(src).toContain("POST /api/account/members");
    // The request body carries only name/email/password.
    expect(src).not.toMatch(/body: JSON\.stringify\(\{[^}]*\brole\b/);
  });

  it("keeps Name, Email, Password, visibility toggle, and both buttons", () => {
    expect(src).toContain("add-user-name");
    expect(src).toContain("add-user-email");
    expect(src).toContain("add-user-password");
    expect(src).toContain("Show password");
    expect(src).toContain("Hide password");
    expect(src).toContain("Cancel");
    expect(src).toContain("Create user");
  });
});
