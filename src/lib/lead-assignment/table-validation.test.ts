// Per-table assignment validation — emails, phones, timezones,
// pauses, percentage totals. Pure: no mocks, no database.

import { describe, expect, it } from "vitest";

import {
  endOfTodayUtc,
  formatPausedUntil,
  isValidAssigneeEmail,
  isValidTimezone,
  normalizeAssigneePhone,
  validatePauseInput,
  validateTableConfig,
} from "./table-validation";

describe("assignee contact validation", () => {
  it("accepts valid emails and rejects malformed ones", () => {
    expect(isValidAssigneeEmail("priya@example.com")).toBe(true);
    expect(isValidAssigneeEmail("a.b+tag@sub.example.co")).toBe(true);
    expect(isValidAssigneeEmail("not-an-email")).toBe(false);
    expect(isValidAssigneeEmail("a@b")).toBe(false);
    expect(isValidAssigneeEmail("a@b.")).toBe(false);
    expect(isValidAssigneeEmail("@example.com")).toBe(false);
    expect(isValidAssigneeEmail("")).toBe(false);
  });

  it("normalizes E.164 phones and rejects the rest", () => {
    expect(normalizeAssigneePhone("+911234567890")).toBe("+911234567890");
    expect(normalizeAssigneePhone("+1 (415) 555-0132")).toBe("+14155550132");
    expect(normalizeAssigneePhone("+91-12345 67890")).toBe("+911234567890");
    expect(normalizeAssigneePhone("1234567890")).toBeNull();
    expect(normalizeAssigneePhone("+123")).toBeNull();
    expect(normalizeAssigneePhone("+12345678901234567")).toBeNull();
    expect(normalizeAssigneePhone("+91-ABC-DEF")).toBeNull();
    expect(normalizeAssigneePhone("")).toBeNull();
  });

  it("accepts real IANA zones and rejects typos", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("IST5")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("pause math and display", () => {
  const noonUtc = new Date("2026-10-26T12:00:00.000Z");

  it("ends 'today' at local midnight in the config zone", () => {
    // Noon UTC = 17:30 IST: today ends 2026-10-26T23:59:59.999+05:30.
    const until = endOfTodayUtc("Asia/Kolkata", noonUtc);
    expect(until).toBe("2026-10-26T18:29:59.999Z");
    expect(formatPausedUntil(until, "Asia/Kolkata")).toBe("Paused until 26 October");
  });

  it("labels a UTC pause in UTC", () => {
    const until = endOfTodayUtc("UTC", noonUtc);
    expect(until).toBe("2026-10-26T23:59:59.999Z");
    expect(formatPausedUntil(until, "UTC")).toBe("Paused until 26 October");
  });
});

describe("validatePauseInput", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("resumes immediately and clears the window", () => {
    expect(validatePauseInput({ mode: "resume" }, now)).toEqual({
      paused_until: null,
      reason: null,
      scope: "table",
      timezone: "UTC",
    });
  });

  it("pauses for today in the given zone", () => {
    const pause = validatePauseInput(
      { mode: "today", timezone: "Asia/Kolkata" },
      now,
    );
    expect(pause.paused_until).toBe("2026-10-26T18:29:59.999Z");
    expect(pause.scope).toBe("table");
  });

  it("pauses for N days and keeps a reason", () => {
    const pause = validatePauseInput(
      { mode: "days", days: 3, reason: "On leave", scope: "account" },
      now,
    );
    expect(pause.paused_until).toBe("2026-10-29T12:00:00.000Z");
    expect(pause.reason).toBe("On leave");
    expect(pause.scope).toBe("account");
  });

  it("pauses until an explicit future instant", () => {
    const pause = validatePauseInput({ mode: "until", until: "2026-11-05T09:00:00Z" }, now);
    expect(pause.paused_until).toBe("2026-11-05T09:00:00.000Z");
  });

  it("rejects past dates, bad ranges, and long pauses", () => {
    expect(() => validatePauseInput({ mode: "days", days: 0 }, now)).toThrow(/1 to 365/);
    expect(() => validatePauseInput({ mode: "days", days: 400 }, now)).toThrow(/1 to 365/);
    expect(() =>
      validatePauseInput({ mode: "until", until: "2026-10-25T00:00:00Z" }, now),
    ).toThrow(/future/);
    expect(() =>
      validatePauseInput({ mode: "until", until: "not-a-date" }, now),
    ).toThrow(/understood/);
    expect(() => validatePauseInput({ mode: "someday" }, now)).toThrow(/today/);
    expect(() => validatePauseInput({ mode: "today", timezone: "Mars/Olympus" }, now)).toThrow(
      /Unknown timezone/,
    );
  });
});

describe("validateTableConfig", () => {
  it("accepts a round-robin config with team + external assignees", () => {
    const valid = validateTableConfig({
      enabled: true,
      mode: "round_robin",
      timezone: "UTC",
      assignees: [
        { user_id: "user-1", display_name: "Asha", weight: 99 },
        { display_name: "ExternalSELLER", email: "ext@example.com", phone: "+15551234567" },
      ],
    });
    expect(valid.enabled).toBe(true);
    expect(valid.assignees).toHaveLength(2);
    // Round robin ignores weights (stored 0).
    expect(valid.assignees.map((a) => a.weight)).toEqual([0, 0]);
    expect(valid.assignees[1].user_id).toBeNull();
  });

  it("requires exact 100% across ACTIVE percentage members", () => {
    const ok = validateTableConfig({
      enabled: true,
      mode: "percentage",
      assignees: [
        { user_id: "u1", display_name: "A", weight: 60 },
        { user_id: "u2", display_name: "B", weight: 40 },
      ],
    });
    expect(ok.assignees.map((a) => a.weight)).toEqual([60, 40]);
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "percentage",
        assignees: [
          { user_id: "u1", display_name: "A", weight: 60 },
          { user_id: "u2", display_name: "B", weight: 30 },
        ],
      }),
    ).toThrow(/exactly 100% \(currently 90%\)/);
  });

  it("excludes inactive members from the percentage total", () => {
    const valid = validateTableConfig({
      enabled: true,
      mode: "percentage",
      assignees: [
        { user_id: "u1", display_name: "A", weight: 100 },
        { user_id: "u2", display_name: "B", weight: 50, is_active: false },
      ],
    });
    expect(valid.assignees[1].is_active).toBe(false);
  });

  it("rejects bad contacts, duplicates, and empty enabled configs", () => {
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [{ user_id: "u1", display_name: "  " }],
      }),
    ).toThrow(/display name/);
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [{ display_name: "X", email: "bad" }],
      }),
    ).toThrow(/invalid email/);
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [{ display_name: "X", phone: "123" }],
      }),
    ).toThrow(/invalid phone/);
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [{ display_name: "No contact" }],
      }),
    ).toThrow(/at least an email address or phone number/);
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [
          { user_id: "u1", display_name: "A", email: "a@x.com" },
          { user_id: "u1", display_name: "B", email: "b@x.com" },
        ],
      }),
    ).toThrow(/only once/);
    expect(() =>
      validateTableConfig({ enabled: true, mode: "round_robin", assignees: [] }),
    ).toThrow(/at least one assignee/);
    // Disabled configs may be saved empty (draft state).
    expect(
      validateTableConfig({ enabled: false, mode: "round_robin", assignees: [] }).enabled,
    ).toBe(false);
  });
});
