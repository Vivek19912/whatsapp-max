import { describe, expect, it } from "vitest";

import {
  buildUserData,
  normalizeEmail,
  normalizeName,
  normalizePhoneForHash,
  sha256Hex,
  splitName,
} from "./hash";

describe("sha256Hex", () => {
  it("produces the documented lowercase-hex SHA-256", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("normalizers", () => {
  it("normalizes email (trim + lowercase)", () => {
    expect(normalizeEmail("  John@Example.COM ")).toBe("john@example.com");
  });

  it("normalizes names (lowercase, no spaces/punctuation)", () => {
    expect(normalizeName("  John  McDonald ")).toBe("johnmcdonald");
  });

  it("normalizes phones to digits only", () => {
    expect(normalizePhoneForHash("+1 (555) 123-4567")).toBe("15551234567");
  });

  it("splits a display name into first/last", () => {
    expect(splitName("Ada Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(splitName("Prince")).toEqual({ firstName: "Prince", lastName: null });
    expect(splitName("")).toEqual({ firstName: null, lastName: null });
  });
});

describe("buildUserData", () => {
  it("hashes PII and omits fields we do not hold", () => {
    const data = buildUserData({ email: "A@B.com", phone: "+1 555 123 4567" });
    expect(data.em).toBe(sha256Hex("a@b.com"));
    expect(data.ph).toBe(sha256Hex("15551234567"));
    expect(data.fn).toBeUndefined();
    expect(data.ln).toBeUndefined();
  });

  it("passes click identifiers through UN-hashed, per Meta", () => {
    const data = buildUserData({
      ctwaClid: "CLICK123",
      fbc: "fb.1.abc",
      fbp: "fb.1.def",
    });
    expect(data.ctwa_clid).toBe("CLICK123");
    expect(data.fbc).toBe("fb.1.abc");
    expect(data.fbp).toBe("fb.1.def");
  });

  it("derives fn/ln from the full name", () => {
    const data = buildUserData({ fullName: "Grace Hopper" });
    expect(data.fn).toBe(sha256Hex("grace"));
    expect(data.ln).toBe(sha256Hex("hopper"));
  });
});
