import { describe, it, expect } from "vitest";

import {
  canActOnConversation,
  canViewConversation,
  filterVisibleConversations,
  isAgentOrAbove,
  NO_INBOX_CAPS,
  resolveViewerCaps,
} from "./assignment-access";

const SANIYA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("canViewConversation", () => {
  it("owner sees assigned, unassigned, and other agents' threads", () => {
    const v = { role: "owner", userId: SANIYA };
    expect(canViewConversation(v, SANIYA)).toBe(true);
    expect(canViewConversation(v, OTHER)).toBe(true);
    expect(canViewConversation(v, null)).toBe(true);
    expect(canViewConversation(v, undefined)).toBe(true);
  });

  it("admin keeps full visibility (assignment management needs it)", () => {
    const v = { role: "admin", userId: SANIYA };
    expect(canViewConversation(v, SANIYA)).toBe(true);
    expect(canViewConversation(v, OTHER)).toBe(true);
    expect(canViewConversation(v, null)).toBe(true);
  });

  it("agent sees only threads assigned to themselves", () => {
    const v = { role: "agent", userId: SANIYA };
    expect(canViewConversation(v, SANIYA)).toBe(true);
    expect(canViewConversation(v, OTHER)).toBe(false);
    expect(canViewConversation(v, null)).toBe(false);
    expect(canViewConversation(v, undefined)).toBe(false);
  });

  it("viewer keeps legacy read-all (unchanged read-only behavior)", () => {
    const v = { role: "viewer", userId: SANIYA };
    expect(canViewConversation(v, SANIYA)).toBe(true);
    expect(canViewConversation(v, OTHER)).toBe(true);
    expect(canViewConversation(v, null)).toBe(true);
  });

  it("denies when identity or role is missing, or role is unknown", () => {
    expect(canViewConversation({ role: "agent" }, SANIYA)).toBe(false);
    expect(canViewConversation({ userId: SANIYA }, SANIYA)).toBe(false);
    expect(canViewConversation({ role: null, userId: SANIYA }, SANIYA)).toBe(false);
    expect(canViewConversation({ role: "owner", userId: null }, SANIYA)).toBe(false);
    expect(
      canViewConversation({ role: "superadmin", userId: SANIYA }, SANIYA)
    ).toBe(false);
  });

  it("never matches on names, emails, or phone numbers", () => {
    // Identity is the stable profiles.user_id only: a display name in
    // the assigned slot grants nothing without the matching user id.
    expect(
      canViewConversation({ role: "agent", userId: "uuid-1" }, "Saniya")
    ).toBe(false);
    expect(
      canActOnConversation({ role: "agent", userId: "uuid-1" }, "Saniya")
    ).toBe(false);
  });
});

describe("canActOnConversation", () => {
  it("owner/admin may act on any thread including unassigned", () => {
    expect(
      canActOnConversation({ role: "owner", userId: SANIYA }, OTHER)
    ).toBe(true);
    expect(canActOnConversation({ role: "owner", userId: SANIYA }, null)).toBe(
      true
    );
    expect(
      canActOnConversation({ role: "admin", userId: SANIYA }, OTHER)
    ).toBe(true);
  });

  it("agents may act only on their own assigned threads", () => {
    expect(canActOnConversation({ role: "agent", userId: SANIYA }, SANIYA)).toBe(
      true
    );
    expect(canActOnConversation({ role: "agent", userId: SANIYA }, OTHER)).toBe(
      false
    );
    expect(canActOnConversation({ role: "agent", userId: SANIYA }, null)).toBe(
      false
    );
  });

  it("viewers can never act", () => {
    expect(canActOnConversation({ role: "viewer", userId: SANIYA }, SANIYA)).toBe(
      false
    );
    expect(canActOnConversation({ role: "viewer", userId: SANIYA }, null)).toBe(
      false
    );
  });
});

