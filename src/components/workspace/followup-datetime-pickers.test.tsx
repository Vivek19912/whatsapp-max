import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  combineFollowupDateTime,
  splitFollowupDateTime,
  validateFollowupDateTime,
} from "@/lib/followups/workspace-link";

// ---------------------------------------------------------------------------
// Schedule Follow-up custom date/time pickers.
//
// The Base UI dialog portal renders nothing in static markup, so the
// popovers' rendered DOM cannot be asserted here. These tests lock
// the contract instead: native inputs gone, custom calendar + time
// lists present, value formats byte-identical to the native inputs
// they replace (so combine/validate/submission are untouched),
// single-open coordination, portal positioning, and accessibility.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pickersSrc = readFileSync(
  `${root}/src/components/workspace/followup-datetime-pickers.tsx`,
  "utf8",
);
const dialogSrc = readFileSync(
  `${root}/src/components/workspace/schedule-followup-dialog.tsx`,
  "utf8",
);

describe("native pickers replaced", () => {
  it("renders no browser-native date or time inputs", () => {
    expect(dialogSrc).not.toContain('type="date"');
    expect(dialogSrc).not.toContain('type="time"');
    expect(pickersSrc).not.toContain('type="date"');
    expect(pickersSrc).not.toContain('type="time"');
  });

  it("wires the custom fields with the same state the API consumes", () => {
    expect(dialogSrc).toContain("<FollowupDateField");
    expect(dialogSrc).toContain("<FollowupTimeField");
    expect(dialogSrc).toContain("value={date}");
    expect(dialogSrc).toContain("value={time}");
    expect(dialogSrc).toContain("onChange={setDate}");
    expect(dialogSrc).toContain("onChange={setTime}");
    // Submission path untouched: same validator, same combiner.
    expect(dialogSrc).toContain("validateFollowupDateTime(date, time)");
    expect(dialogSrc).toContain("combineFollowupDateTime(date, time)");
  });
});

describe("date picker (custom calendar)", () => {
  it("opens a month calendar with navigation, not a native popup", () => {
    expect(pickersSrc).toContain('mode="single"');
    expect(pickersSrc).toContain("onMonthChange={setMonth}");
    expect(pickersSrc).toContain("month={month}");
  });

  it("selects a day into YYYY-MM-DD state and closes", () => {
    expect(pickersSrc).toContain("onChange(toISODate(day))");
    expect(pickersSrc).toContain("getFullYear()}-");
    expect(pickersSrc).toContain("getMonth() + 1");
  });

  it("disables past dates (they can never validate)", () => {
    expect(pickersSrc).toContain("disabled={{ before: startOfToday() }}");
  });

  it("offers Today and Clear shortcuts", () => {
    expect(pickersSrc).toContain("Today");
    expect(pickersSrc).toContain("Clear");
    expect(pickersSrc).toContain('onChange("")');
  });

  it("reopening preserves the selected date's month", () => {
    expect(pickersSrc).toContain("if (open) setMonth(selected ?? startOfToday())");
  });

  it("highlights the selected date blue with a readable field format", () => {
    expect(pickersSrc).toContain("bg-blue-600");
    expect(pickersSrc).toContain('format(selected, "d MMM yyyy")');
  });
});

describe("time picker (hour/minute/period dropdowns)", () => {
  it("renders three compact horizontal selects, no scrolling lists", () => {
    expect(pickersSrc).toContain('aria-label="Hour"');
    expect(pickersSrc).toContain('aria-label="Minute"');
    expect(pickersSrc).toContain('aria-label="AM or PM"');
    expect(pickersSrc).toContain("grid-cols-[1fr_auto_1fr_1fr]");
    expect(pickersSrc).not.toContain('role="listbox"');
    expect(pickersSrc).not.toContain("max-h-44");
    expect(pickersSrc).not.toContain("scrollIntoView");
  });

  it("offers hours 01–12, minutes 00–59, and AM/PM", () => {
    expect(pickersSrc).toContain("Array.from({ length: 12 }");
    expect(pickersSrc).toContain("Array.from({ length: 60 }");
    expect(pickersSrc).toContain("<option value=\"AM\">AM</option>");
    expect(pickersSrc).toContain("<option value=\"PM\">PM</option>");
  });

  it("commits every dropdown change immediately in 24-hour HH:MM", () => {
    expect(pickersSrc).toContain("partsTo24Hour({ ...current, ...patch })");
    expect(pickersSrc).toContain("h12 % 12");
    expect(pickersSrc).toContain("(h12 % 12) + 12");
  });

  it("shows a 12-hour preview with a Done action", () => {
    expect(pickersSrc).toContain("formatParts12Hour(current)");
    expect(pickersSrc).toContain("Done");
  });

  it("reopening restores the committed time (derived from value)", () => {
    // No draft state exists to go stale: the selects read the
    // committed value on every render.
    expect(pickersSrc).toContain("parseTimeValue(value)");
    expect(pickersSrc).not.toContain("useState<TimeDraft>");
  });
});

