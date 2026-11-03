import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyVisibility,
  customFieldVisId,
  describeVisibilityMenu,
  flattenVisibilityMenu,
  toggleHiddenId,
} from "./workspace-visibility";
import type { WorkspaceField } from "./workspace-fields";
import {
  WORKSPACE_DEFAULT_FIELDS,
  CALLS_TRIED_OPTIONS,
  QUOTATION_OPTIONS,
  LEAD_TYPE_OPTIONS,
  STAGE_OPTIONS,
  LEAD_RECEIVED_OPTIONS,
  ensureWorkspaceDefaultFields,
  defaultBusinessValue,
  isLeadReceivedField,
  isLeadTypeField,
  isStageField,
  isWorkspaceDefaultName,
  orderBusinessColumns,
  receivedDefaultLabel,
} from "./workspace-defaults";
import { validateWorkspaceValue } from "./workspace-fields";

// ---------------------------------------------------------------------------
// Proof tests: Workspace default business columns (Assigned To … Final
// Remark). Provisioning writes ONLY workspace_fields rows — Sheets,
// flows, values, and unrelated architecture are never touched.
// ---------------------------------------------------------------------------

interface FakeStore {
  rows: Array<{ id?: string; name: string; position: number; options?: string[] | null }>;
  tablesTouched: string[];
  eqFilters: Array<[string, unknown]>;
  inserts: Array<Record<string, unknown>[]>;
  updates: Array<{ patch: Record<string, unknown>; id: string | null }>;
  insertError: { code?: string; message: string } | null;
  updateError: { code?: string; message: string } | null;
  failRead: boolean;
}

