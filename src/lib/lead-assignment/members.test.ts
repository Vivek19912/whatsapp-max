// Lead Assignment member eligibility — owner + agents selectable,
// viewers/unknown never, presence never filters, ids are stable.

import { describe, expect, it } from "vitest";

import {
  eligibleMemberIds,
  isAssignableRole,
  ASSIGNABLE_ROLES,
} from "./members";

describe("isAssignableRole", () => {
  it("allows owner, admin and agent only", () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(["admin", "agent", "owner"]);
    expect(isAssignableRole("owner")).toBe(true);
    expect(isAssignableRole("admin")).toBe(true);
    expect(isAssignableRole("agent")).toBe(true);
    expect(isAssignableRole("viewer")).toBe(false);
    expect(isAssignableRole("superadmin")).toBe(false);
    expect(isAssignableRole(null)).toBe(false);
    expect(isAssignableRole(undefined)).toBe(false);
  });
});

describe("eligibleMemberIds", () => {
  it("includes the owner even without an Admin/Agent role, preserving order", () => {
    const roster = [
      { user_id: "u-owner", role: "owner", full_name: "Olivia" },
      { user_id: "u-mohan", role: "agent", full_name: "Mohan" },
      { user_id: "u-priya", role: "agent", full_name: "Priya" },
      { user_id: "u-rahul", role: "admin", full_name: "Rahul" },
      { user_id: "u-viewer", role: "viewer", full_name: "Vera" },
    ];
    expect(eligibleMemberIds(roster)).toEqual([
      "u-owner",
      "u-mohan",
      "u-priya",
      "u-rahul",
    ]);
  });

  it("includes a solo owner (no Admin/Agent on the roster)", () => {
    expect(
      eligibleMemberIds([{ user_id: "u-owner", role: "owner" }]),
    ).toEqual(["u-owner"]);
  });

  it("includes the owner via an explicit owner flag even with a non-assignable role", () => {
    expect(
      eligibleMemberIds([
        { user_id: "u-owner", role: "viewer", is_owner: true },
        { user_id: "u-other", role: "viewer", isOwner: true },
        { user_id: "u-plain-viewer", role: "viewer" },
      ]),
    ).toEqual(["u-owner", "u-other"]);
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
