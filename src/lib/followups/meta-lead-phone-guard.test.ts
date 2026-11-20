import { describe, expect, it, vi } from "vitest";
import {
  isMetaLeadPhoneNumber,
  isSameLeadNumber,
  META_LEAD_PHONE_CODE,
  META_LEAD_PHONE_ERROR,
  toComparablePhoneDigits,
} from "./meta-lead-phone-guard";

describe("toComparablePhoneDigits", () => {
  it("strips formatting to digits only", () => {
    expect(toComparablePhoneDigits("+91 7415122330")).toBe("917415122330");
    expect(toComparablePhoneDigits("+91-7415122330")).toBe("917415122330");
    expect(toComparablePhoneDigits("91 7415122330")).toBe("917415122330");
    expect(toComparablePhoneDigits("7415122330")).toBe("7415122330");
  });

  it("returns null for empty/non-strings", () => {
    expect(toComparablePhoneDigits("")).toBeNull();
    expect(toComparablePhoneDigits("   ")).toBeNull();
    expect(toComparablePhoneDigits(null)).toBeNull();
    expect(toComparablePhoneDigits(undefined)).toBeNull();
  });
});

describe("isSameLeadNumber (SQL equivalence mirror)", () => {
  it("matches exact digit equality", () => {
    expect(isSameLeadNumber("919876543210", "+91 98765 43210")).toBe(true);
    expect(isSameLeadNumber("+14155552671", "14155552671")).toBe(true);
  });

  it("matches India 10-digit national form against the 91-prefixed form", () => {
    expect(isSameLeadNumber("7415122330", "+91 7415122330")).toBe(true);
    expect(isSameLeadNumber("+91-7415122330", "917415122330")).toBe(true);
    expect(isSameLeadNumber("91 7415122330", "7415122330")).toBe(true);
  });

  it("does not fuzzy-match different numbers", () => {
    expect(isSameLeadNumber("7415122330", "7415122331")).toBe(false);
    expect(isSameLeadNumber("7415122330", "9876543210")).toBe(false);
    // Same tail, different head — must NOT match.
    expect(isSameLeadNumber("911515122330", "917415122330")).toBe(false);
  });

  it("never matches missing values", () => {
    expect(isSameLeadNumber("", "7415122330")).toBe(false);
    expect(isSameLeadNumber(null, "7415122330")).toBe(false);
  });
});

describe("shared rejection", () => {
  it("uses the specified message and a machine-readable code", () => {
    expect(META_LEAD_PHONE_ERROR).toBe(
      "This number belongs to a lead in your Meta Lead Ads Workspace. Please enter a team member's WhatsApp number.",
    );
    expect(META_LEAD_PHONE_CODE).toBe("meta_lead_phone");
  });
});

describe("isMetaLeadPhoneNumber", () => {
  it("returns the RPC result", async () => {
    const db = { rpc: vi.fn(async () => ({ data: true, error: null })) };
    await expect(
      isMetaLeadPhoneNumber(db as never, "917415122330"),
    ).resolves.toBe(true);
    expect(db.rpc).toHaveBeenCalledWith("is_meta_lead_phone", {
      p_digits: "917415122330",
    });
  });

  it("throws on RPC failure (fail closed, never guess)", async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: "db down" } })) };
    await expect(isMetaLeadPhoneNumber(db as never, "917415122330")).rejects.toMatchObject({
      message: "db down",
    });
  });
});
