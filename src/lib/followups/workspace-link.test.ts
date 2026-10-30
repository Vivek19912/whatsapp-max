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
  kpiBucketRange,
  localDayWindow,
  localDayWindowOffset,
  mergeLinkedFollowupMessage,
  resolveRecipientUpdate,
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
  it("generates the compact default with lead name and phone", () => {
    expect(
      buildWorkspaceFollowupMessage({
        name: "Rahul Sharma",
        phone: "+919999999999",
      }),
    ).toBe("Rahul Sharma, +919999999999");
  });

  it("uses the example lead from the product spec", () => {
    expect(
      buildWorkspaceFollowupMessage({ name: "Arman Bhangu", phone: "9789454" }),
    ).toBe("Arman Bhangu, 9789454");
    expect(
      buildWorkspaceFollowupMessage({ name: "Mohan", phone: "9876543210" }),
    ).toBe("Mohan, 9876543210");
  });

  it("falls back to the name alone when the phone is missing", () => {
    expect(buildWorkspaceFollowupMessage({ name: "Asha", phone: null })).toBe("Asha");
    expect(buildWorkspaceFollowupMessage({ name: "Asha", phone: "   " })).toBe("Asha");
  });

  it("falls back to the phone alone when the name is missing", () => {
    expect(buildWorkspaceFollowupMessage({ name: "   ", phone: "+91111" })).toBe("+91111");
    expect(buildWorkspaceFollowupMessage({ name: null, phone: "+91111" })).toBe("+91111");
  });

  it("returns an empty default when both are missing, without leaking variables", () => {
    expect(buildWorkspaceFollowupMessage({})).toBe("");
    expect(buildWorkspaceFollowupMessage({ name: null, phone: null })).toBe("");
    expect(buildWorkspaceFollowupMessage({})).not.toMatch(/undefined|null|\{\{/);
  });
});

describe("mergeLinkedFollowupMessage", () => {
  const def = "Rushikesh S More, 919130287749";
  const saved = "Call Rushikesh regarding the Dubai package.";

  it("loads the exact saved message over an untouched default", () => {
    expect(mergeLinkedFollowupMessage(def, def, saved)).toBe(saved);
  });

  it("preserves agent-typed text instead of overwriting it", () => {
    expect(mergeLinkedFollowupMessage("Custom text", def, saved)).toBe("Custom text");
  });

  it("preserves a deliberately cleared field", () => {
    expect(mergeLinkedFollowupMessage("", def, saved)).toBe("");
  });

  it("keeps the default when there is no linked message", () => {
    expect(mergeLinkedFollowupMessage(def, def, null)).toBe(def);
    expect(mergeLinkedFollowupMessage(def, def, "")).toBe(def);
    expect(mergeLinkedFollowupMessage(def, def, undefined)).toBe(def);
  });
});

