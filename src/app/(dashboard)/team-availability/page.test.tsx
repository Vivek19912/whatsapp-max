import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pageSrc = () =>
  readFileSync(`${root}/src/app/(dashboard)/team-availability/page.tsx`, "utf8");
const overviewSrc = () =>
  readFileSync(`${root}/src/app/api/team-availability/overview/route.ts`, "utf8");
const createSrc = () =>
  readFileSync(`${root}/src/app/api/team-availability/holidays/route.ts`, "utf8");
const editSrc = () =>
  readFileSync(`${root}/src/app/api/team-availability/holidays/[id]/route.ts`, "utf8");
const cancelSrc = () =>
  readFileSync(`${root}/src/app/api/team-availability/holidays/[id]/cancel/route.ts`, "utf8");

describe("team availability — owner-only access", () => {
  it("page hides from non-owners with an owner-only gate", () => {
    const src = pageSrc();
    expect(src).toContain('accountRole !== "owner"');
    expect(src).toContain("Owner only");
  });

  it("every team-availability API enforces requireRole(owner)", () => {
    for (const src of [overviewSrc(), createSrc(), editSrc(), cancelSrc()]) {
      expect(src).toContain('requireRole("owner")');
    }
  });
});

describe("team availability — dashboard sections", () => {
  it("renders the four KPI cards from saved data", () => {
    const src = pageSrc();
    for (const title of [
      "Total Team Members",
      "Available Today",
      "On Holiday",
      "Assignments Adjusted",
    ]) {
      expect(src).toContain(title);
    }
    expect(src).toContain("KpiCard");
  });

  it("has the add-holiday form with member, dates, reason, and notice", () => {
    const src = pageSrc();
    expect(src).toContain("Add Holiday / Leave");
    expect(src).toContain("Holiday start date");
    expect(src).toContain("Holiday end date");
    expect(src).toContain("Reason (optional)");
    expect(src).toContain("automatically excluded from new lead");
    expect(src).toContain("Set Holiday");
  });

  it("shows the member's full name in the dropdown trigger (never the UUID)", () => {
    const src = pageSrc();
    // The UUID stays the option value (submitted as-is); the
    // trigger label resolves back to the member's full name.
    expect(src).toContain("value={m.user_id}");
    expect(src).toContain("members.find((m) => m.user_id === memberId)?.full_name");
    expect(src).toContain("{selectedMemberName}");
    // The submit path still sends the stable UUID.
    expect(src).toContain("user_id: memberId");
  });

  it("has availability tabs, search, and the member table", () => {
    const src = pageSrc();
    for (const label of ["All Members", "On Holiday", "Available"]) {
      expect(src).toContain(label);
    }
    expect(src).toContain("Search team member...");
    for (const col of ["Availability", "Holiday Period", "Affects Assignment", "Actions"]) {
      expect(src).toContain(col);
    }
  });

  it("supports edit, cancel, and early-end actions", () => {
    const src = pageSrc();
    expect(src).toContain("Edit Holiday / Leave");
    expect(src).toContain("End holiday early");
    expect(src).toContain("Cancel holiday");
  });
});

describe("team availability — adjustment preview", () => {
  it("previews real round-robin and percentage configs without modifying them", () => {
    const src = pageSrc();
    expect(src).toContain("Assignment Adjustment Preview");
    expect(src).toContain("Round Robin Table Example");
    expect(src).toContain("Percentage Table Example");
    expect(src).toContain("This preview does not modify your saved assignment configuration.");
    expect(src).toContain("Illustrative example");
  });

  it("derives the adjusted shares with the shared normalizer", () => {
    expect(pageSrc()).toContain("normalizeAdjustedPercentages");
  });
});