describe("filterVisibleConversations", () => {
  const rows = [
    { id: "a", assigned_agent_id: SANIYA },
    { id: "b", assigned_agent_id: OTHER },
    { id: "c", assigned_agent_id: null },
  ];

  it("agent keeps only their own threads; order preserved, no dupes", () => {
    const out = filterVisibleConversations(rows, { role: "agent", userId: SANIYA });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("owner keeps everything including unassigned", () => {
    const out = filterVisibleConversations(rows, { role: "owner", userId: SANIYA });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("reassignment is a pure function of the new assignee", () => {
    // Saniya -> Other: Saniya loses it, Other gains it, owner unaffected.
    const moved = rows.map((r) => (r.id === "a" ? { ...r, assigned_agent_id: OTHER } : r));
    expect(
      filterVisibleConversations(moved, { role: "agent", userId: SANIYA }).map((r) => r.id)
    ).toEqual([]);
    expect(
      filterVisibleConversations(moved, { role: "agent", userId: OTHER }).map((r) => r.id)
    ).toEqual(["a", "b"]);
    expect(filterVisibleConversations(moved, { role: "owner", userId: SANIYA })).toHaveLength(3);
  });

  it("view-all caps restore the full roster for agents (default denies)", () => {
    expect(
      filterVisibleConversations(rows, { role: "agent", userId: SANIYA }, VIEW_ALL_CAPS).map((r) => r.id)
    ).toEqual(["a", "b", "c"]);
    expect(
      filterVisibleConversations(rows, { role: "agent", userId: SANIYA }, MANAGE_ONLY_CAPS).map(
        (r) => r.id
      )
    ).toEqual(["a"]);
  });
});

const VIEW_ALL_CAPS = { canViewAll: true, canManageAssignments: false };
const MANAGE_ONLY_CAPS = { canViewAll: false, canManageAssignments: true };

describe("granted permissions (View All / Manage Assignments)", () => {
  const MANAGE = { canViewAll: false, canManageAssignments: true };
  const VIEW = { canViewAll: true, canManageAssignments: false };
  const BOTH = { canViewAll: true, canManageAssignments: true };

  it("agents with View All see everything, including unassigned", () => {
    expect(canViewConversation({ role: "agent", userId: "u1" }, "u9", VIEW)).toBe(true);
    expect(canViewConversation({ role: "agent", userId: "u1" }, null, VIEW)).toBe(true);
  });

  it("manage-only agents still cannot read other threads", () => {
    expect(canViewConversation({ role: "agent", userId: "u1" }, "u9", MANAGE)).toBe(false);
    expect(canViewConversation({ role: "agent", userId: "u1" }, null, MANAGE)).toBe(false);
    expect(canViewConversation({ role: "agent", userId: "u1" }, "u1", MANAGE)).toBe(true);
  });

  it("manage permission grants assignment on any thread without granting read", () => {
    expect(canActOnConversation({ role: "agent", userId: "u1" }, "u9", MANAGE)).toBe(true);
    expect(canActOnConversation({ role: "agent", userId: "u1" }, null, MANAGE)).toBe(true);
    // Separation holds: act is granted, view is not.
    expect(canViewConversation({ role: "agent", userId: "u1" }, "u9", MANAGE)).toBe(false);
  });

  it("view-all permission grants no assignment rights", () => {
    expect(canActOnConversation({ role: "agent", userId: "u1" }, "u9", VIEW)).toBe(false);
    expect(canActOnConversation({ role: "agent", userId: "u1" }, "u1", VIEW)).toBe(true);
  });

  it("both permissions grant both capabilities independently", () => {
    expect(canViewConversation({ role: "agent", userId: "u1" }, "u9", BOTH)).toBe(true);
    expect(canActOnConversation({ role: "agent", userId: "u1" }, "u9", BOTH)).toBe(true);
  });

  it("caps never grant viewer read beyond legacy, nor owner/admin anything new", () => {
    expect(canViewConversation({ role: "viewer", userId: "u1" }, "u9", NO_INBOX_CAPS)).toBe(true);
    expect(canActOnConversation({ role: "viewer", userId: "u1" }, "u9", BOTH)).toBe(false);
    expect(canViewConversation({ role: "owner", userId: "u1" }, null, NO_INBOX_CAPS)).toBe(true);
  });

  it("grants are role+flag based, never string-matched", () => {
    // Without caps, a display name in the assigned slot grants nothing.
    expect(canViewConversation({ role: "agent", userId: "uuid-1" }, "Saniya")).toBe(false);
    expect(canActOnConversation({ role: "agent", userId: "uuid-1" }, "Saniya")).toBe(false);
    // With caps, access follows the flags — the assigned value is
    // never string-compared for authorization.
    const BOTH = { canViewAll: true, canManageAssignments: true };
    expect(canViewConversation({ role: "agent", userId: "uuid-1" }, "Saniya", BOTH)).toBe(true);
    expect(canActOnConversation({ role: "agent", userId: "uuid-1" }, "Saniya", BOTH)).toBe(true);
    // A different agent's id grants nothing without caps.
    expect(canViewConversation({ role: "agent", userId: "uuid-9" }, "uuid-1")).toBe(false);
  });
});

describe("resolveViewerCaps", () => {
  // Minimal chain stub that honors equality filters, so account/user
  // scoping is actually exercised (not just asserted by shape).
  function fakeDb(rows: Record<string, unknown>[] | null, error?: { message: string }) {
    return {
      from: (table: string) => {
        if (table !== "agent_inbox_permissions") throw new Error("unexpected table " + table);
        const filters: Array<[string, unknown]> = [];
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        };
        chain.maybeSingle = async () => {
          if (error) return { data: null, error };
          const row = (rows ?? []).find((r) =>
            filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v)
          );
          return { data: row ?? null, error: null };
        };
        return chain;
      },
    };
  }

  it("owners and admins get full caps without a table read", async () => {
    const db = { from: () => { throw new Error("must not query"); } };
    await expect(
      resolveViewerCaps(db as never, "acc", "u1", "owner")
    ).resolves.toEqual({ canViewAll: true, canManageAssignments: true });
    await expect(
      resolveViewerCaps(db as never, "acc", "u1", "admin")
    ).resolves.toEqual({ canViewAll: true, canManageAssignments: true });
  });

  it("viewers get read-all without a table read", async () => {
    const db = { from: () => { throw new Error("must not query"); } };
    await expect(
      resolveViewerCaps(db as never, "acc", "u1", "viewer")
    ).resolves.toEqual({ canViewAll: true, canManageAssignments: false });
  });

  it("agents get exactly their stored row", async () => {
    const db = fakeDb([
      { account_id: "acc", user_id: "u1", can_manage_assignments: true, can_view_all: false },
    ]);
    await expect(resolveViewerCaps(db as never, "acc", "u1", "agent")).resolves.toEqual({
      canViewAll: false,
      canManageAssignments: true,
    });
  });

  it("grants do not leak across accounts", async () => {
    const db = fakeDb([
      { account_id: "other-acct", user_id: "u1", can_manage_assignments: true, can_view_all: true },
    ]);
    await expect(resolveViewerCaps(db as never, "acc", "u1", "agent")).resolves.toEqual(
      NO_INBOX_CAPS
    );
  });

  it("missing rows and failures resolve to no caps (fail closed)", async () => {
    const empty = fakeDb([]);
    await expect(resolveViewerCaps(empty as never, "acc", "u1", "agent")).resolves.toEqual(
      NO_INBOX_CAPS
    );
    const broken = fakeDb(null, { message: "db down" });
    await expect(resolveViewerCaps(broken as never, "acc", "u1", "agent")).resolves.toEqual(
      NO_INBOX_CAPS
    );
    await expect(resolveViewerCaps(empty as never, "acc", null, "agent")).resolves.toEqual(
      NO_INBOX_CAPS
    );
  });

  it("isAgentOrAbove gates contact-initiated creation", () => {
    expect(isAgentOrAbove("owner")).toBe(true);
    expect(isAgentOrAbove("admin")).toBe(true);
    expect(isAgentOrAbove("agent")).toBe(true);
    expect(isAgentOrAbove("viewer")).toBe(false);
    expect(isAgentOrAbove(null)).toBe(false);
  });
});
