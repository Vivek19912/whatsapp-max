// Per-table assignment validation — India-only (Asia/Kolkata).
// Emails, phones, pause math, percentage totals. Pure: no mocks,
// no database.

import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_TIMEZONE,
  AssignmentValidationError,
  endOfTodayUtc,
  formatPausedUntil,
  isValidAssigneeEmail,
  isValidTimezone,
  normalizeAssigneePhone,
  validatePauseInput,
  validateTableConfig,
  wallClockInZoneToUtc,
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

  it("pins assignment to Asia/Kolkata", () => {
    expect(ASSIGNMENT_TIMEZONE).toBe("Asia/Kolkata");
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

  it("converts IST wall readings to UTC without a hardcoded offset", () => {
    // 14:30 IST wall = 09:00 UTC, resolved through the zone database.
    expect(new Date(wallClockInZoneToUtc("2026-10-26T14:30", "Asia/Kolkata")).toISOString()).toBe(
      "2026-10-26T09:00:00.000Z",
    );
    // Seconds are honored; garbage is NaN (rejected upstream).
    expect(new Date(wallClockInZoneToUtc("2026-10-26T14:30:45", "Asia/Kolkata")).toISOString()).toBe(
      "2026-10-26T09:00:45.000Z",
    );
    expect(wallClockInZoneToUtc("not-a-date", "Asia/Kolkata")).toBeNaN();
    expect(wallClockInZoneToUtc("2026-10-26T14:30", "Mars/Olympus")).toBeNaN();
  });
});

describe("validatePauseInput", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("resumes immediately and clears the window", () => {
    expect(validatePauseInput({ mode: "resume" }, now)).toEqual({
      paused_until: null,
      reason: null,
      scope: "table",
      timezone: "Asia/Kolkata",
    });
  });

  it("pauses for today at IST midnight, whatever zone is supplied", () => {
    // Noon UTC = 17:30 IST: today ends 2026-10-26T23:59:59.999+05:30.
    for (const input of [
      { mode: "today" },
      { mode: "today", timezone: "Asia/Kolkata" },
      // Legacy per-table zones normalize to IST instead of rejecting.
      { mode: "today", timezone: "America/New_York" },
      { mode: "today", timezone: "UTC" },
      { mode: "today", timezone: "Mars/Olympus" },
    ]) {
      const pause = validatePauseInput(input, now);
      expect(pause.paused_until).toBe("2026-10-26T18:29:59.999Z");
      expect(pause.timezone).toBe("Asia/Kolkata");
      expect(pause.scope).toBe("table");
    }
  });

  it("pauses for N days and keeps a reason", () => {
    const pause = validatePauseInput(
      { mode: "days", days: 3, reason: "On leave", scope: "account" },
      now,
    );
    expect(pause.paused_until).toBe("2026-10-29T12:00:00.000Z");
    expect(pause.reason).toBe("On leave");
    expect(pause.scope).toBe("account");
    expect(pause.timezone).toBe("Asia/Kolkata");
  });

  it("pauses until an explicit future instant", () => {
    const pause = validatePauseInput({ mode: "until", until: "2026-11-05T09:00:00Z" }, now);
    expect(pause.paused_until).toBe("2026-11-05T09:00:00.000Z");
  });

  it("interprets a zone-less wall reading as IST wall time", () => {
    // 14:30 IST wall = 09:00 UTC — never the server's local midnight math.
    const pause = validatePauseInput({ mode: "until", until: "2026-11-05T14:30" }, now);
    expect(pause.paused_until).toBe("2026-11-05T09:00:00.000Z");
    expect(pause.timezone).toBe("Asia/Kolkata");
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

  it("normalizes any supplied timezone to IST", () => {
    for (const timezone of [undefined, "UTC", "Asia/Kolkata", "America/New_York"]) {
      const valid = validateTableConfig({
        enabled: false,
        mode: "round_robin",
        timezone,
        assignees: [],
      });
      expect(valid.timezone).toBe("Asia/Kolkata");
    }
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

  it("rejects bad contacts and duplicates with clear client errors", () => {
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
  });

  it("requires an email address for external assignees with email alerts on", () => {
    // A phone-only external contact can never receive an email —
    // block the misconfiguration at save time instead of failing
    // silently later. Internal members may rely on the roster email.
    expect(() =>
      validateTableConfig({
        enabled: true,
        mode: "round_robin",
        assignees: [{ display_name: "X", phone: "+15551234567", notify_email: true }],
      }),
    ).toThrow(/needs an email address because Email alerts are on/);
    const ok = validateTableConfig({
      enabled: true,
      mode: "round_robin",
      assignees: [
        { display_name: "X", phone: "+15551234567", notify_email: false },
        { user_id: "u1", display_name: "A", notify_email: true },
      ],
    });
    expect(ok.assignees).toHaveLength(2);
  });

  it("marks every config rejection as a 400 client error", () => {
    // The assignment API maps this class to HTTP 400 with the
    // message; anything else stays a generic 500.
    const cases: Array<Record<string, unknown>> = [
      { enabled: true, mode: "round_robin", assignees: [{ display_name: "  " }] },
      { enabled: true, mode: "bogus", assignees: [] },
      {
        enabled: true,
        mode: "percentage",
        assignees: [
          { user_id: "u1", display_name: "A", weight: 60 },
          { user_id: "u2", display_name: "B", weight: 30 },
        ],
      },
    ];
    for (const input of cases) {
      try {
        validateTableConfig(input);
        expect.unreachable(`expected a validation error for ${JSON.stringify(input)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AssignmentValidationError);
        expect((err as AssignmentValidationError).status).toBe(400);
      }
    }
  });

  it("accepts an empty roster with the toggle either way, in both modes", () => {
    // Regression: deleting the last assignee and saving returned a
    // generic 500. An empty roster is valid — new leads simply stay
    // unassigned — and the toggle/mode are preserved as configured.
    for (const mode of ["round_robin", "percentage"] as const) {
      for (const enabled of [true, false]) {
        const valid = validateTableConfig({ enabled, mode, assignees: [] });
        expect(valid.assignees).toEqual([]);
        expect(valid.enabled).toBe(enabled);
        expect(valid.mode).toBe(mode);
      }
    }
  });

  it("requires no 100% total when percentage mode has zero active assignees", () => {
    // All-inactive rosters (and empty rosters) need no share total,
    // enabled or not; a single active member at 100% still passes.
    for (const enabled of [true, false]) {
      const valid = validateTableConfig({
        enabled,
        mode: "percentage",
        assignees: [{ user_id: "u1", display_name: "A", weight: 0, is_active: false }],
      });
      expect(valid.assignees).toHaveLength(1);
      expect(valid.enabled).toBe(enabled);
    }
    expect(
      validateTableConfig({
        enabled: true,
        mode: "percentage",
        assignees: [{ user_id: "u1", display_name: "A", weight: 100 }],
      }).assignees,
    ).toHaveLength(1);
  });
});
