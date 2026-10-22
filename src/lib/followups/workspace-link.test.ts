// Workspace follow-up → reminder link (pure helpers).
//
// Pins the association contract:
//   * exactly one linkage discriminator, shared by API + UI;
//   * the canonical follow-up column matches case-insensitively;
//   * default messages never leak undefined/null/template text;
//   * invalid instants never render "Invalid Date".

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_FOLLOWUP_FIELD_NAME,
  WORKSPACE_FOLLOWUP_SOURCE_KIND,
  buildWorkspaceFollowupMessage,
  combineFollowupDateTime,
  formatWorkspaceFollowupDateTime,
  isWorkspaceFollowupFieldName,
  splitFollowupDateTime,
  validateFollowupDateTime,
} from "./workspace-link";

describe("workspace follow-up link identity", () => {
  it("exposes a single stable discriminator and field name", () => {
    expect(WORKSPACE_FOLLOWUP_SOURCE_KIND).toBe("meta_workspace_followup");
    expect(WORKSPACE_FOLLOWUP_FIELD_NAME).toBe("next follow-up date & time");
  });

  it("matches the canonical follow-up column case-insensitively", () => {
    expect(isWorkspaceFollowupFieldName("Next Follow-up Date & Time")).toBe(true);
    expect(
      isWorkspaceFollowupFieldName("  next FOLLOW-UP date & time  "),
    ).toBe(true);
    expect(isWorkspaceFollowupFieldName("Lead Source")).toBe(false);
    expect(isWorkspaceFollowupFieldName("")).toBe(false);
    expect(isWorkspaceFollowupFieldName(null)).toBe(false);
    expect(isWorkspaceFollowupFieldName(undefined)).toBe(false);
  });
});

