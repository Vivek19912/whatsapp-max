// Meta Conversions API — shared status-change trigger helper.
//
// Pins the trigger contract used by every status-write path:
//   * unchanged values never trigger;
//   * cleared values never trigger;
//   * genuine changes evaluate exactly one trigger with from → to context.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fires: [] as Array<Record<string, unknown>>,
}));

vi.mock("./deliver", () => ({
  fireCapiForAction: async (
    _db: unknown,
    _platform: unknown,
    event: Record<string, unknown>,
  ) => {
    h.fires.push(event);
    return { fired: 1, failed: 0, skipped: 0 };
  },
}));

vi.mock("@/lib/meta-lead-ads/config", () => ({
  metaGraphVersion: () => "v26.0",
}));

const { recordWorkspaceStatusChanged } = await import("./triggers");

const db = {
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              phone: "+15551234567",
              name: "Rahul Sharma",
              email: "a@b.co",
              ctwa_clid: null,
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
} as unknown as SupabaseClient;

beforeEach(() => {
  h.fires = [];
});

describe("recordWorkspaceStatusChanged", () => {
  it("triggers once for a genuine change with from → to context", async () => {
    const triggered = await recordWorkspaceStatusChanged(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
      contactId: "c-1",
      fieldName: "Stage",
      previousValue: "New Lead",
      newValue: "Qualified",
    });

    expect(triggered).toBe(true);
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]).toMatchObject({
      accountId: "acct-1",
      action: "workspace_field_changed",
      flowRunId: "run-1",
      fieldName: "Stage",
      value: "Qualified",
      previousValue: "New Lead",
    });
  });

  it("does not trigger for an unchanged save", async () => {
    const triggered = await recordWorkspaceStatusChanged(db, {
      accountId: "acct-1",
      flowRunId: "run-1",
      fieldName: "Stage",
      previousValue: "Qualified",
      newValue: "Qualified",
    });

    expect(triggered).toBe(false);
    expect(h.fires).toHaveLength(0);
  });

  it("does not trigger when the status is cleared", async () => {
    for (const cleared of [null, ""]) {
      const triggered = await recordWorkspaceStatusChanged(db, {
        accountId: "acct-1",
        flowRunId: "run-1",
        fieldName: "Stage",
        previousValue: "Qualified",
        newValue: cleared,
      });
      expect(triggered).toBe(false);
    }
    expect(h.fires).toHaveLength(0);
  });
});