function fakeClient(store: FakeStore): SupabaseClient {
  const client = {
    from: (table: string) => {
      store.tablesTouched.push(table);
      return {
        select: () => ({
          eq: (col: string, val: unknown) => {
            store.eqFilters.push([col, val]);
            return {
              eq: async (col2: string, val2: unknown) => {
                store.eqFilters.push([col2, val2]);
                if (store.failRead) {
                  return { data: null, error: { message: "read failed" } };
                }
                return { data: store.rows, error: null };
              },
            };
          },
        }),
        insert: async (newRows: Array<Record<string, unknown>>) => {
          store.inserts.push(newRows);
          if (store.insertError) {
            return { data: null, error: store.insertError };
          }
          return { data: newRows, error: null };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (col: string, val: unknown) => {
            store.eqFilters.push([col, val]);
            const id = col === "id" ? String(val) : null;
            store.updates.push({ patch, id });
            if (store.updateError) {
              return { data: null, error: store.updateError };
            }
            return { data: null, error: null };
          },
        }),
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function newStore(
  rows: Array<{ id?: string; name: string; position: number; options?: string[] | null }> = [],
): FakeStore {
  return {
    rows,
    tablesTouched: [],
    eqFilters: [],
    inserts: [],
    updates: [],
    insertError: null,
    updateError: null,
    failRead: false,
  };
}

/** Default-shaped WorkspaceField rows for visibility tests. */
function defaultFields(): WorkspaceField[] {
  return WORKSPACE_DEFAULT_FIELDS.map((spec, i) => ({
    id: `f-default-${i + 1}`,
    account_id: "acct-1",
    flow_id: "flow-1",
    name: spec.name,
    field_type: spec.field_type,
    position: i,
    options: spec.options,
    default_value: null,
    currency_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));
}

/** Read the 096 conversion migration for content assertions. */
function readMigration096(): string {
  return readFileSync(
    `${process.cwd()}/supabase/migrations/096_workspace_default_select_fields.sql`,
    "utf8",
  );
}

describe("default business column spec", () => {
  it("defines exactly the 13 required columns in order", () => {
    expect(WORKSPACE_DEFAULT_FIELDS.map((f) => f.name)).toEqual([
      "Assigned To",
      "Call Status",
      "No. of Calls Tried",
      "Lead Type",
      "Stage",
      "Follow-Up Status",
      "Last Contact Date",
      "Customer Response",
      "Next Follow-up Date & Time",
      "Next Action",
      "Reason for Lost Lead",
      "Final Remark",
      "Lead Received",
    ]);
  });

  it("uses the required field types", () => {
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Assigned To")?.field_type).toBe("single_select");
    expect(byName.get("Call Status")?.field_type).toBe("single_select");
    expect(byName.get("No. of Calls Tried")?.field_type).toBe("single_select");
    expect(byName.get("Lead Type")?.field_type).toBe("single_select");
    expect(byName.get("Stage")?.field_type).toBe("single_select");
    expect(byName.get("Follow-Up Status")?.field_type).toBe("single_select");
    expect(byName.get("Last Contact Date")?.field_type).toBe("date");
    expect(byName.get("Customer Response")?.field_type).toBe("text");
    expect(byName.get("Next Follow-up Date & Time")?.field_type).toBe(
      "datetime",
    );
    expect(byName.get("Next Action")?.field_type).toBe("text");
    expect(byName.get("Reason for Lost Lead")?.field_type).toBe(
      "single_select",
    );
    expect(byName.get("Final Remark")?.field_type).toBe("text");
    expect(byName.get("Lead Received")?.field_type).toBe("single_select");
  });

  it("carries the exact business options for select columns", () => {
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Call Status")?.options).toEqual([
      "Connected",
      "Not Answering",
      "Switched Off",
      "Busy",
      "Call Back Later",
      "Invalid Number",
    ]);
    expect(byName.get("No. of Calls Tried")?.options).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    expect(byName.get("Lead Type")?.options).toEqual([
      "Fresh",
      "Hot",
      "Warm",
      "Cold",
      "Prospect",
    ]);
    expect(byName.get("Stage")?.options).toEqual([
      "New Lead",
      "Contacted",
      "Qualified",
      "Quotation Required",
      "Quotation Sent",
      "In Negotiation",
      "Ready To Book",
      "Booking Confirmed",
      "Follow Up",
      "Amendment",
      "Lost",
      "Cancelled",
      "Invalid",
      "On Hold",
      "Not connected",
    ]);
    expect(byName.get("Lead Received")?.options).toEqual([
      "Website",
      "Social Media",
      "Facebook Ads",
      "Instagram Ads",
      "Google Ads",
      "Whatsapp",
      "Phone Call",
      "Referral",
      "Walk In",
      "Repeat Customer",
      "Partner",
      "Other",
    ]);
    expect(byName.get("Follow-Up Status")?.options).toEqual([
      "Follow-up Pending",
      "Negotiation Going On",
      "Booked",
      "Lost",
      "No Plan",
    ]);
    expect(byName.get("Reason for Lost Lead")?.options).toEqual([
      "Budget Issue",
      "No Response",
      "Already Booked Elsewhere",
      "Date Issue",
      "Just Inquiry",
      "Travel Cancelled",
    ]);
    // Non-select columns take no options (validator rejects them).
    for (const name of [
      "Last Contact Date",
      "Customer Response",
      "Next Follow-up Date & Time",
      "Next Action",
      "Final Remark",
    ]) {
      expect(byName.get(name)?.options).toBeNull();
    }
  });

  it("1/2. No. of Calls Tried is single-select with exactly 1–10", () => {
    expect([...CALLS_TRIED_OPTIONS]).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("No. of Calls Tried")).toMatchObject({
      field_type: "single_select",
      options: [...CALLS_TRIED_OPTIONS],
    });
  });

  it("Lead Type is single-select with exactly the 5 options", () => {
    expect([...LEAD_TYPE_OPTIONS]).toEqual([
      "Fresh",
      "Hot",
      "Warm",
      "Cold",
      "Prospect",
    ]);
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Lead Type")).toMatchObject({
      field_type: "single_select",
      options: [...LEAD_TYPE_OPTIONS],
    });
  });

  it("Stage is single-select with exactly the 15 options", () => {
    expect([...STAGE_OPTIONS]).toEqual([
      "New Lead",
      "Contacted",
      "Qualified",
      "Quotation Required",
      "Quotation Sent",
      "In Negotiation",
      "Ready To Book",
      "Booking Confirmed",
      "Follow Up",
      "Amendment",
      "Lost",
      "Cancelled",
      "Invalid",
      "On Hold",
      "Not connected",
    ]);
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Stage")).toMatchObject({
      field_type: "single_select",
      options: [...STAGE_OPTIONS],
    });
  });

  it("Lead Received is single-select with exactly the 12 options", () => {
    expect([...LEAD_RECEIVED_OPTIONS]).toEqual([
      "Website",
      "Social Media",
      "Facebook Ads",
      "Instagram Ads",
      "Google Ads",
      "Whatsapp",
      "Phone Call",
      "Referral",
      "Walk In",
      "Repeat Customer",
      "Partner",
      "Other",
    ]);
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Lead Received")).toMatchObject({
      field_type: "single_select",
      options: [...LEAD_RECEIVED_OPTIONS],
    });
  });
  });

  it("3/6. arbitrary text cannot be entered in either dropdown", () => {
    const callsOpts = [...CALLS_TRIED_OPTIONS];
    expect(validateWorkspaceValue("single_select", callsOpts, "5")).toBe("5");
    for (const bad of ["abc", "0", "11", "3.5", "five", ""]) {
      if (bad === "") {
        // Empty clears the cell (deletes the row) — still no text stored.
        expect(validateWorkspaceValue("single_select", callsOpts, bad)).toBeNull();
      } else {
        expect(() =>
          validateWorkspaceValue("single_select", callsOpts, bad),
        ).toThrow();
      }
    }
    const quoteOpts = [...QUOTATION_OPTIONS];
    expect(validateWorkspaceValue("single_select", quoteOpts, "Sent")).toBe("Sent");
    expect(validateWorkspaceValue("single_select", quoteOpts, "Not Yet")).toBe(
      "Not Yet",
    );
    for (const bad of ["maybe", "sent", "SENT", "Pending", "Yes"]) {
      expect(() =>
        validateWorkspaceValue("single_select", quoteOpts, bad),
      ).toThrow();
    }
  });

  it("9. existing valid values validate through unchanged", () => {
    // Pre-existing numeric entries 1–10 already store in the exact
    // option form, so conversion preserves them byte-for-byte.
    for (const v of ["1", "7", "10"]) {
      expect(
        validateWorkspaceValue("single_select", [...CALLS_TRIED_OPTIONS], v),
      ).toBe(v);
    }
    for (const v of ["Sent", "Not Yet"]) {
      expect(
        validateWorkspaceValue("single_select", [...QUOTATION_OPTIONS], v),
      ).toBe(v);
    }
  });

  it("7/8/10. provisioning writes the converted specs once per flow (both views share them)", async () => {
    const store = newStore();
    await ensureWorkspaceDefaultFields(fakeClient(store), "acct-1", "flow-1");
    const rows = store.inserts[0];
    // Still exactly 13 names — no duplicates added.
    expect(rows.map((r) => r.name)).toEqual(
      WORKSPACE_DEFAULT_FIELDS.map((f) => f.name),
    );
    expect(new Set(rows.map((r) => r.name)).size).toBe(13);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("No. of Calls Tried")).toMatchObject({
      field_type: "single_select",
      options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    });
    expect(byName.get("Stage")).toMatchObject({
      field_type: "single_select",
      options: [...STAGE_OPTIONS],
    });
    expect(byName.get("Lead Type")).toMatchObject({
      field_type: "single_select",
      options: [...LEAD_TYPE_OPTIONS],
    });
    expect(byName.get("Lead Received")).toMatchObject({
      field_type: "single_select",
      options: [...LEAD_RECEIVED_OPTIONS],
    });
    // Completed and Incomplete are views over these SAME rows:
    // provisioning touches only workspace_fields, never per-view data.
    expect(new Set(store.tablesTouched)).toEqual(new Set(["workspace_fields"]));
  });

  it("migration 096 converts types safely and reports instead of destroying", () => {
    const sql = readMigration096();    // Converts ONLY rows still on the old types (idempotent reruns
    // match zero rows); user-owned single_selects are untouched.
    expect(sql).toContain("AND field_type = 'number'::workspace_field_type");
    expect(sql).toContain("AND field_type = 'text'::workspace_field_type");
    expect(sql).toContain("SET field_type = 'single_select'::workspace_field_type");
    // Exact option payloads.
    expect(sql).toContain(
      `'["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]'::jsonb`,
    );
    expect(sql).toContain(`'["Sent", "Not Yet"]'::jsonb`);
    // Values are never written or deleted — only counted/sampled.
    expect(sql).not.toMatch(/UPDATE\s+workspace_values/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+workspace_values/i);
    expect(sql).toContain("RAISE NOTICE");
    expect(sql).toContain("preserved as-is (not rewritten)");
  });

  it("11. Google Sheets is unaffected by the conversion", () => {
    // Sheets derives columns from flow nodes only; it never reads
    // workspace_fields / workspace_values (migration 088 contract).
    for (const rel of [
      "src/app/api/flows/[id]/sheet/route.ts",
      "src/app/api/flows/[id]/incomplete-sheet/route.ts",
      "src/lib/flows/sheet-columns.ts",
    ]) {
      const src = readFileSync(`${process.cwd()}/${rel}`, "utf8");
      expect(src).not.toContain("workspace_fields");
      expect(src).not.toContain("workspace_values");
      expect(src).not.toContain("No. of Calls Tried");
      expect(src).not.toContain("Quotation / Package");
    }
  });

  it("recognizes default names deterministically (case-insensitive)", () => {
    expect(isWorkspaceDefaultName("Call Status")).toBe(true);
    expect(isWorkspaceDefaultName("  call status ")).toBe(true);
    expect(isWorkspaceDefaultName("Lead Type")).toBe(true);
    expect(isWorkspaceDefaultName("Stage")).toBe(true);
    expect(isWorkspaceDefaultName("Lead Received")).toBe(true);
    // Renamed-away legacy names are no longer defaults.
    expect(isWorkspaceDefaultName("Lead Quality")).toBe(false);
    expect(isWorkspaceDefaultName("Quotation / Package")).toBe(false);
    expect(isWorkspaceDefaultName("My Custom Column")).toBe(false);
    expect(isWorkspaceDefaultName(null)).toBe(false);
  });

  it("identifies the Lead Received field and its ad-platform default", () => {
    expect(isLeadReceivedField({ name: "Lead Received" })).toBe(true);
    expect(isLeadReceivedField({ name: "  lead received " })).toBe(true);
    expect(isLeadReceivedField({ name: "Lead Type" })).toBe(false);
    expect(receivedDefaultLabel("facebook")).toBe("Facebook Ads");
    expect(receivedDefaultLabel("instagram")).toBe("Instagram Ads");
    expect(receivedDefaultLabel(null)).toBeNull();
    expect(receivedDefaultLabel("other")).toBeNull();
    expect(receivedDefaultLabel(undefined)).toBeNull();
  });

