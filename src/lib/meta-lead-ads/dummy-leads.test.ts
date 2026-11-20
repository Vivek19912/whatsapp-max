import { describe, expect, it } from "vitest";
import {
  isDummyPhoneLead,
  isDummyPhoneValue,
  META_DUMMY_PHONE_CANONICAL,
  normalizePhoneMarker,
} from "./dummy-leads";

describe("isDummyPhoneValue", () => {
  it("matches the exact Meta placeholder", () => {
    expect(isDummyPhoneValue("<test lead: dummy data for phone_number>")).toBe(true);
    expect(META_DUMMY_PHONE_CANONICAL).toBe("<test lead: dummy data for phone_number>");
  });

  it("matches capitalization variants", () => {
    expect(isDummyPhoneValue("<Test Lead: Dummy Data For Phone_Number>")).toBe(true);
    expect(isDummyPhoneValue("<TEST LEAD: DUMMY DATA FOR PHONE_NUMBER>")).toBe(true);
  });

  it("matches harmless whitespace variants", () => {
    expect(isDummyPhoneValue("  <test lead: dummy data for phone_number>  ")).toBe(true);
    expect(isDummyPhoneValue("<test lead:  dummy   data for phone_number>")).toBe(true);
    expect(isDummyPhoneValue("<test lead:\tdummy data for phone_number>")).toBe(true);
  });

  it("keeps genuine phone numbers", () => {
    expect(isDummyPhoneValue("+919876543210")).toBe(false);
    expect(isDummyPhoneValue("919876543210")).toBe(false);
    expect(isDummyPhoneValue("+1 555-123-4567")).toBe(false);
  });

  it("never matches missing/empty/non-string values", () => {
    expect(isDummyPhoneValue(null)).toBe(false);
    expect(isDummyPhoneValue(undefined)).toBe(false);
    expect(isDummyPhoneValue("")).toBe(false);
    expect(isDummyPhoneValue("   ")).toBe(false);
    expect(isDummyPhoneValue(12345)).toBe(false);
  });

  it("does not match near-misses or other markers", () => {
    // Genuine text that merely mentions testing must stay counted.
    expect(isDummyPhoneValue("test")).toBe(false);
    expect(isDummyPhoneValue("dummy")).toBe(false);
    expect(isDummyPhoneValue("<test lead: dummy data for full_name>")).toBe(false);
    expect(isDummyPhoneValue("<test lead: dummy data for phone number>")).toBe(false); // space, no underscore
  });
});

describe("normalizePhoneMarker", () => {
  it("trims, collapses, and lowercases", () => {
    expect(normalizePhoneMarker("  <Test   Lead:\tDummy DATA For Phone_Number>  ")).toBe(
      META_DUMMY_PHONE_CANONICAL,
    );
    expect(normalizePhoneMarker("")).toBeNull();
    expect(normalizePhoneMarker(null)).toBeNull();
  });
});

describe("isDummyPhoneLead", () => {
  it("detects the marker under any standard phone key", () => {
    for (const key of ["phone_number", "phone", "mobile", "mobile_number", "whatsapp_number"]) {
      expect(isDummyPhoneLead({ [key]: "<test lead: dummy data for phone_number>" })).toBe(true);
    }
  });

  it("keeps leads with genuine phones", () => {
    expect(isDummyPhoneLead({ phone_number: "+919876543210", full_name: "Aarav" })).toBe(false);
    expect(isDummyPhoneLead({ phone: "+15551234567" })).toBe(false);
  });

  it("does not exclude on missing phones alone", () => {
    expect(isDummyPhoneLead({})).toBe(false);
    expect(isDummyPhoneLead(null)).toBe(false);
    expect(isDummyPhoneLead(undefined)).toBe(false);
    expect(isDummyPhoneLead({ full_name: "No Phone" })).toBe(false);
  });

  it("keeps dummy names with genuine phones", () => {
    expect(
      isDummyPhoneLead({
        full_name: "<test lead: dummy data for full_name>",
        phone_number: "+919876543210",
      }),
    ).toBe(false);
  });
});
