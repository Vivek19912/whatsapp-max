import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ensureVirtualFlow } from "./virtual-flow";

interface Row {
  [key: string]: unknown;
}

interface DbOptions {
  /** When set, the Nth (1-based) flow_nodes insert resolves with this error. */
  nodeInsertErrorAt?: number;
  nodeInsertError?: { code?: string };
}

/**
 * Minimal fake of the two tables `ensureVirtualFlow` touches. It
 * records node-write counts so tests can assert the "skip the rewrite
 * when the node set is unchanged" behaviour and the unique-violation
 * tolerance — without a real database.
 */
function makeDb(
  initialFlows: Row[],
  initialNodes: Record<string, Row[]>,
  options: DbOptions = {},
) {
  const flows = [...initialFlows];
  const nodes: Record<string, Row[]> = { ...initialNodes };
  const writes = { deletes: 0, inserts: 0 };
  let insertCount = 0;
  let seq = 0;

  function builder(table: string) {
    let op = "";
    let payload: unknown = null;
    const filters: Record<string, unknown> = {};

    const run = (): { data: unknown; error: unknown } => {
      if (table === "flows") {
        if (op === "select") {
          const match = flows.find((f) =>
            Object.entries(filters).every(([k, v]) => f[k] === v),
          );
          return { data: match ?? null, error: null };
        }
        if (op === "insert") {
          const row = { id: `flow-${++seq}`, ...(payload as Row) };
          flows.push(row);
          return { data: { id: row.id }, error: null };
        }
        if (op === "update") {
          const match = flows.find((f) =>
            Object.entries(filters).every(([k, v]) => f[k] === v),
          );
          if (match) Object.assign(match, payload as Row);
          return { data: null, error: null };
        }
      }
      if (table === "flow_nodes") {
        const fid = filters.flow_id as string;
        if (op === "select") {
          return {
            data: (nodes[fid] ?? []).map((n) => ({ node_key: n.node_key })),
            error: null,
          };
        }
        if (op === "delete") {
          writes.deletes++;
          nodes[fid] = [];
          return { data: null, error: null };
        }
        if (op === "insert") {
          writes.inserts++;
          insertCount++;
          if (
            options.nodeInsertError &&
            insertCount === options.nodeInsertErrorAt
          ) {
            return { data: null, error: options.nodeInsertError };
          }
          const rows = Array.isArray(payload) ? payload : [payload];
          const ownerFlowId = (rows[0] as Row)?.flow_id as string;
          nodes[ownerFlowId] = rows as Row[];
          return { data: null, error: null };
        }
      }
      return { data: null, error: null };
    };

    const b = {
      select() {
        if (!op) op = "select";
        return b;
      },
      insert(p: unknown) {
        op = "insert";
        payload = p;
        return b;
      },
      update(p: unknown) {
        op = "update";
        payload = p;
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return b;
      },
      maybeSingle() {
        return Promise.resolve(run());
      },
      single() {
        return Promise.resolve(run());
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    flows,
    nodes,
    writes,
  };
}

const FORM = {
  id: "form-row-1",
  form_id: "1234567890",
  form_name: "Summer Promo",
  questions: [{ key: "full_name", label: "Full Name" }],
};

function args(form = FORM) {
  return { accountId: "acct-1", ownerUserId: "user-1", form };
}

describe("ensureVirtualFlow", () => {
  it("creates the virtual flow + nodes on first enable", async () => {
    const { db, flows, nodes, writes } = makeDb([], {});
    const flowId = await ensureVirtualFlow(db, args());
    expect(flowId).toBe("flow-1");
    expect(flows).toHaveLength(1);
    expect(flows[0].kind).toBe("meta_lead_ads");
    expect(flows[0].status).toBe("archived");
    expect(writes.inserts).toBe(1);
    expect(writes.deletes).toBe(0);
    expect((nodes[flowId] ?? []).map((n) => n.node_key)).toContain("meta_source_node");
  });

  it("does NOT rewrite nodes when the question set is unchanged", async () => {
    const { db, writes } = makeDb([], {});
    await ensureVirtualFlow(db, args());
    await ensureVirtualFlow(db, args());
    await ensureVirtualFlow(db, args());
    // One insert, zero deletes — the hot per-lead path is a no-op.
    expect(writes.inserts).toBe(1);
    expect(writes.deletes).toBe(0);
  });

  it("rewrites nodes when the question set changes", async () => {
    const { db, nodes, writes } = makeDb([], {});
    const flowId = await ensureVirtualFlow(db, args());
    await ensureVirtualFlow(
      db,
      args({
        ...FORM,
        questions: [
          { key: "full_name", label: "Full Name" },
          { key: "phone", label: "Phone" },
        ],
      }),
    );
    expect(writes.deletes).toBe(1);
    expect(writes.inserts).toBe(2);
    expect((nodes[flowId] ?? []).map((n) => n.node_key)).toEqual([
      "meta_source_node",
      "meta_q_0_full_name",
      "meta_q_1_phone",
    ]);
  });

  it("tolerates a unique-violation race on the node insert", async () => {
    // Force a rewrite (changed questions) whose insert loses the race.
    const { db } = makeDb(
      [{ id: "flow-1", meta_form_id: FORM.id }],
      { "flow-1": [{ node_key: "stale" }] },
      { nodeInsertErrorAt: 1, nodeInsertError: { code: "23505" } },
    );
    await expect(ensureVirtualFlow(db, args())).resolves.toBe("flow-1");
  });

  it("still throws a non-unique node insert error", async () => {
    const { db } = makeDb(
      [{ id: "flow-1", meta_form_id: FORM.id }],
      { "flow-1": [{ node_key: "stale" }] },
      { nodeInsertErrorAt: 1, nodeInsertError: { code: "42P01" } },
    );
    await expect(ensureVirtualFlow(db, args())).rejects.toBeTruthy();
  });
});