describe("buildWorkspaceFollowupMessage", () => {
  it("generates the default message with lead name and phone", () => {
    expect(
      buildWorkspaceFollowupMessage({
        name: "Rahul Sharma",
        phone: "+919999999999",
      }),
    ).toBe(
      "Follow up with Rahul Sharma\nPhone: +919999999999\n\nRemember to contact this lead at the scheduled time.",
    );
  });

  it("handles a missing name gracefully", () => {
    const message = buildWorkspaceFollowupMessage({
      name: "   ",
      phone: "+91111",
    });
    expect(message).toContain("Follow up with this lead");
    expect(message).toContain("Phone: +91111");
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });

  it("omits the Phone line when the phone is missing", () => {
    const message = buildWorkspaceFollowupMessage({ name: "Asha", phone: null });
    expect(message).toBe(
      "Follow up with Asha\n\nRemember to contact this lead at the scheduled time.",
    );
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });

  it("handles both missing without leaking template variables", () => {
    const message = buildWorkspaceFollowupMessage({});
    expect(message).toBe(
      "Follow up with this lead\n\nRemember to contact this lead at the scheduled time.",
    );
    expect(message).not.toMatch(/undefined|null|\{\{/);
  });
});

describe("follow-up date/time combine + split (viewer-local, no server TZ)", () => {
  it("combines a picked date and time into the exact local instant", () => {
    // Oct 27 2026, 2:35 PM in the viewer's zone — the reported case.
    expect(combineFollowupDateTime("2026-10-27", "14:35")).toBe(
      new Date(2026, 9, 27, 14, 35, 0, 0).toISOString(),
    );
  });

  it("round-trips through split without shifting a minute", () => {
    for (const [date, time] of [
      ["2026-10-27", "14:35"],
      ["2026-10-27", "00:00"],
      ["2026-10-27", "23:59"],
      ["2026-02-28", "09:05"],
      ["2026-12-31", "18:20"],
    ] as Array<[string, string]>) {
      const iso = combineFollowupDateTime(date, time)!;
      expect(iso).not.toBeNull();
      expect(splitFollowupDateTime(iso)).toEqual({ date, time });
      // Stable across repeated saves: combining the split parts
      // yields the identical instant (no drift, no double conversion).
      const again = splitFollowupDateTime(iso)!;
      expect(combineFollowupDateTime(again.date, again.time)).toBe(iso);
    }
  });

  it("keeps AM/PM and minute precision distinct", () => {
    const am = combineFollowupDateTime("2026-10-27", "02:35")!;
    const pm = combineFollowupDateTime("2026-10-27", "14:35")!;
    expect(new Date(pm).getTime() - new Date(am).getTime()).toBe(12 * 60 * 60 * 1000);
    expect(splitFollowupDateTime(pm)).toEqual({ date: "2026-10-27", time: "14:35" });
  });

  it("matches a viewer-local Date construction exactly (no UTC assumption)", () => {
    // The old bug: the wall-clock string was re-parsed as UTC on the
    // server. The fixed path must equal a locally-constructed instant.
    const iso = combineFollowupDateTime("2026-10-27", "12:50")!;
    expect(new Date(iso).getTime()).toBe(new Date(2026, 9, 27, 12, 50, 0, 0).getTime());
  });

  it("does not reinterpret the wall clock as UTC", () => {
    const iso = combineFollowupDateTime("2026-10-27", "12:50")!;
    if (new Date(2026, 9, 27, 12, 50).getTimezoneOffset() !== 0) {
      expect(iso).not.toBe("2026-10-27T12:50:00.000Z");
    }
    expect(new Date(iso).getTime()).toBe(new Date(2026, 9, 27, 12, 50).getTime());
  });

  it("pins the reported case: 12:50 picked stays 12:50 displayed (IST zone)", () => {
    // Regression test for "repeatedly shows 06:20 PM": a UTC-server
    // parse of the IST wall clock stored 12:50Z, which displayed as
    // 18:20 IST. Combining in the viewer zone fixes it.
    const prev = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const probe = new Date(2026, 0, 1, 12, 0, 0);
      if (probe.getTimezoneOffset() !== -330) {
        // Zone data unavailable on this machine: assert the portable
        // invariant instead of a zone-specific string.
        const iso = combineFollowupDateTime("2026-10-27", "12:50")!;
        expect(new Date(iso).getTime()).toBe(new Date(2026, 9, 27, 12, 50).getTime());
        return;
      }
      const iso = combineFollowupDateTime("2026-10-27", "12:50")!;
      expect(iso).toBe("2026-10-27T07:20:00.000Z");
      expect(splitFollowupDateTime(iso)).toEqual({ date: "2026-10-27", time: "12:50" });
      expect(formatWorkspaceFollowupDateTime(iso)).toContain("12:50");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("rejects malformed inputs without throwing", () => {
    expect(combineFollowupDateTime("", "14:35")).toBeNull();
    expect(combineFollowupDateTime("2026-10-27", "")).toBeNull();
    expect(combineFollowupDateTime(null, "14:35")).toBeNull();
    expect(combineFollowupDateTime("2026-10-27", null)).toBeNull();
    expect(combineFollowupDateTime("27-10-2026", "14:35")).toBeNull();
    expect(combineFollowupDateTime("2026-13-01", "14:35")).toBeNull();
    expect(combineFollowupDateTime("2026-02-30", "14:35")).toBeNull();
    expect(combineFollowupDateTime("2026-10-27", "2:35pm")).toBeNull();
    expect(combineFollowupDateTime("2026-10-27", "24:00")).toBeNull();
    expect(combineFollowupDateTime("2026-10-27", "14:75")).toBeNull();
  });

  it("split returns null for missing or unparseable stored values", () => {
    expect(splitFollowupDateTime(null)).toBeNull();
    expect(splitFollowupDateTime("")).toBeNull();
    expect(splitFollowupDateTime("not-a-date")).toBeNull();
  });
});

describe("validateFollowupDateTime", () => {
  const now = new Date(2026, 9, 26, 12, 0, 0, 0).getTime();

  it("accepts a future date and time", () => {
    expect(validateFollowupDateTime("2026-10-27", "14:35", now)).toBeNull();
  });

  it("requires both date and time", () => {
    expect(validateFollowupDateTime("", "14:35", now)).toBe(
      "Choose a follow-up date and time.",
    );
    expect(validateFollowupDateTime("2026-10-27", "", now)).toBe(
      "Choose a follow-up date and time.",
    );
  });

  it("rejects invalid calendar values", () => {
    expect(validateFollowupDateTime("2026-02-30", "14:35", now)).toBe(
      "Enter a valid date and time.",
    );
  });

  it("rejects past times without shifting them", () => {
    expect(validateFollowupDateTime("2026-10-26", "11:00", now)).toBe(
      "Choose a date and time in the future.",
    );
    expect(validateFollowupDateTime("not-a-date", "14:35", now)).not.toBeNull();
  });
});

describe("formatWorkspaceFollowupDateTime", () => {
  it("renders a readable local instant", () => {
    const text = formatWorkspaceFollowupDateTime("2026-10-22T10:30:00.000Z");
    expect(text).not.toBe("—");
    expect(text).not.toMatch(/Invalid/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("falls back to an em dash for missing or invalid input", () => {
    expect(formatWorkspaceFollowupDateTime(null)).toBe("—");
    expect(formatWorkspaceFollowupDateTime(undefined)).toBe("—");
    expect(formatWorkspaceFollowupDateTime("")).toBe("—");
    expect(formatWorkspaceFollowupDateTime("not-a-date")).toBe("—");
  });
});
