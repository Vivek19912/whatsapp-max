import { describe, expect, it } from "vitest";

import {
  countDistinctMetaTablesForContact,
  mirrorConversationAssignmentToWorkspace,
  mirrorRunAssignmentToConversation,
  adoptWorkspaceOwnerForConversation,
} from "./assignment-sync";

// Regression tests for the unified Workspace <-> Inbox ownership sync.
// Covers: multi-table convergence, membership guards, and the
// direction-aware no-loop guarantee.

interface Scripted {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

class FakeDb {
  log: string[] = [];
  writes: Array<{ op: string; table: string; values?: unknown }> = [];
  private queue: Scripted[] = [];

  script(...responses: Scripted[]) {
    this.queue.push(...responses);
    return this;
  }

  from(table: string): FakeChain {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const take = () => {
      const r = db.queue.shift() ?? { data: null, error: null };
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const chain: FakeChain = {
      select: (c: unknown) => {
        db.log.push(`select:${table}:${String(c)}`);
        return chain;
      },
      eq: (k: unknown, v: unknown) => {
        db.log.push(`eq:${table}:${String(k)}=${String(v)}`);
        return chain;
      },
      order: (k: unknown, o: unknown) => {
        db.log.push(`order:${table}:${String(k)}:${JSON.stringify(o)}`);
        return chain;
      },
      is: (k: unknown, v: unknown) => {
        db.log.push(`is:${table}:${String(k)}=${String(v)}`);
        return chain;
      },
      in: (k: unknown, v: unknown) => {
        db.log.push(`in:${table}:${String(k)}=${JSON.stringify(v)}`);
        return chain;
      },
      limit: (n: unknown) => {
        db.log.push(`limit:${table}:${String(n)}`);
        return chain;
      },
      update: (values: unknown) => {
        db.writes.push({ op: "update", table, values });
        return chain;
      },
      upsert: (values: unknown) => {
        db.writes.push({ op: "upsert", table, values });
        return chain;
      },
      delete: () => {
        db.writes.push({ op: "delete", table });
        return chain;
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        resolve(take()),
      maybeSingle: async () => take(),
      single: async () => take(),
    };
    return chain;
  }
}

interface FakeChain {
  select(c: unknown): FakeChain;
  eq(k: unknown, v: unknown): FakeChain;
  order(k: unknown, o: unknown): FakeChain;
  is(k: unknown, v: unknown): FakeChain;
  in(k: unknown, v: unknown): FakeChain;
  limit(n: unknown): FakeChain;
  update(v: unknown): FakeChain;
  upsert(v: unknown): FakeChain;
  delete(): FakeChain;
  then(r: (v: { data: unknown; error: unknown }) => unknown): unknown;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
  single(): Promise<{ data: unknown; error: unknown }>;
}

const ok = (data: unknown = null) => ({ data, error: null });
const MEMBER_A = "11111111-1111-4111-8111-111111111111";
const MEMBER_B = "22222222-2222-4222-8222-222222222222";

describe("unified ownership regression", () => {
  it("Inbox mirror refuses multi-table contacts (no bulk overwrite)", async () => {
    const runs = [
      { id: "run-1", flow_id: "flow-1", status: "active", started_at: "2026-01-01T00:00:00Z" },
      { id: "run-2", flow_id: "flow-2", status: "active", started_at: "2026-02-01T00:00:00Z" },
    ];
    const db = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ user_id: MEMBER_A }),
      ok(runs),
      ok([
        { id: "flow-1", kind: "meta_lead_ads" },
        { id: "flow-2", kind: "meta_lead_ads" },
      ]),
    );
    const res = await mirrorConversationAssignmentToWorkspace(
      db as never,
      "acc-1",
      "conv-1",
      MEMBER_A,
    );
    expect(res).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("Inbox reassignment converges a single Meta table", async () => {
    const runs = [
      { id: "run-1", flow_id: "flow-1", status: "active", started_at: "2026-01-01T00:00:00Z" },
      { id: "run-2", flow_id: "flow-1", status: "active", started_at: "2026-02-01T00:00:00Z" },
    ];
    const db = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ user_id: MEMBER_A }),
      ok(runs),
      ok([{ id: "flow-1", kind: "meta_lead_ads" }]),
      ok([{ id: "field-1", name: "Assigned To" }]),
      ok({}),
      ok({}),
    );
    const res = await mirrorConversationAssignmentToWorkspace(
      db as never,
      "acc-1",
      "conv-1",
      MEMBER_A,
    );
    expect(res).toBe(true);
    const upserts = db.writes.filter((w) => w.op === "upsert");
    expect(upserts).toHaveLength(2);
    for (const u of upserts) {
      expect((u.values as Record<string, unknown>).value_text).toBe(MEMBER_A);
    }
  });