describe("new-attempt defaults (tomorrow at 1:30 PM)", () => {
  it("prefills tomorrow + 13:30 only when no value is saved", () => {
    expect(dialogSrc).toContain("parts?.date ?? defaultFollowupDate()");
    expect(dialogSrc).toContain("parts?.time ?? DEFAULT_FOLLOWUP_TIME");
    expect(dialogSrc).toContain("DEFAULT_FOLLOWUP_TIME,");
    expect(dialogSrc).toContain("defaultFollowupDate,");
  });

  it("defines 1:30 PM as the default time constant", () => {
    const linkSrc = readFileSync(
      `${root}/src/lib/followups/workspace-link.ts`,
      "utf8",
    );
    expect(linkSrc).toContain('DEFAULT_FOLLOWUP_TIME = "13:30"');
    expect(linkSrc).toContain("export function defaultFollowupDate(");
    // Next LOCAL calendar day — setDate arithmetic, never +24h.
    expect(linkSrc).toContain("d.setDate(d.getDate() + 1)");
  });
});

describe("popover positioning (no overlap)", () => {
  it("renders both pickers through portaled, collision-aware popovers", () => {
    expect(pickersSrc).toContain("<Popover open={open} onOpenChange={onOpenChange}>");
    expect(pickersSrc).toContain("PopoverContent");
    expect(pickersSrc).toContain('side="bottom"');
  });

  it("never opens date and time simultaneously", () => {
    expect(dialogSrc).toContain('useState<"date" | "time" | null>(null)');
    expect(dialogSrc).toContain('open={pickerOpen === "date"}');
    expect(dialogSrc).toContain('open={pickerOpen === "time"}');
    expect(dialogSrc).toContain('setPickerOpen(open ? "date" : null)');
    expect(dialogSrc).toContain('setPickerOpen(open ? "time" : null)');
  });

  it("lays the fields out side by side on desktop, stacked on narrow screens", () => {
    expect(dialogSrc).toContain("grid-cols-1");
    expect(dialogSrc).toContain("sm:grid-cols-2");
  });
});

describe("accessibility", () => {
  it("labels both fields and their popovers", () => {
    expect(pickersSrc).toContain('aria-label="Follow-up date"');
    expect(pickersSrc).toContain('aria-label="Follow-up time"');
    expect(pickersSrc).toContain('aria-label="Choose follow-up date"');
    expect(pickersSrc).toContain('aria-label="Choose follow-up time"');
    expect(dialogSrc).toContain('htmlFor="fu-date"');
    expect(dialogSrc).toContain('htmlFor="fu-time"');
    expect(pickersSrc).toContain('id="fu-date"');
    expect(pickersSrc).toContain('id="fu-time"');
  });

  it("exposes options with listbox semantics and selection state", () => {
    expect(pickersSrc).toContain('role="group"');
    expect(pickersSrc).toContain('aria-label="Hour, minute, and period"');
  });
});

describe("scheduling semantics unchanged", () => {
  it("round-trips a stored instant through the field formats losslessly", () => {
    // What the pickers write (YYYY-MM-DD + HH:MM) recombines to the
    // exact stored instant — no precision or timezone drift.
    const iso = "2026-11-09T09:30:00.000Z";
    const parts = splitFollowupDateTime(iso);
    expect(parts).not.toBeNull();
    const back = combineFollowupDateTime(parts!.date, parts!.time);
    expect(back).not.toBeNull();
    expect(new Date(back!).getTime()).toBe(new Date(iso).getTime());
  });

  it("keeps the future-only validation rule (past picks rejected at save)", () => {
    expect(validateFollowupDateTime("", "")).toBe(
      "Choose a follow-up date and time.",
    );
    expect(
      validateFollowupDateTime("2000-01-01", "09:00", Date.now()),
    ).toBe("Choose a date and time in the future.");
    expect(
      validateFollowupDateTime("2099-01-01", "09:00", Date.now()),
    ).toBeNull();
  });

  it("keeps 12-hour noon/midnight boundaries exact", () => {
    // 12:30 PM and 12:30 AM combine to distinct, correct instants.
    const noon = combineFollowupDateTime("2026-11-09", "12:30");
    const midnight = combineFollowupDateTime("2026-11-09", "00:30");
    expect(noon).not.toBeNull();
    expect(midnight).not.toBeNull();
    expect(new Date(noon!).getTime() - new Date(midnight!).getTime()).toBe(
      12 * 60 * 60 * 1000,
    );
  });
});