describe("ensureWorkspaceDefaultFields", () => {
  it("1. provisions all 13 defaults for a new flow (positions 0–12)", async () => {
    const store = newStore();
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.created).toHaveLength(13);
    expect(res.renamed).toEqual([]);
    expect(store.inserts).toHaveLength(1);
    const rows = store.inserts[0];
    expect(rows.map((r) => r.name)).toEqual(
      WORKSPACE_DEFAULT_FIELDS.map((f) => f.name),
    );
    expect(rows.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const row of rows) {
      expect(row.account_id).toBe("acct-1");
      expect(row.flow_id).toBe("flow-1");
      // Type/Stage carry their display defaults on newly inserted
      // rows only; every other default keeps default_value null.
      const expected =
        row.name === "Lead Type"
          ? "Fresh"
          : row.name === "Stage"
            ? "New Lead"
            : null;
      expect(row.default_value).toBe(expected);
      expect(row.currency_code).toBeNull();
    }
    // No duplicate option payloads: single bulk insert.
    expect(rows).toHaveLength(13);
  });

  it("10. is idempotent — a second call creates nothing", async () => {
    const store = newStore();
    const client = fakeClient(store);
    await ensureWorkspaceDefaultFields(client, "acct-1", "flow-1");
    // Simulate the rows now existing.
    store.rows = WORKSPACE_DEFAULT_FIELDS.map((f, i) => ({
      name: f.name,
      position: i,
    }));
    store.inserts = [];
    const res = await ensureWorkspaceDefaultFields(client, "acct-1", "flow-1");
    expect(res.created).toEqual([]);
    expect(store.inserts).toHaveLength(0);
  });

  it("9/11. keeps existing custom fields intact and appends after them", async () => {
    const store = newStore([
      { name: "My Tracker", position: 0 },
      { name: "VIP Flag", position: 4 },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.created).toHaveLength(13);
    const rows = store.inserts[0];
    // Appended after the current max position — existing order kept.
    expect(rows[0].position).toBe(5);
    expect(rows[12].position).toBe(17);
  });

  it("10. never duplicates a user field sharing a default name", async () => {
    const store = newStore([
      { name: "Call Status", position: 0 },
      { name: "  Lead Type  ", position: 1 },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Two suppressed, eleven created — the user's own rows untouched
    // (provisioning only inserts; it never updates or deletes).
    expect(res.created).toHaveLength(11);
    expect(res.created).not.toContain("Call Status");
    expect(res.created).not.toContain("Lead Type");
    expect(store.inserts[0]).toHaveLength(11);
    expect(store.updates).toHaveLength(0);
  });

  it("renames legacy Lead Quality in place, preserving id and values", async () => {
    const store = newStore([
      { id: "f-old", name: "Lead Quality", position: 3, options: ["Hot", "Warm", "Cold", "Fake"] },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Renamed, not re-inserted: one update, and "Lead Type" is not
    // among the inserts.
    expect(res.renamed).toEqual(["Lead Type"]);
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      id: "f-old",
      patch: { name: "Lead Type", options: [...LEAD_TYPE_OPTIONS] },
    });
    expect(res.created).not.toContain("Lead Type");
    // Stored values live in workspace_values (untouched here) and
    // stay readable — even "Fake", outside the new options.
  });

  it("renames legacy Quotation / Package in place", async () => {
    const store = newStore([
      { id: "f-old", name: "Quotation / Package", position: 4, options: ["Sent", "Not Yet"] },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.renamed).toEqual(["Stage"]);
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      id: "f-old",
      patch: { name: "Stage", options: [...STAGE_OPTIONS] },
    });
    expect(res.created).not.toContain("Stage");
  });

  it("skips rename when the successor already exists (no merge, no loss)", async () => {
    const store = newStore([
      { id: "f-old", name: "Lead Quality", position: 3, options: ["Hot", "Warm", "Cold", "Fake"] },
      { id: "f-new", name: "Lead Type", position: 9, options: [...LEAD_TYPE_OPTIONS] },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.renamed).toEqual([]);
    expect(store.updates).toHaveLength(0);
  });

  it("skips rename for same-named fields with different options (user-owned)", async () => {
    const store = newStore([
      { id: "f-user", name: "Lead Quality", position: 3, options: ["A", "B"] },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Not a legacy default row: left alone, successor inserted fresh.
    expect(res.renamed).toEqual([]);
    expect(store.updates).toHaveLength(0);
    expect(res.created).toContain("Lead Type");
  });

  it("survives a concurrent-provisioner race (unique-index conflict)", async () => {
    const store = newStore();
    store.insertError = { code: "23505", message: "duplicate" };
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Attempted the insert; the conflict is swallowed, not surfaced.
    expect(store.inserts).toHaveLength(1);
    expect(res.created).toHaveLength(13);
  });

  it("surfaces real failures so callers can degrade gracefully", async () => {
    const readStore = newStore();
    readStore.failRead = true;
    await expect(
      ensureWorkspaceDefaultFields(fakeClient(readStore), "acct-1", "flow-1"),
    ).rejects.toThrow(/read failed/);

    const writeStore = newStore();
    writeStore.insertError = { code: "500", message: "boom" };
    await expect(
      ensureWorkspaceDefaultFields(fakeClient(writeStore), "acct-1", "flow-1"),
    ).rejects.toThrow(/boom/);
  });

  it("15/16. touches only workspace_fields, scoped to the flow's account", async () => {
    const store = newStore();
    await ensureWorkspaceDefaultFields(fakeClient(store), "acct-9", "flow-9");
    // No flows / flow_nodes / sheets / values tables ever touched.
    expect(new Set(store.tablesTouched)).toEqual(
      new Set(["workspace_fields"]),
    );
    expect(store.eqFilters).toContainEqual(["account_id", "acct-9"]);
    expect(store.eqFilters).toContainEqual(["flow_id", "flow-9"]);
  });
});

describe("default fields in the existing visibility mechanism", () => {
  it("2/3/4. Completed and Incomplete share one config: all 13 visible initially", () => {
    const fields = defaultFields();
    const model = describeVisibilityMenu([], fields);
    // Searchable Columns manager lists every default, none locked.
    expect(model.custom).toHaveLength(13);
    expect(
      model.custom.every((c) => !("locked" in c)),
    ).toBe(true);
    // Default state (no hidden ids — same key for both views).
    const applied = applyVisibility([], fields, []);
    expect(applied.customFields).toHaveLength(13);
  });

  it("13. no column is locked; system fields are hideable flow entries", () => {
    const model = describeVisibilityMenu(
      [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "name", label: "Name", system: true },
        { key: "phone", label: "Phone Number", system: true },
      ],
      defaultFields(),
    );
    expect(model.core.map((c) => c.label)).toEqual(["Row"]);
    expect(model.flow.map((c) => c.label)).toEqual([
      "Submission Time",
      "Name",
      "Phone Number",
    ]);
    const applied = applyVisibility(
      [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "name", label: "Name", system: true },
        { key: "phone", label: "Phone Number", system: true },
      ],
      defaultFields(),
      ["core:row", "flow:name", "flow:phone", "flow:submission_time"],
    );
    expect(applied.flowColumns).toHaveLength(0);
    expect(
      model.custom.some((c) => model.core.some((k) => k.id === c.id)),
    ).toBe(false);
  });

  it("5/7. hides one, several, or all 13 — and restores each in place", () => {
    const fields = defaultFields();
    const ids = fields.map((f) => customFieldVisId(f.id));

    let hidden = toggleHiddenId([], ids[0]);
    expect(applyVisibility([], fields, hidden).customFields).toHaveLength(12);

    hidden = toggleHiddenId(hidden, ids[1]);
    hidden = toggleHiddenId(hidden, ids[2]);
    let applied = applyVisibility([], fields, hidden);
    expect(applied.customFields).toHaveLength(10);

    hidden = [...ids];
    applied = applyVisibility([], fields, hidden);
    expect(applied.customFields).toHaveLength(0);

    // Restore one: it returns to its ORIGINAL position, not appended.
    hidden = toggleHiddenId(hidden, ids[5]);
    applied = applyVisibility([], fields, hidden);
    expect(applied.customFields.map((f) => f.name)).toEqual([
      "Follow-Up Status",
    ]);

    // Show all / reset path.
    applied = applyVisibility([], fields, []);
    expect(applied.customFields.map((f) => f.name)).toEqual(
      fields.map((f) => f.name),
    );
  });

  it("6/8. hiding never deletes the field or its data", () => {
    const fields = defaultFields();
    const hidden = fields.map((f) => customFieldVisId(f.id));
    const before = fields.length;
    applyVisibility([], fields, hidden);
    // Definitions array untouched — nothing removed, order intact.
    expect(fields).toHaveLength(before);
    expect(fields.map((f) => f.name)).toEqual(
      WORKSPACE_DEFAULT_FIELDS.map((f) => f.name),
    );
  });

  it("14. no lead pseudo-column exists in the menu model", () => {
    const model = describeVisibilityMenu([], defaultFields());
    expect(model).not.toHaveProperty("leadSource");
    expect(
      flattenVisibilityMenu(model).some((c) => c.label === "Lead Source"),
    ).toBe(false);
  });
});

describe("Group 3 display order (Assigned To, Received, Type, Stage first)", () => {
  function extraField(name: string, position: number): WorkspaceField {
    return {
      id: `f-extra-${position}`,
      account_id: "acct-1",
      flow_id: "flow-1",
      name,
      field_type: "text",
      position,
      options: null,
      default_value: null,
      currency_code: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  // Scrambled stored order with extra custom fields interleaved —
  // the pinned four must still lead, everything else keeps its
  // relative sequence.
  function scrambled(): WorkspaceField[] {
    const base = defaultFields();
    const byName = new Map(base.map((f) => [f.name, f]));
    const get = (name: string) => byName.get(name) as WorkspaceField;
    return [
      get("Final Remark"),
      extraField("My Notes", 100),
      get("Stage"),
      get("Call Status"),
      get("Lead Type"),
      get("Assigned To"),
      get("Follow-Up Status"),
      get("Lead Received"),
      get("No. of Calls Tried"),
      extraField("Budget Code", 101),
      get("Last Contact Date"),
      get("Customer Response"),
      get("Next Follow-up Date & Time"),
      get("Next Action"),
      get("Reason for Lost Lead"),
    ];
  }

  it("2+3+4+5. Assigned To, Received, Type, Stage lead in exactly that order", () => {
    const names = orderBusinessColumns(scrambled()).map((f) => f.name);
    expect(names.slice(0, 4)).toEqual([
      "Assigned To",
      "Lead Received",
      "Lead Type",
      "Stage",
    ]);
  });

  it("6. remaining business columns follow Stage in stored relative order", () => {
    const names = orderBusinessColumns(scrambled()).map((f) => f.name);
    expect(names).toEqual([
      "Assigned To",
      "Lead Received",
      "Lead Type",
      "Stage",
      "Final Remark",
      "My Notes",
      "Call Status",
      "Follow-Up Status",
      "No. of Calls Tried",
      "Budget Code",
      "Last Contact Date",
      "Customer Response",
      "Next Follow-up Date & Time",
      "Next Action",
      "Reason for Lost Lead",
    ]);
  });

  it("matches pinned columns by stored identity, never display labels", () => {
    expect(isLeadTypeField({ name: "Lead Type" })).toBe(true);
    expect(isLeadTypeField({ name: "  lead type " })).toBe(true);
    expect(isLeadTypeField({ name: "Type" })).toBe(false);
    expect(isStageField({ name: "Stage" })).toBe(true);
    expect(isStageField({ name: "stage" })).toBe(true);
    expect(isStageField({ name: "Stages" })).toBe(false);
    // A display-labelled "Type"/"Received" decoy is not promoted.
    const fields = [extraField("Type", 1), extraField("Received", 2)];
    expect(orderBusinessColumns(fields).map((f) => f.name)).toEqual([
      "Type",
      "Received",
    ]);
  });

  it("tolerates missing pinned columns and never mutates its input", () => {
    const fields = [extraField("B", 2), extraField("A", 1)];
    const snapshot = fields.map((f) => f.name);
    expect(orderBusinessColumns(fields).map((f) => f.name)).toEqual(["B", "A"]);
    expect(fields.map((f) => f.name)).toEqual(snapshot);
    expect(orderBusinessColumns([])).toEqual([]);
    // Stored spec order itself is untouched by the display rule.
    expect(WORKSPACE_DEFAULT_FIELDS.map((f) => f.name)).toContain("Lead Type");
    expect(WORKSPACE_DEFAULT_FIELDS.map((f) => f.name)).toContain("Lead Received");
  });

  it("10. works on visibility-filtered subsets (hidden columns simply absent)", () => {
    const visible = scrambled().filter((f) => f.name !== "Assigned To");
    const names = orderBusinessColumns(visible).map((f) => f.name);
    expect(names.slice(0, 3)).toEqual(["Lead Received", "Lead Type", "Stage"]);
    // Field identities survive ordering for widths/visibility/values.
    const ordered = orderBusinessColumns(scrambled());
    expect(ordered.map((f) => f.id)).toHaveLength(scrambled().length);
    expect(new Set(ordered.map((f) => f.id)).size).toBe(scrambled().length);
  });
});

describe("Type/Stage business defaults (Fresh / New Lead, read-only)", () => {
  it("returns Fresh for Type and New Lead for Stage, null elsewhere", () => {
    expect(defaultBusinessValue({ name: "Lead Type" })).toBe("Fresh");
    expect(defaultBusinessValue({ name: "  lead type " })).toBe("Fresh");
    expect(defaultBusinessValue({ name: "Stage" })).toBe("New Lead");
    expect(defaultBusinessValue({ name: "STAGE" })).toBe("New Lead");
    expect(defaultBusinessValue({ name: "Lead Received" })).toBeNull();
    expect(defaultBusinessValue({ name: "Call Status" })).toBeNull();
    expect(defaultBusinessValue({ name: "Type" })).toBeNull();
  });

  it("9. existing Type/Stage rows are never backfilled or rewritten", async () => {
    const store = newStore();
    store.rows = [
      { id: "f-type", name: "Lead Type", position: 3, options: [...LEAD_TYPE_OPTIONS] },
      { id: "f-stage", name: "Stage", position: 4, options: [...STAGE_OPTIONS] },
    ];
    const before = store.rows.map((r) => ({ ...r }));
    const res = await ensureWorkspaceDefaultFields(fakeClient(store), "acct-1", "flow-1");
    // The two pre-existing rows suppress their defaults; only the
    // other 11 are inserted — and no UPDATE touches any row.
    expect(res.created).toHaveLength(11);
    expect(res.created).not.toContain("Lead Type");
    expect(res.created).not.toContain("Stage");
    expect(store.updates).toHaveLength(0);
    expect(store.rows.slice(0, 2)).toEqual(before);
  });
});

describe("console hygiene", () => {  it("does not log during normal provisioning", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureWorkspaceDefaultFields(
        fakeClient(newStore()),
        "acct-1",
        "flow-1",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