  it("rejects removed/external users as owners", async () => {
    // Inbox -> Workspace with a non-member UUID: hard reject, no write.
    const db = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok(null), // not a live member
    );
    const res = await mirrorConversationAssignmentToWorkspace(
      db as never,
      "acc-1",
      "conv-1",
      MEMBER_B,
    );
    expect(res).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("Workspace -> Inbox clears when the stored owner left the team", async () => {
    // Stored UUID is no longer a live profile -> clear (NULL) instead of
    // orphaning the thread to a dead user.
    const db = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ id: "conv-1" }),
      ok(null), // membership miss
      ok({}),
    );
    const res = await mirrorRunAssignmentToConversation(
      db as never,
      "acc-1",
      "run-1",
      MEMBER_B,
    );
    expect(res).toBe(true);
    expect(db.writes.find((w) => w.op === "update")?.values).toEqual({
      assigned_agent_id: null,
    });
  });

  it("adopt refuses to write a stale owner", async () => {
    const runs = [
      { id: "run-1", flow_id: "flow-1", status: "active", started_at: "2026-01-01T00:00:00Z" },
    ];
    const db = new FakeDb().script(
      ok({ assigned_agent_id: null }),
      ok(runs),
      ok([{ id: "field-1", name: "Assigned To" }]),
      ok({ value_text: MEMBER_B }),
      ok(null), // stale: no live profile
    );
    const outcome = await adoptWorkspaceOwnerForConversation(
      db as never,
      "acc-1",
      "ct-1",
      "conv-9",
    );
    expect(outcome).toEqual({ adopted: false, reason: "no-owner" });
    expect(db.writes).toHaveLength(0);
  });

  it("mirrors are direction-aware (no update loops)", async () => {
    // Workspace -> Inbox writes ONLY conversations.
    const dbW = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ id: "conv-1" }),
      ok({ user_id: MEMBER_A }),
      ok({}),
    );
    await mirrorRunAssignmentToConversation(dbW as never, "acc-1", "run-1", MEMBER_A);
    expect(dbW.writes.every((w) => w.table === "conversations")).toBe(true);

    // Inbox -> Workspace writes ONLY workspace_values.
    const dbI = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ user_id: MEMBER_A }),
      ok([{ id: "run-1", flow_id: "flow-1", status: "active", started_at: "2026-01-01T00:00:00Z" }]),
      ok([{ id: "flow-1", kind: "meta_lead_ads" }]),
      ok([{ id: "field-1", name: "Assigned To" }]),
      ok({}),
    );
    await mirrorConversationAssignmentToWorkspace(dbI as never, "acc-1", "conv-1", MEMBER_A);
    expect(dbI.writes.every((w) => w.table === "workspace_values")).toBe(true);
  });
});

describe("countDistinctMetaTablesForContact (multi-table gate)", () => {
  it("counts zero when the contact has no runs", async () => {
    const db = new FakeDb().script(ok([]));
    const res = await countDistinctMetaTablesForContact(db as never, "acc-1", "ct-1");
    expect(res).toEqual({ count: 0, flowIds: [], error: false });
  });

  it("counts duplicate submissions in one table as ONE", async () => {
    const db = new FakeDb().script(
      ok([{ flow_id: "flow-1" }, { flow_id: "flow-1" }, { flow_id: "flow-1" }]),
      ok([{ id: "flow-1", kind: "meta_lead_ads" }]),
    );
    const res = await countDistinctMetaTablesForContact(db as never, "acc-1", "ct-1");
    expect(res).toEqual({ count: 1, flowIds: ["flow-1"], error: false });
  });

  it("ignores ordinary Flow tables", async () => {
    const db = new FakeDb().script(
      ok([{ flow_id: "flow-1" }, { flow_id: "flow-9" }]),
      ok([
        { id: "flow-1", kind: "meta_lead_ads" },
        { id: "flow-9", kind: "flow" },
      ]),
    );
    const res = await countDistinctMetaTablesForContact(db as never, "acc-1", "ct-1");
    expect(res).toEqual({ count: 1, flowIds: ["flow-1"], error: false });
  });

  it("counts two distinct Meta tables as TWO", async () => {
    const db = new FakeDb().script(
      ok([{ flow_id: "flow-1" }, { flow_id: "flow-2" }]),
      ok([
        { id: "flow-1", kind: "meta_lead_ads" },
        { id: "flow-2", kind: "meta_lead_ads" },
      ]),
    );
    const res = await countDistinctMetaTablesForContact(db as never, "acc-1", "ct-1");
    expect(res.count).toBe(2);
    expect(new Set(res.flowIds)).toEqual(new Set(["flow-1", "flow-2"]));
    expect(res.error).toBe(false);
  });

  it("fails safely on lookup errors", async () => {
    const db = new FakeDb().script({ data: null, error: { message: "boom" } });
    const res = await countDistinctMetaTablesForContact(db as never, "acc-1", "ct-1");
    expect(res.error).toBe(true);
  });
});
