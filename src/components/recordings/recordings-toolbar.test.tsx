import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RecordingsToolbar } from "./recordings-toolbar";
import {
  resetRecordingsFilters,
  type MemberOption,
  type RecordingsFilters,
} from "@/lib/recordings/library";

// ---------------------------------------------------------------------------
// RecordingsToolbar — labelled filter cards. SSR covers labels,
// selected values, options, and reset wiring; live selection
// behavior stays owned by the Base UI Select primitives and the
// tested page/API query builders.
// ---------------------------------------------------------------------------

const MEMBERS: MemberOption[] = [
  { user_id: "u-sagar", label: "Sagar" },
  { user_id: "u-vikas", label: "Vikas" },
];

function html(filters: RecordingsFilters = resetRecordingsFilters()) {
  return renderToStaticMarkup(
    <RecordingsToolbar
      filters={filters}
      onChange={() => {}}
      nowMs={new Date(2026, 9, 6, 12, 0).getTime()}
      timeZone="UTC"
      members={MEMBERS}
    />,
  );
}

describe("Filter labels and default values", () => {
  it("shows all five labels with their default selected values", () => {
    const out = html();
    for (const [label, value] of [
      ["Date", "Last 30 days"],
      ["Call type", "All types"],
      ["Direction", "All directions"],
      ["Salesperson", "All users"],
      ["Lead status", "All statuses"],
    ] as const) {
      expect(out).toContain(`>${label}<`);
      expect(out).toContain(`>${value}<`);
    }
  });

  it("never shows a bare all/all-types value without its label context", () => {
    // A standalone `all` (the old ambiguous trigger text) must not
    // appear as a bare element; every "All …" value is contextual.
    expect(html()).not.toMatch(/>\s*all\s*</i);
  });

  it("keeps every existing option available", () => {
    const toolbar = readFileSync(
      `${process.cwd()}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    for (const item of [
      'value="today"',
      'value="yesterday"',
      'value="last7"',
      'value="last30"',
      'value="last90"',
      'value="custom"',
      'value="phone"',
      'value="whatsapp"',
      'value="in"',
      'value="out"',
      'value="unknown"',
      'value="linked"',
      'value="unlinked"',
    ]) {
      expect(toolbar).toContain(item);
    }
  });
});

describe("Labels stay visible after selection", () => {
  it("keeps the label beside a specific selected value", () => {
    const out = html({
      ...resetRecordingsFilters(),
      rangeKey: "today",
      callType: "phone",
      direction: "in",
      uploadedBy: "u-sagar",
      status: "linked",
    });
    for (const [label, value] of [
      ["Date", "Today"],
      ["Call type", "Phone"],
      ["Direction", "Incoming"],
      ["Salesperson", "Sagar"],
      ["Lead status", "Linked"],
    ] as const) {
      expect(out).toContain(`>${label}<`);
      expect(out).toContain(`>${value}<`);
    }
  });

  it("shows custom date inputs only for the custom range", () => {
    expect(html()).not.toContain('aria-label="Custom start date"');
    const out = html({ ...resetRecordingsFilters(), rangeKey: "custom" });
    expect(out).toContain('aria-label="Custom start date"');
    expect(out).toContain('aria-label="Custom end date"');
  });
});

describe("Search and Clear filters", () => {
  it("keeps the search field", () => {
    const out = html();
    expect(out).toContain('aria-label="Search lead name or phone number"');
    expect(out).toContain("Search lead name, phone number...");
  });

  it("labels the reset action Clear filters", () => {
    expect(html()).toContain(">Clear filters<");
    expect(html()).not.toMatch(/>Clear</);
  });

  it("resetRecordingsFilters restores every default (Clear contract)", () => {
    expect(resetRecordingsFilters()).toEqual({
      q: "",
      rangeKey: "last30",
      customFrom: "",
      customTo: "",
      callType: null,
      direction: null,
      uploadedBy: null,
      status: null,
    });
  });

  it("toolbar and page share one reset source", () => {
    const root = process.cwd();
    const toolbar = readFileSync(
      `${root}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    const page = readFileSync(
      `${root}/src/app/(dashboard)/recordings/page.tsx`,
      "utf8",
    );
    expect(toolbar).toContain("resetRecordingsFilters()");
    expect(page).toContain("resetRecordingsFilters()");
  });
});
