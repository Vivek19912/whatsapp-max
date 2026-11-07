import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RecordingsToolbar } from "./recordings-toolbar";
import {
  resetRecordingsFilters,
  type MemberOption,
  type RecordingsFilters,
  type WorkspaceTableOption,
} from "@/lib/recordings/library";

// ---------------------------------------------------------------------------
// RecordingsToolbar — labelled filter cards. SSR covers labels,
// selected values, options, and reset wiring; live selection
// behavior stays owned by the Base UI primitives and the tested
// page/API query builders.
// ---------------------------------------------------------------------------

const MEMBERS: MemberOption[] = [
  { user_id: "u-sagar", label: "Sagar" },
  { user_id: "u-vikas", label: "Vikas" },
];

const TABLES: WorkspaceTableOption[] = [
  { flow_id: "f-meta", name: "Meta Lead Ads" },
  { flow_id: "f-kashmir", name: "Instant Form for Couple Kashmir" },
];

function html(filters: RecordingsFilters = resetRecordingsFilters()) {
  return renderToStaticMarkup(
    <RecordingsToolbar
      filters={filters}
      onChange={() => {}}
      nowMs={new Date(2026, 9, 6, 12, 0).getTime()}
      timeZone="UTC"
      members={MEMBERS}
      tables={TABLES}
    />,
  );
}

describe("Filter labels and default values", () => {
  it("shows all six labels with their default selected values", () => {
    const out = html();
    for (const [label, value] of [
      ["Date", "Last 30 days"],
      ["Call type", "All types"],
      ["Direction", "All directions"],
      ["Salesperson", "All users"],
      ["Workspace Table", "All tables"],
      ["Lead status", "All statuses"],
    ] as const) {
      expect(out).toContain(`>${label}<`);
      expect(out).toContain(`>${value}<`);
    }
  });

  it("never shows a bare all value without its label context", () => {
    // A standalone `all` (the old ambiguous trigger text) must not
    // appear as a bare element; every "All …" value is contextual.
    expect(html()).not.toMatch(/>\s*all\s*</i);
  });

  it("keeps every existing option available", () => {
    const toolbar = readFileSync(
      `${process.cwd()}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    // Date presets live in the popover menu; every other filter
    // keeps its Select items with identical values.
    for (const preset of [
      "key: 'today'",
      "key: 'yesterday'",
      "key: 'last7'",
      "key: 'last30'",
      "key: 'last90'",
    ]) {
      expect(toolbar).toContain(preset);
    }
    for (const item of [
      'value="phone"',
      'value="whatsapp"',
      'value="in"',
      'value="out"',
      'value="unknown"',
      'value="linked"',
      'value="unlinked"',
      'value="all"',
    ]) {
      expect(toolbar).toContain(item);
    }
    // Custom is a popover menu entry that reveals the range
    // section (never an instantly-applied Select item).
    expect(toolbar).toContain("Custom date range");
    expect(toolbar).toContain("onClick={() => setCustomOpen(true)}");
  });

  it("uses roomier spacing between controls", () => {
    const toolbar = readFileSync(
      `${process.cwd()}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    expect(toolbar).toContain("gap-3");
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
      workspaceTable: "f-meta",
      status: "linked",
    });
    for (const [label, value] of [
      ["Date", "Today"],
      ["Call type", "Phone"],
      ["Direction", "Incoming"],
      ["Salesperson", "Sagar"],
      ["Workspace Table", "Meta Lead Ads"],
      ["Lead status", "Linked"],
    ] as const) {
      expect(out).toContain(`>${label}<`);
      expect(out).toContain(`>${value}<`);
    }
  });
});

describe("Workspace Table filter", () => {
  it("lists the authorized workspace tables plus All tables", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    // Options render client-side inside the dropdown; SSR pins the
    // wiring (options prop → items, selection → query value).
    expect(src).toContain('ariaLabel="Workspace Table"');
    expect(src).toContain("{tables.map((t) => (");
    expect(src).toContain("All tables");
    // Selection maps to the nullable filter the query builders
    // send as `workspace_table` (covered in library.test.ts).
    expect(src).toContain("workspaceTable: v === 'all' ? null : v");
  });

  it("shows the selected table name on the card", () => {
    const out = html({
      ...resetRecordingsFilters(),
      workspaceTable: "f-kashmir",
    });
    expect(out).toContain(">Workspace Table<");
    expect(out).toContain(">Instant Form for Couple Kashmir<");
  });

  it("sizes the menu to its longest option and wraps instead of truncating", () => {
    const root = process.cwd();
    const toolbar = readFileSync(
      `${root}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );
    // Opt-in wide menu on the Workspace Table filter only: popup
    // grows with content (trigger floor, viewport cap) instead of
    // locking to the trigger width.
    expect(toolbar).toContain("wideContent");
    expect(toolbar).toContain("w-max min-w-(--anchor-width) max-w-[calc(100vw-2rem)]");
    // Option text wraps (never ellipsis); the checkmark column
    // stays reserved so wrapped lines never overlap it.
    expect(toolbar).toContain("[&>span]:whitespace-normal");
    expect(toolbar).toContain("break-words");
    // No other filter opts into the wide menu: exactly one
    // FilterSelect call site passes the bare `wideContent` prop
    // (the Workspace Table).
    const wideUses = toolbar.match(/^ {8}wideContent$/gm) ?? [];
    expect(wideUses).toHaveLength(1);
  });

  it("renders the menu in a portal above surrounding content", () => {
    const popup = readFileSync(
      `${process.cwd()}/src/components/ui/select.tsx`,
      "utf8",
    );
    expect(popup).toContain("SelectPrimitive.Portal");
    expect(popup).toContain("isolate z-50");
  });
});

describe("Custom date range popover", () => {
  const src = () =>
    readFileSync(
      `${process.cwd()}/src/components/recordings/recordings-toolbar.tsx`,
      "utf8",
    );

  it("keeps standalone date fields out of the filter bar", () => {
    const out = html({ ...resetRecordingsFilters(), rangeKey: "custom" });
    // Closed popovers unmount their content: no date inputs leak
    // into the bar itself.
    expect(out).not.toContain('aria-label="Custom start date"');
    expect(out).not.toContain('aria-label="Custom end date"');
  });

  it("groups start/end, validation, and Apply/Cancel in one popover", () => {
    expect(src()).toContain("Custom date range");
    expect(src()).toContain('aria-label="Custom start date"');
    expect(src()).toContain('aria-label="Custom end date"');
    expect(src()).toContain("onClick={applyCustom}");
    expect(src()).toContain("Apply");
    expect(src()).toContain("Cancel");
    expect(src()).toContain("End date must be after the start date.");
  });

  it("applies only on Apply and discards on Cancel", () => {
    // Drafts commit through one guarded path; closing the
    // popover (Cancel / outside / Escape) never calls set().
    expect(src()).toContain("if (!isValidRange(draftFrom, draftTo)) return;");
    expect(src()).toContain(
      "set({ rangeKey: 'custom', customFrom: draftFrom, customTo: draftTo });",
    );
  });

  it("displays the applied range on the Date card", () => {
    const out = html({
      ...resetRecordingsFilters(),
      rangeKey: "custom",
      customFrom: "2026-11-07",
      customTo: "2026-11-15",
    });
    expect(out).toContain(">Date<");
    expect(out).toContain("07 Nov – 15 Nov 2026");
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
      workspaceTable: null,
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
