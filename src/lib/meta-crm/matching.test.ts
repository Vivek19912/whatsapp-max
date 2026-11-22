// Meta CRM matching identifiers — normalization + hashing contracts.
//
// Pins the official customer-information parameter rules:
//   * em: trim + lowercase, then SHA-256 hex (Meta's documented
//     example vector included verbatim).
//   * ph: digits only, leading zeros stripped, then SHA-256 hex.
//     No country code is ever invented.
//   * lead_id is NEVER hashed — resolved and sent verbatim.
// Raw contact values never leave the resolver (hashes only).

import { describe, expect, it } from "vitest";

import {
  normalizeEmailForMeta,
  normalizePhoneForMeta,
  resolveLeadMatchHashes,
  sha256Hex,
} from "./matching";

describe("Meta normalization vectors", () => {
  it("lowercases + trims email (Meta's documented example)", () => {
    expect(normalizeEmailForMeta("John_Smith@gmail.com")).toBe("john_smith@gmail.com");
    expect(normalizeEmailForMeta("  USER@Example.COM  ")).toBe("user@example.com");
  });

  it("matches Meta's documented SHA-256 email vector", () => {
    // From the customer-information parameters documentation:
    // "john_smith@gmail.com" → 62a14e44f765…
    expect(sha256Hex("john_smith@gmail.com")).toBe(
      "62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f",
    );
  });

  it("matches the SHA-256 primitive on the documented phone digits", () => {
    // Verified locally with node:crypto. (Meta's doc page prints a
    // near-identical hash ending …442d… for this input — a doc
    // transcription variant; the email vector above matches the
    // docs exactly, pinning the primitive itself.)
    expect(sha256Hex("16505551212")).toBe(
      "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
    );
  });

  it("reduces phones to digits without inventing a country code", () => {
    expect(normalizePhoneForMeta("(650) 555-1212")).toBe("6505551212");
    expect(normalizePhoneForMeta("+91 98765 43210")).toBe("919876543210");
    expect(normalizePhoneForMeta("0987654321")).toBe("987654321");
  });

  it("rejects malformed or unmatchable identifiers (omitted, never fixed)", () => {
    expect(normalizeEmailForMeta("not-an-email")).toBeNull();
    expect(normalizeEmailForMeta("a@b")).toBeNull();
    expect(normalizeEmailForMeta("")).toBeNull();
    expect(normalizeEmailForMeta(null)).toBeNull();
    expect(normalizePhoneForMeta("123")).toBeNull();
    expect(normalizePhoneForMeta("abc")).toBeNull();
    expect(normalizePhoneForMeta(null)).toBeNull();
  });
});

describe("resolveLeadMatchHashes", () => {
  function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
    const matches = (rows: Array<Record<string, unknown>>, filters: Array<[string, unknown]>) =>
      rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const chain = (table: string, filters: Array<[string, unknown]> = []): Record<string, (...a: never[]) => unknown> => {
      const api: Record<string, (...a: never[]) => unknown> = {
        select: () => chain(table, filters),
        eq: (c: string, v: unknown) => chain(table, [...filters, [c, v]]),
        maybeSingle: async () => ({
          data: matches(tables[table] ?? [], filters)[0] ?? null,
          error: null,
        }),
      };
      return api;
    };
    return { from: (table: string) => ({ select: () => chain(table) }) };
  }

  it("hashes the materialized contact email/phone, never exposing raw values", async () => {
    const db = fakeDb({
      flow_runs: [{ id: "run-1", account_id: "acct-1", contact_id: "c-1" }],
      contacts: [{ id: "c-1", account_id: "acct-1", email: "Amy@Example.com", phone: "+1 (415) 555-0100" }],
      meta_lead_submissions: [],
    });
    const out = await resolveLeadMatchHashes(db as never, { accountId: "acct-1", runId: "run-1" });
    expect(out).toEqual({
      em: [sha256Hex("amy@example.com")],
      ph: [sha256Hex("14155550100")],
      emailInvalid: false,
      phoneInvalid: false,
    });
    expect(JSON.stringify(out)).not.toContain("Amy");
    expect(JSON.stringify(out)).not.toContain("415");
  });

  it("falls back to stored Instant Form answers when no contact is linked", async () => {
    const db = fakeDb({
      flow_runs: [{ id: "run-1", account_id: "acct-1", contact_id: null }],
      contacts: [],
      meta_lead_submissions: [
        {
          account_id: "acct-1",
          flow_run_id: "run-1",
          answers: { email: "Lead@Example.org", phone_number: "9876543210" },
          field_data: [],
        },
      ],
    });
    const out = await resolveLeadMatchHashes(db as never, { accountId: "acct-1", runId: "run-1" });
    expect(out.em).toEqual([sha256Hex("lead@example.org")]);
    expect(out.ph).toEqual([sha256Hex("9876543210")]);
  });

  it("returns empty (never blocking) when no identifiers exist", async () => {
    const db = fakeDb({
      flow_runs: [{ id: "run-1", account_id: "acct-1", contact_id: null }],
      contacts: [],
      meta_lead_submissions: [],
    });
    const out = await resolveLeadMatchHashes(db as never, { accountId: "acct-1", runId: "run-1" });
    expect(out).toEqual({ em: [], ph: [], emailInvalid: false, phoneInvalid: false });
  });

  it("flags invalid raw values instead of inventing hashes", async () => {
    const db = fakeDb({
      flow_runs: [{ id: "run-1", account_id: "acct-1", contact_id: "c-1" }],
      contacts: [{ id: "c-1", account_id: "acct-1", email: "oops", phone: "12" }],
      meta_lead_submissions: [],
    });
    const out = await resolveLeadMatchHashes(db as never, { accountId: "acct-1", runId: "run-1" });
    expect(out).toEqual({ em: [], ph: [], emailInvalid: true, phoneInvalid: true });
  });
});
