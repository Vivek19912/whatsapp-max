import { describe, expect, it } from "vitest";

import {
  extractCrmSalespeople,
  resolveCrmDisplayName,
  resolveMappedCrmUserId,
  resolveWacrmDisplayName,
} from "./user-mapping";

describe("extractCrmSalespeople", () => {
  it("parses the native lookups shape", () => {
    const out = extractCrmSalespeople({
      assignableUsers: [
        { id: "u-1", fullName: "Sales X", username: "salesx", email: "x@crm.test" },
        { id: "u-2", fullName: "Sales Y", username: "salesy", email: "y@other.test" },
      ],
    });
    expect(out).toEqual([
      { id: "u-1", fullName: "Sales X", username: "salesx", email: "x@crm.test" },
      { id: "u-2", fullName: "Sales Y", username: "salesy", email: "y@other.test" },
    ]);
  });

  it("accepts the generic value/label option shape", () => {
    const out = extractCrmSalespeople({
      assignableUsers: [{ value: "u-9", label: "Nine" }],
    });
    expect(out).toEqual([
      { id: "u-9", fullName: "Nine", username: null, email: null },
    ]);
  });

  it("accepts bare string ids and skips malformed entries", () => {
    const out = extractCrmSalespeople({
      assignableUsers: ["u-1", 42, null, {}, { id: "" }, { value: "", label: "x" }],
    });
    expect(out).toEqual([{ id: "u-1", fullName: "u-1", username: null, email: null }]);
  });

  it("returns [] for missing or non-array payloads", () => {
    expect(extractCrmSalespeople(null)).toEqual([]);
    expect(extractCrmSalespeople(undefined)).toEqual([]);
    expect(extractCrmSalespeople({})).toEqual([]);
    expect(extractCrmSalespeople({ assignableUsers: "nope" })).toEqual([]);
  });
});

function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          }),
        }),
      }),
    }),
  } as never;
}

describe("resolveMappedCrmUserId", () => {
  it("returns the mapped id", async () => {
    await expect(
      resolveMappedCrmUserId(fakeDb([{ crm_user_id: "crm-501" }]), "acct-1", "u-101"),
    ).resolves.toBe("crm-501");
  });

  it("returns null when unmapped", async () => {
    await expect(resolveMappedCrmUserId(fakeDb([]), "acct-1", "u-101")).resolves.toBeNull();
  });

  it("returns null on database errors instead of throwing", async () => {
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                throw new Error("db down");
              },
            }),
          }),
        }),
      }),
    } as never;
    await expect(resolveMappedCrmUserId(failing, "acct-1", "u-101")).resolves.toBeNull();
  });
});

describe("resolveCrmDisplayName — never a raw id on screen", () => {
  const roster = [
    { id: "crm-501", fullName: "Salesperson X", email: "x@crm.test" },
    { id: "crm-502", fullName: "Salesperson Y", email: null },
  ];

  it("shows the roster name with email when matched", () => {
    expect(resolveCrmDisplayName("crm-501", roster)).toBe("Salesperson X (x@crm.test)");
  });

  it("shows the bare name when the roster has no email", () => {
    expect(resolveCrmDisplayName("crm-502", roster)).toBe("Salesperson Y");
  });

  it("falls back to the previously saved name for stale mappings", () => {
    expect(resolveCrmDisplayName("crm-gone", roster, "Old Sales")).toBe("Old Sales");
  });

  it("never returns the raw id", () => {
    for (const id of ["crm-gone", "", "  "]) {
      const label = resolveCrmDisplayName(id, roster, id === "  " ? "  " : null);
      expect(label).not.toContain("crm-");
      expect(label.length).toBeGreaterThan(0);
    }
    expect(resolveCrmDisplayName("crm-gone", roster)).toBe("Unknown salesperson");
  });
});

describe("resolveWacrmDisplayName — never a raw id on screen", () => {
  const roster = [
    { id: "u-1", name: "Agent A", email: "a@wacrm.test", role: "agent" },
  ];

  it("shows name, email and role when matched", () => {
    expect(resolveWacrmDisplayName("u-1", roster)).toBe("Agent A (a@wacrm.test) · agent");
  });

  it("falls back to the saved name, then a neutral label", () => {
    expect(resolveWacrmDisplayName("u-gone", roster, "Old Agent")).toBe("Old Agent");
    expect(resolveWacrmDisplayName("u-gone", roster)).toBe("Unknown user");
    expect(resolveWacrmDisplayName("u-gone", roster)).not.toContain("u-gone");
  });
});