describe("resolveRecipientUpdate", () => {
  const profile = "919876543210";

  it("creates with the profile snapshot and no custom flag when nothing is entered", () => {
    expect(resolveRecipientUpdate(null, null, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
  });

  it("marks an override custom only when it differs from Settings", () => {
    expect(resolveRecipientUpdate(null, "919123456789", profile)).toEqual({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
    expect(resolveRecipientUpdate(null, profile, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
  });

  it("falls back to a null profile only with an explicit override", () => {
    expect(resolveRecipientUpdate(null, "919123456789", null)).toEqual({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
    expect(resolveRecipientUpdate(null, null, null)).toEqual({
      recipient_phone: null,
      recipient_custom: false,
    });
  });

  it("keeps an unchanged row's stored pair untouched on resave", () => {
    const stored = { recipient_phone: "919111111111", recipient_custom: true };
    expect(resolveRecipientUpdate(stored, "919111111111", profile)).toEqual({
      recipient_phone: "919111111111",
      recipient_custom: true,
    });
    const snapshot = { recipient_phone: profile, recipient_custom: false };
    expect(resolveRecipientUpdate(snapshot, profile, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
  });

  it("reverting to the Settings number clears the custom flag", () => {
    const stored = { recipient_phone: "919111111111", recipient_custom: true };
    expect(resolveRecipientUpdate(stored, profile, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
  });

  it("an omitted recipient never rewrites stored history", () => {
    const stored = { recipient_phone: "919111111111", recipient_custom: true };
    expect(resolveRecipientUpdate(stored, null, profile)).toEqual({
      recipient_phone: "919111111111",
      recipient_custom: true,
    });
  });
});

describe("resolveRecipientUpdate", () => {
  const profile = "919876543210";

  it("creates with the profile snapshot and no custom flag when nothing is entered", () => {
    expect(resolveRecipientUpdate(null, null, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
    expect(resolveRecipientUpdate(null, null, null)).toEqual({
      recipient_phone: null,
      recipient_custom: false,
    });
  });

  it("marks an override custom only when it differs from Settings", () => {
    expect(resolveRecipientUpdate(null, "919123456789", profile)).toEqual({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
    expect(resolveRecipientUpdate(null, profile, profile)).toEqual({
      recipient_phone: profile,
      recipient_custom: false,
    });
    expect(resolveRecipientUpdate(null, "919123456789", null)).toEqual({
      recipient_phone: "919123456789",
      recipient_custom: true,
    });
  });

  it("keeps an unchanged row's stored pair untouched on resave", () => {
    expect(
      resolveRecipientUpdate({ recipient_phone: "919111111111", recipient_custom: true }, "919111111111", profile),
    ).toEqual({ recipient_phone: "919111111111", recipient_custom: true });
    expect(
      resolveRecipientUpdate({ recipient_phone: profile, recipient_custom: false }, profile, profile),
    ).toEqual({ recipient_phone: profile, recipient_custom: false });
  });

  it("reverting to the Settings number clears the custom flag", () => {
    expect(
      resolveRecipientUpdate({ recipient_phone: "919111111111", recipient_custom: true }, profile, profile),
    ).toEqual({ recipient_phone: profile, recipient_custom: false });
  });

  it("an omitted recipient never rewrites stored history", () => {
    const stored = { recipient_phone: "919111111111", recipient_custom: true };
    expect(resolveRecipientUpdate(stored, null, profile)).toEqual({
      recipient_phone: "919111111111",
      recipient_custom: true,
    });
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

describe("localDayWindow / localDayWindowOffset (viewer-local day bounds)", () => {
  it("spans one viewer-local day as UTC instants", () => {
    // 2026-03-10 15:30 viewer-local of an arbitrary zone offset.
    const now = new Date(2026, 2, 10, 15, 30, 0);
    const w = localDayWindow(now);
    expect(new Date(w.start).getTime()).toBeLessThan(new Date(w.end).getTime());
    expect(new Date(w.end).getTime() - new Date(w.start).getTime()).toBe(
      24 * 60 * 60 * 1000 - 1,
    );
  });

  it("handles month-end and year-end boundaries", () => {
    const w = localDayWindowOffset(new Date(2026, 0, 31, 12, 0, 0), 1);
    const start = new Date(w.start);
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 1, 1]);
    const y = localDayWindowOffset(new Date(2026, 11, 31, 12, 0, 0), 1);
    const ys = new Date(y.start);
    expect([ys.getFullYear(), ys.getMonth(), ys.getDate()]).toEqual([2027, 0, 1]);
  });

  it("offsets whole civil days, not fixed 24h blocks", () => {
    const now = new Date(2026, 4, 10, 12, 0, 0);
    const t = localDayWindowOffset(now, 1);
    const s = new Date(t.start);
    expect([s.getFullYear(), s.getMonth(), s.getDate()]).toEqual([2026, 4, 11]);
    expect(new Date(t.end).getTime() - new Date(t.start).getTime()).toBe(
      24 * 60 * 60 * 1000 - 1,
    );
  });
});

describe("kpiBucketRange (KPI card → server-side follow-up window)", () => {
  // Fixed viewer-local noon; bounds derive from local midnights so
  // every assertion uses calendar components and holds in any
  // timezone, across DST and month/year boundaries.
  const NOON = new Date(2026, 8, 24, 12, 0, 0);
  function bounds(now = NOON) {
    const today = localDayWindow(now);
    const tomorrow = localDayWindowOffset(now, 1);
    const dayAfter = localDayWindowOffset(now, 2);
    return {
      todayStart: today.start,
      tomorrowStart: tomorrow.start,
      dayAfterStart: dayAfter.start,
    };
  }
  function ymd(iso: string) {
    const d = new Date(iso);
    return [d.getFullYear(), d.getMonth(), d.getDate()];
  }

  it("maps each bucket to the documented half-open window", () => {
    const b = bounds();
    expect(kpiBucketRange("overdue", b)).toEqual({ from: null, to: b.todayStart });
    expect(kpiBucketRange("today", b)).toEqual({ from: b.todayStart, to: b.tomorrowStart });
    expect(kpiBucketRange("tomorrow", b)).toEqual({ from: b.tomorrowStart, to: b.dayAfterStart });
    expect(kpiBucketRange("upcoming", b)).toEqual({ from: b.tomorrowStart, to: null });
  });

  it("upcoming includes tomorrow (same lower bound)", () => {
    const b = bounds();
    expect(kpiBucketRange("upcoming", b).from).toBe(kpiBucketRange("tomorrow", b).from);
  });

  it("windows are contiguous and half-open: a midnight instant belongs to exactly one bucket", () => {
    const b = bounds();
    expect(kpiBucketRange("today", b).to).toBe(kpiBucketRange("tomorrow", b).from);
    expect(kpiBucketRange("tomorrow", b).to).toBe(b.dayAfterStart);
    expect(kpiBucketRange("upcoming", b).from).toBe(kpiBucketRange("tomorrow", b).from);
    expect(new Date(b.todayStart).getHours()).toBe(0);
    expect(new Date(b.tomorrowStart).getHours()).toBe(0);
  });

  it("handles month-end and year-end rollover", () => {
    const jan31 = bounds(new Date(2026, 0, 31, 12, 0, 0));
    expect(ymd(jan31.tomorrowStart)).toEqual([2026, 1, 1]);
    expect(ymd(jan31.dayAfterStart)).toEqual([2026, 1, 2]);
    const dec31 = bounds(new Date(2026, 11, 31, 12, 0, 0));
    expect(ymd(dec31.tomorrowStart)).toEqual([2027, 0, 1]);
    expect(ymd(dec31.dayAfterStart)).toEqual([2027, 0, 2]);
  });
});
