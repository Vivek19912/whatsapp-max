// Meta CAPI — status presets route.
//
// Disabled-by-default presets are created only from the workspace's
// actual stored Stage values: nothing is enabled, nothing is Purchase,
// and missing values are reported with the available options.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  roleOk: true,
  fields: [] as Array<Record<string, unknown>>,
  existingNames: new Set<string>(),
  ingestionLead: false,
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    if (!h.roleOk) throw Object.assign(new Error("Forbidden"), { status: 403 });
    return { supabase: {}, accountId: h.accountId, userId: "u1" };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: (err as { status?: number })?.status ?? 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "workspace_fields") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: async () => ({ data: h.fields, error: null }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/meta-capi/store", () => ({
  listMappings: async () =>
    [...h.existingNames].map((name) => ({ name })),
  listEnabledMappingsForAction: async () =>
    h.ingestionLead
      ? [{ meta_event_name: "Lead", source_action: "meta_lead_received" }]
      : [],
  insertMapping: async (_db: unknown, row: Record<string, unknown>) => {
    if (h.existingNames.has(row.name as string)) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    h.existingNames.add(row.name as string);
    const created = { id: `m-${h.inserted.length + 1}`, ...row };
    h.inserted.push(created);
    return created;
  },
}));

const { POST } = await import("./route");

beforeEach(() => {
  h.accountId = "acct-1";
  h.roleOk = true;
  h.fields = [
    { name: "Stage", options: ["New Lead", "Qualified", "Converted"] },
  ];
  h.existingNames = new Set<string>();
  h.ingestionLead = false;
  h.inserted = [];
});

describe("POST /meta-capi/presets", () => {
  it("creates disabled Qualified/Contacted/Converted presets from stored values", async () => {
    const res = await POST();
    const json = (await res.json()) as {
      ok: boolean;
      created: Array<{ name: string; enabled: boolean }>;
      missing: Array<{ status: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // Contacted has no exact stored value, so only two are created.
    expect(json.created.map((c) => c.name).sort()).toEqual([
      "Status: Stage = Converted → ConvertedLead",
      "Status: Stage = Qualified → QualifiedLead",
    ]);
    expect(json.created.every((c) => c.enabled === false)).toBe(true);
    expect(h.inserted.every((row) => row.enabled === false)).toBe(true);
    expect(h.inserted.some((row) => row.meta_event_name === "Purchase")).toBe(false);
    expect(json.missing.map((m) => m.status)).toEqual(["Contacted"]);
    expect(JSON.stringify(json)).not.toContain("tok");
  });

  it("skips existing presets and warns about duplicate Lead counting", async () => {
    h.existingNames = new Set(["Status: Stage = Qualified → QualifiedLead"]);
    h.ingestionLead = true;

    const res = await POST();
    const json = (await res.json()) as {
      skippedExisting: string[];
      warnings: string[];
    };

    expect(json.skippedExisting).toEqual([
      "Status: Stage = Qualified → QualifiedLead",
    ]);
    expect(json.warnings.join(" ")).toContain("two Leads");
  });

  it("reports clearly when no Stage column exists", async () => {
    h.fields = [];

    const res = await POST();
    const json = (await res.json()) as {
      created: unknown[];
      missing: Array<{ status: string; availableStageValues: string[] }>;
      warnings: string[];
    };

    expect(json.created).toHaveLength(0);
    expect(json.missing.map((m) => m.status)).toEqual([
      "Qualified",
      "Contacted",
      "Converted",
    ]);
    expect(json.warnings.join(" ")).toContain("No Stage column");
  });

  it("requires an admin role", async () => {
    h.roleOk = false;
    const res = await POST();
    expect(res.status).toBe(403);
    expect(h.inserted).toHaveLength(0);
  });
});
