// Per-salesperson WhatsApp sequences — key derivation, initial-vs-
// reassignment detection, persistence scoping, and idempotent
// enqueue. No production I/O; the Meta API is never touched.

import { describe, expect, it } from "vitest";

import { hasPriorAssignment } from "@/lib/lead-assignment/table-helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  listAssigneeSequenceKeys,
  loadAssigneeSequence,
  salespersonKeyFor,
  saveAssigneeSequence,
} from "./assignee-sequences";
import { maybeEnqueueAssigneeSequence } from "./queue";

type Row = Record<string, unknown>;

function makeDb(initial: Record<string, Row[]>) {
  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    data[table] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 1;

  type Filter = { col: string; op: string; val: unknown };
  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val;
      if (f.op === "neq") return row[f.col] !== f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      return true;
    });

  function builder(table: string) {
    const filters: Filter[] = [];
    const orders: string[] = [];
    let insertRows: Row[] | null = null;
    let updatePatch: Row | null = null;
    let deleteMode = false;
    const matched = () =>
      (data[table] ?? []).filter((r) => matches(r, filters));
    const ordered = (rows: Row[]) =>
      orders.length === 0
        ? rows
        : [...rows].sort((a, b) => {
            for (const col of orders) {
              const cmp = String(a[col] ?? "").localeCompare(
                String(b[col] ?? "")
              );
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
    const applyInsert = (rows: Row[]) => {
      const inserted: Row[] = [];
      for (const r of rows) {
        if (table === "meta_lead_whatsapp_queue") {
          const dup = (data[table] ?? []).some(
            (existing) =>
              existing.account_id === r.account_id &&
              existing.submission_id === r.submission_id &&
              existing.template_name === r.template_name &&
              (existing.template_language ?? "en_US") ===
                (r.template_language ?? "en_US")
          );
          if (dup) return { error: { code: "23505", message: "duplicate" } };
        }
        if (table === "meta_lead_assignee_sequence_items") {
          const dup = (data[table] ?? []).some(
            (existing) =>
              existing.sequence_id === r.sequence_id &&
              existing.template_name === r.template_name &&
              (existing.template_language ?? "en_US") ===
                (r.template_language ?? "en_US")
          );
          if (dup) return { error: { code: "23505", message: "duplicate" } };
        }
        const row = {
          id: `row-${idCounter++}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...r,
        };
        (data[table] ??= []).push(row);
        inserted.push(row);
      }
      return { inserted };
    };
    const b: Record<string, (...args: never[]) => unknown> = {
      select: (() => b) as never,
      eq: ((col: string, val: unknown) => {
        filters.push({ op: "eq", col, val });
        return b;
      }) as never,
      neq: ((col: string, val: unknown) => {
        filters.push({ op: "neq", col, val });
        return b;
      }) as never,
      in: ((col: string, val: unknown) => {
        filters.push({ op: "in", col, val });
        return b;
      }) as never,
      order: ((col: string) => {
        orders.push(col);
        return b;
      }) as never,
      limit: (() => b) as never,
      insert: ((rows: Row | Row[]) => {
        insertRows = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
        return b;
      }) as never,
      update: ((patch: Row) => {
        updatePatch = patch;
        return b;
      }) as never,
      delete: (() => {
        deleteMode = true;
        return b;
      }) as never,
      maybeSingle: (async () => {
        if (insertRows) {
          const out = applyInsert(insertRows);
          if ("error" in out) return { data: null, error: out.error };
          return { data: out.inserted[0] ?? null, error: null };
        }
        if (updatePatch) {
          const list = matched();
          for (const r of list) Object.assign(r, updatePatch);
          return { data: list[0] ?? null, error: null };
        }
        if (deleteMode) {
          const list = matched();
          for (const r of list) {
            const arr = data[table] ?? [];
            arr.splice(arr.indexOf(r), 1);
          }
          return { data: list[0] ?? null, error: null };
        }
        return { data: ordered(matched())[0] ?? null, error: null };
      }) as never,
      single: (async () => {
        if (insertRows) {
          const out = applyInsert(insertRows);
          if ("error" in out) return { data: null, error: out.error };
          return { data: out.inserted[0] ?? null, error: null };
        }
        return { data: ordered(matched())[0] ?? null, error: null };
      }) as never,
      then: ((res: (v: unknown) => unknown) => {
        if (insertRows) {
          const out = applyInsert(insertRows);
          if ("error" in out) return Promise.resolve({ data: null, error: out.error }).then(res);
          return Promise.resolve({ data: out.inserted, error: null }).then(res);
        }
        if (updatePatch) {
          const list = matched();
          for (const r of list) Object.assign(r, updatePatch);
          return Promise.resolve({ data: list, error: null }).then(res);
        }
        if (deleteMode) {
          const list = matched();
          for (const r of list) {
            const arr = data[table] ?? [];
            arr.splice(arr.indexOf(r), 1);
          }
          return Promise.resolve({ data: list, error: null }).then(res);
        }
        return Promise.resolve({ data: ordered(matched()), error: null }).then(res);
      }) as never,
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
  } as unknown as SupabaseClient;
  return { db, data };
}

describe("salespersonKeyFor", () => {
  it("prefers the internal user id", () => {
    expect(salespersonKeyFor({ user_id: "u-1" })).toBe("user:u-1");
    expect(salespersonKeyFor({ user_id: "  u-1  ", email: "a@x.com" })).toBe(
      "user:u-1"
    );
  });

  it("falls back to normalized email, then digits-only phone", () => {
    expect(salespersonKeyFor({ email: "Asha@Example.COM " })).toBe(
      "email:asha@example.com"
    );
    expect(salespersonKeyFor({ phone: "+91 88856 38563" })).toBe(
      "phone:918885638563"
    );
  });

  it("returns null when nothing usable identifies the salesperson", () => {
    expect(salespersonKeyFor({})).toBeNull();
    expect(salespersonKeyFor({ user_id: "  ", email: "", phone: "abc" })).toBeNull();
    expect(salespersonKeyFor({ user_id: null, email: null })).toBeNull();
  });
});

describe("hasPriorAssignment", () => {
  function eventsDb(rows: Row[]) {
    return makeDb({ lead_assignment_events: rows }).db;
  }

  it("is false with no events", async () => {
    expect(await hasPriorAssignment(eventsDb([]) as never, "acct-1", "run-1")).toBe(false);
  });

  it("is true for a prior auto or manual assignment", async () => {
    const db = eventsDb([
      { account_id: "acct-1", flow_run_id: "run-1", kind: "auto", assigned_user_id: "u-1", previous_user_id: null, reason: "round_robin" },
    ]);
    expect(await hasPriorAssignment(db as never, "acct-1", "run-1")).toBe(true);
    const db2 = eventsDb([
      { account_id: "acct-1", flow_run_id: "run-1", kind: "manual", assigned_user_id: "u-2", previous_user_id: null },
    ]);
    expect(await hasPriorAssignment(db2 as never, "acct-1", "run-1")).toBe(true);
  });

  it("is true for external auto-assignments and manual clears of a previous owner", async () => {
    const external = eventsDb([
      { account_id: "acct-1", flow_run_id: "run-1", kind: "auto", assigned_user_id: null, previous_user_id: null, reason: "external-notification" },
    ]);
    expect(await hasPriorAssignment(external as never, "acct-1", "run-1")).toBe(true);
    const cleared = eventsDb([
      { account_id: "acct-1", flow_run_id: "run-1", kind: "manual", assigned_user_id: null, previous_user_id: "u-1" },
    ]);
    expect(await hasPriorAssignment(cleared as never, "acct-1", "run-1")).toBe(true);
  });

  it("ignores unassigned, cleared-empty, and other-run events", async () => {
    const db = eventsDb([
      { account_id: "acct-1", flow_run_id: "run-1", kind: "unassigned", assigned_user_id: null, previous_user_id: null, reason: "no-eligible-assignees" },
      { account_id: "acct-1", flow_run_id: "run-1", kind: "manual", assigned_user_id: null, previous_user_id: null },
      { account_id: "acct-1", flow_run_id: "run-1", kind: "manual", assigned_user_id: "Unassigned", previous_user_id: null },
      { account_id: "acct-1", flow_run_id: "other-run", kind: "auto", assigned_user_id: "u-9", previous_user_id: null, reason: "round_robin" },
      { account_id: "acct-2", flow_run_id: "run-1", kind: "auto", assigned_user_id: "u-9", previous_user_id: null, reason: "round_robin" },
    ]);
    expect(await hasPriorAssignment(db as never, "acct-1", "run-1")).toBe(false);
  });
});

describe("assignee sequence persistence", () => {
  const item = (name: string, position: number, over: Partial<Record<string, unknown>> = {}) => ({
    template_name: name,
    template_language: "en_US",
    position,
    variable_mappings: {},
    ...over,
  });

  it("saves and reloads a sequence with order preserved", async () => {
    const { db } = makeDb({});
    const saved = await saveAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      key: "user:u-asha",
      delay_seconds: 30,
      items: [item("b", 1), item("a", 0)],
    });
    expect(saved.delay_seconds).toBe(30);
    expect(saved.items.map((t) => t.template_name)).toEqual(["a", "b"]);
    const loaded = await loadAssigneeSequence(db as never, "acct-1", "form-1", "user:u-asha");
    expect(loaded?.delay_seconds).toBe(30);
    expect(loaded?.items.map((t) => [t.template_name, t.position])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("replaces (never duplicates) on re-save and deletes on empty", async () => {
    const { db, data } = makeDb({});
    await saveAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      key: "user:u-asha",
      delay_seconds: 0,
      items: [item("a", 0)],
    });
    await saveAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      key: "user:u-asha",
      delay_seconds: 10,
      items: [item("b", 0)],
    });
    expect(data.meta_lead_assignee_sequences).toHaveLength(1);
    expect(
      (data.meta_lead_assignee_sequence_items ?? []).map((r) => r.template_name)
    ).toEqual(["b"]);
    await saveAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      key: "user:u-asha",
      delay_seconds: 0,
      items: [],
    });
    expect(data.meta_lead_assignee_sequences).toHaveLength(0);
    expect(data.meta_lead_assignee_sequence_items ?? []).toHaveLength(0);
    expect(await loadAssigneeSequence(db as never, "acct-1", "form-1", "user:u-asha")).toBeNull();
  });

  it("isolates sequences by account, form, and salesperson", async () => {
    const { db } = makeDb({});
    const base = { delay_seconds: 0, items: [item("a", 0)] };
    await saveAssigneeSequence(db as never, { accountId: "acct-1", formId: "form-1", key: "user:u-1", ...base });
    await saveAssigneeSequence(db as never, { accountId: "acct-1", formId: "form-1", key: "user:u-2", ...base });
    await saveAssigneeSequence(db as never, { accountId: "acct-1", formId: "form-2", key: "user:u-1", ...base });
    await saveAssigneeSequence(db as never, { accountId: "acct-2", formId: "form-1", key: "user:u-1", ...base });
    const { listAssigneeSequenceKeys } = await import("./assignee-sequences");
    expect(await listAssigneeSequenceKeys(db as never, "acct-1", "form-1")).toEqual(
      expect.arrayContaining(["user:u-1", "user:u-2"])
    );
    expect(await listAssigneeSequenceKeys(db as never, "acct-1", "form-1")).toHaveLength(2);
    expect(await listAssigneeSequenceKeys(db as never, "acct-1", "form-2")).toEqual(["user:u-1"]);
    expect(await loadAssigneeSequence(db as never, "acct-1", "form-1", "user:nope")).toBeNull();
    expect(await loadAssigneeSequence(db as never, "acct-9", "form-1", "user:u-1")).toBeNull();
  });
});

describe("maybeEnqueueAssigneeSequence", () => {
  const NOW = Date.now();
  const submission = {
    id: "sub-1",
    account_id: "acct-1",
    meta_lead_id: "lead-1",
    flow_run_id: "run-1",
    form_id: "form-1",
    contact_id: "contact-1",
  };

  function seqDb(extra: Record<string, Row[]> = {}) {
    return makeDb({
      meta_lead_submissions: [submission],
      meta_lead_assignee_sequences: [
        { id: "seq-1", account_id: "acct-1", form_id: "form-1", salesperson_key: "user:u-asha", delay_seconds: 60 },
      ],
      meta_lead_assignee_sequence_items: [
        { id: "si-1", sequence_id: "seq-1", template_name: "hello", template_language: "en_US", position: 1, variable_mappings: {} },
        { id: "si-2", sequence_id: "seq-1", template_name: "offer", template_language: "en_US", position: 0, variable_mappings: {} },
      ],
      meta_lead_whatsapp_queue: [],
      ...extra,
    });
  }

  it("skips without a sequence, submission, or form", async () => {
    const { maybeEnqueueAssigneeSequence } = await import("./queue");
    expect(
      await maybeEnqueueAssigneeSequence(seqDb().db as never, {
        accountId: "acct-1",
        formId: "form-1",
        flowRunId: "run-1",
        assigneeKey: "user:nobody",
      })
    ).toMatchObject({ enqueued: 0, skipped: true, skipReason: "no-sequence" });
    expect(
      await maybeEnqueueAssigneeSequence(seqDb().db as never, {
        accountId: "acct-1",
        formId: "form-1",
        flowRunId: "missing-run",
        assigneeKey: "user:u-asha",
      })
    ).toMatchObject({ enqueued: 0, skipped: true, skipReason: "no-submission" });
    expect(
      await maybeEnqueueAssigneeSequence(seqDb().db as never, {
        accountId: "acct-1",
        formId: null,
        flowRunId: "run-1",
        assigneeKey: "user:u-asha",
      })
    ).toMatchObject({ enqueued: 0, skipped: true, skipReason: "no-sequence" });
  });

  it("enqueues the salesperson's items with assignee key and staggered delays", async () => {
    const { maybeEnqueueAssigneeSequence } = await import("./queue");
    const { db, data } = seqDb();
    const out = await maybeEnqueueAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      submissionId: "sub-1",
      assigneeKey: "user:u-asha",
    });
    expect(out).toMatchObject({ enqueued: 2, alreadyQueued: 0, skipped: false });
    const rows = data.meta_lead_whatsapp_queue;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.assignee_key).toBe("user:u-asha");
    const byName = Object.fromEntries(rows.map((r) => [r.template_name, r]));
    expect(byName.offer.position).toBe(0);
    expect(byName.hello.position).toBe(1);
    // 60s delay: second item is due ~60s after the first.
    expect(Date.parse(byName.hello.scheduled_for as string) - Date.parse(byName.offer.scheduled_for as string)).toBe(60_000);
  });

  it("dedupes repeat enqueue calls via the queue unique key", async () => {
    const { maybeEnqueueAssigneeSequence } = await import("./queue");
    const { db, data } = seqDb();
    const first = await maybeEnqueueAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      submissionId: "sub-1",
      assigneeKey: "user:u-asha",
    });
    expect(first.enqueued).toBe(2);
    const second = await maybeEnqueueAssigneeSequence(db as never, {
      accountId: "acct-1",
      formId: "form-1",
      submissionId: "sub-1",
      assigneeKey: "user:u-asha",
    });
    expect(second).toMatchObject({ enqueued: 0, alreadyQueued: 2 });
    expect(data.meta_lead_whatsapp_queue).toHaveLength(2);
  });
});
