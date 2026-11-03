import { describe, expect, it } from "vitest";

import {
  adoptContactAssignmentForConversation,
  mirrorConversationAssignmentToWorkspace,
  mirrorRunAssignmentToConversation,
} from "./assignment-sync";

// Minimal thenable query stub: records the call chain, serves canned
// terminal results in order. Account-scoping is asserted via the
// recorded `eq:table:account_id=` entries.
interface Scripted {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

class FakeDb {
  log: string[] = [];
  writes: Array<{ op: string; table: string; values?: unknown; options?: unknown }> = [];
  private queue: Scripted[] = [];

  script(...responses: Scripted[]) {
    this.queue.push(...responses);
    return this;
  }

  from(table: string): FakeChain {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const take = (): { data: unknown; error: unknown } => {
      const r = db.queue.shift() ?? { data: null, error: null };
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const chain: FakeChain = {
      select: (cols: unknown) => {
        db.log.push(`select:${table}:${String(cols)}`);
        return chain;
      },
      eq: (k: unknown, v: unknown) => {
        db.log.push(`eq:${table}:${String(k)}=${String(v)}`);
        return chain;
      },
      order: (k: unknown, opts: unknown) => {
        db.log.push(`order:${table}:${String(k)}:${JSON.stringify(opts)}`);
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
      upsert: (values: unknown, options?: unknown) => {
        db.writes.push({ op: "upsert", table, values, options });
        return chain;
      },
      delete: () => {
        db.writes.push({ op: "delete", table });
        return chain;
      },
      // Helpers await bare chains (no terminal call); resolve from queue.
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        resolve(take()),
      maybeSingle: async () => take(),
      single: async () => take(),
    };
    return chain;
  }
}

interface FakeChain {
  select(cols: unknown): FakeChain;
  eq(k: unknown, v: unknown): FakeChain;
  order(k: unknown, opts: unknown): FakeChain;
  limit(n: unknown): FakeChain;
  update(values: unknown): FakeChain;
  upsert(values: unknown, options?: unknown): FakeChain;
  delete(): FakeChain;
  then(resolve: (v: { data: unknown; error: unknown }) => unknown): unknown;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
  single(): Promise<{ data: unknown; error: unknown }>;
}

const ok = (data: unknown = null) => ({ data, error: null });

describe("mirrorRunAssignmentToConversation (Workspace -> Inbox)", () => {
  it("writes a member UUID to the linked thread, account-scoped", async () => {
    const db = new FakeDb().script(
      ok({ contact_id: "ct-1" }),
      ok({ id: "conv-1" }),
      ok({})
    );
    const res = await mirrorRunAssignmentToConversation(
      db as never,
      "acc-1",
      "run-1",
      "11111111-1111-4111-8111-111111111111"
    );
    expect(res).toBe(true);
    expect(db.log).toContain("eq:flow_runs:account_id=acc-1");
    expect(db.log).toContain("eq:conversations:account_id=acc-1");
    const update = db.writes.find((w) => w.op === "update");
    expect(update?.table).toBe("conversations");
    expect(update?.values).toEqual({ assigned_agent_id: "11111111-1111-4111-8111-111111111111" });
  });

  it("maps Unassigned and legacy strings to NULL (UUID column safety)", async () => {
    for (const stored of ["Unassigned", "  Unassigned  ", "Some Old Name", null]) {
      const db = new FakeDb().script(
        ok({ contact_id: "ct-1" }),
        ok({ id: "conv-1" }),
        ok({})
      );
      const res = await mirrorRunAssignmentToConversation(
        db as never,
        "acc-1",
        "run-1",
        stored
      );
      expect(res).toBe(true);
      expect(db.writes.find((w) => w.op === "update")?.values).toEqual({
        assigned_agent_id: null,
      });
    }
  });

  it("is a no-op (true) when the run has no contact or no thread yet", async () => {
    const noContact = new FakeDb().script(ok({ contact_id: null }));
    expect(
      await mirrorRunAssignmentToConversation(noContact as never, "acc-1", "run-1", "11111111-1111-4111-8111-111111111111")
    ).toBe(true);
    expect(noContact.writes).toHaveLength(0);

    const noThread = new FakeDb().script(ok({ contact_id: "ct-1" }), ok(null));
    expect(
      await mirrorRunAssignmentToConversation(noThread as never, "acc-1", "run-1", "11111111-1111-4111-8111-111111111111")
    ).toBe(true);
    expect(noThread.writes).toHaveLength(0);
  });

  it("never throws: DB errors resolve false", async () => {
    const db = new FakeDb().script({ data: null, error: { message: "boom" } });
    await expect(
      mirrorRunAssignmentToConversation(db as never, "acc-1", "run-1", "11111111-1111-4111-8111-111111111111")
    ).resolves.toBe(false);
  });
});

describe("mirrorConversationAssignmentToWorkspace (Inbox -> Workspace)", () => {
  const runs = [
    { id: "run-old", flow_id: "flow-1", status: "completed", started_at: "2026-01-01T00:00:00Z" },
    { id: "run-new", flow_id: "flow-1", status: "active", started_at: "2026-02-01T00:00:00Z" },
  ];
  const fieldRows = [{ id: "field-1", name: "Assigned To" }];

  // Minimal findAssigneeField stub is internal; exercise through a db
  // whose workspace_fields select returns the field row.
  function dbWithRunAndField() {
    return new FakeDb().script(
      ok({ contact_id: "ct-1" }), // conversation lookup
      ok(runs), // flow_runs list
      ok(fieldRows) // workspace_fields lookup
    );
  }

  it("upserts the member id into the active run's Assigned To cell", async () => {
    const db = dbWithRunAndField().script(ok({}));
    const res = await mirrorConversationAssignmentToWorkspace(
      db as never,
      "acc-1",
      "conv-1",
      "11111111-1111-4111-8111-111111111111"
    );
    expect(res).toBe(true);
    const upsert = db.writes.find((w) => w.op === "upsert");
    expect(upsert?.table).toBe("workspace_values");
    expect(upsert?.values).toEqual({
      account_id: "acc-1",
      field_id: "field-1",
      flow_run_id: "run-new",
      value_text: "11111111-1111-4111-8111-111111111111",
    });
    // Account scoping rides in the upserted row itself.
    expect((upsert?.values as Record<string, unknown>)?.account_id).toBe(
      "acc-1"
    );
  });

  it("clears the cell (delete) when the thread is unassigned", async () => {
    const db = dbWithRunAndField().script(ok({}));
    const res = await mirrorConversationAssignmentToWorkspace(
      db as never,
      "acc-1",
      "conv-1",
      null
    );
    expect(res).toBe(true);
    const del = db.writes.find((w) => w.op === "delete");
    expect(del?.table).toBe("workspace_values");
    expect(db.writes.find((w) => w.op === "upsert")).toBeUndefined();
  });

  it("is a no-op when the contact has no runs or no Assigned To field", async () => {
    const noRuns = new FakeDb().script(ok({ contact_id: "ct-1" }), ok([]));
    expect(
      await mirrorConversationAssignmentToWorkspace(noRuns as never, "acc-1", "conv-1", "11111111-1111-4111-8111-111111111111")
    ).toBe(true);
    expect(noRuns.writes).toHaveLength(0);

    const noField = new FakeDb().script(ok({ contact_id: "ct-1" }), ok(runs), ok([]));
    expect(
      await mirrorConversationAssignmentToWorkspace(noField as never, "acc-1", "conv-1", "11111111-1111-4111-8111-111111111111")
    ).toBe(true);
    expect(noField.writes).toHaveLength(0);
  });
});

describe("adoptContactAssignmentForConversation (thread open)", () => {
  const runs = [
    { id: "run-1", status: "completed", started_at: "2026-01-01T10:00:00Z" },
  ];

  it("copies the contact's current owner onto the new thread", async () => {
    const db = new FakeDb().script(
      ok(runs),
      ok({ flow_id: "flow-1" }),
      ok([{ id: "field-1", name: "Assigned To" }]),
      ok({ value_text: "22222222-2222-4222-8222-222222222222" }),
      ok({})
    );
    const res = await adoptContactAssignmentForConversation(
      db as never,
      "acc-1",
      "ct-1",
      "conv-9"
    );
    expect(res).toBe(true);
    expect(db.writes.find((w) => w.op === "update")?.values).toEqual({
      assigned_agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("leaves the thread unassigned when the cell is Unassigned/cleared", async () => {
    for (const value_text of ["Unassigned", null]) {
      const db = new FakeDb().script(
        ok(runs),
        ok({ flow_id: "flow-1" }),
        ok([{ id: "field-1", name: "Assigned To" }]),
        ok(value_text ? { value_text } : null)
      );
      const res = await adoptContactAssignmentForConversation(
        db as never,
        "acc-1",
        "ct-1",
        "conv-9"
      );
      expect(res).toBe(true);
      expect(db.writes).toHaveLength(0);
    }
  });
});
