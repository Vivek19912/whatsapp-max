// Lead Assignment member eligibility — owner + agents selectable,
// viewers/unknown never, presence never filters, ids are stable.

import { describe, expect, it } from "vitest";

import {
  eligibleMemberIds,
  isAssignableRole,
  ASSIGNABLE_ROLES,
} from "./members";

describe("isAssignableRole", () => {
  it("allows admin and agent only", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["admin", "agent"]);
    expect(isAssignableRole("admin")).toBe(true);
    expect(isAssignableRole("agent")).toBe(true);
    expect(isAssignableRole("owner")).toBe(false);
    expect(isAssignableRole("viewer")).toBe(false);
    expect(isAssignableRole("superadmin")).toBe(false);
    expect(isAssignableRole(null)).toBe(false);
    expect(isAssignableRole(undefined)).toBe(false);
  });
});

describe("eligibleMemberIds", () => {
  it("selects the owner-excluded admin/agent pool in order", () => {
    const roster = [
      { user_id: "u-owner", role: "owner", full_name: "Olivia" },
      { user_id: "u-mohan", role: "agent", full_name: "Mohan" },
      { user_id: "u-priya", role: "agent", full_name: "Priya" },
      { user_id: "u-rahul", role: "admin", full_name: "Rahul" },
      { user_id: "u-viewer", role: "viewer", full_name: "Vera" },
    ];
    expect(eligibleMemberIds(roster)).toEqual(["u-mohan", "u-priya", "u-rahul"]);
  });

  it("keeps offline agents eligible (presence is never a signal)", () => {
    const roster = [
      // Presence-flavoured extras must be ignored, not filtered on.
      { user_id: "u-mohan", role: "agent", online: false, last_seen_at: null },
      { user_id: "u-sohan", role: "agent", presence: "away", is_online: false },
      { user_id: "u-off", role: "agent" },
    ];
    expect(eligibleMemberIds(roster)).toEqual(["u-mohan", "u-sohan", "u-off"]);
  });

  it("drops unknown roles, blanks, and duplicates safely", () => {
    expect(
      eligibleMemberIds([
        { user_id: "u-a", role: "agent" },
        { user_id: "u-a", role: "agent" },
        { user_id: "", role: "agent" },
        { user_id: "u-x", role: "support" },
        null,
        undefined,
      ] as never),
    ).toEqual(["u-a"]);
    expect(eligibleMemberIds(null)).toEqual([]);
    expect(eligibleMemberIds(undefined)).toEqual([]);
  });

  it("returns stable profiles.user_id values (what the service persists)", () => {
    const ids = eligibleMemberIds([
      { user_id: "uuid-1", role: "agent", full_name: "Display Name", email: "a@x.com" },
    ]);
    expect(ids).toEqual(["uuid-1"]);
  });
});
