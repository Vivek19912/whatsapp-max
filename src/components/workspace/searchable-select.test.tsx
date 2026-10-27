import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterSearchableOptions,
  SearchableSelect,
  type SearchableOption,
} from "./searchable-select";

const IANA_LIKE: SearchableOption[] = [
  { value: "Africa/Abidjan", label: "Africa/Abidjan" },
  { value: "America/New_York", label: "America/New_York", hint: "Eastern" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata", hint: "IST" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Pacific/Auckland", label: "Pacific/Auckland" },
  { value: "Pacific/Kiritimati", label: "Pacific/Kiritimati" },
];

describe("filterSearchableOptions — matching contract", () => {
  it("returns everything for an empty query, preserving order", () => {
    expect(filterSearchableOptions(IANA_LIKE, "")).toEqual(IANA_LIKE);
    expect(filterSearchableOptions(IANA_LIKE, "   ")).toEqual(IANA_LIKE);
  });

  it("matches case-insensitively across label, value, and hint", () => {
    expect(filterSearchableOptions(IANA_LIKE, "kolkata").map((o) => o.value)).toEqual([
      "Asia/Kolkata",
    ]);
    expect(filterSearchableOptions(IANA_LIKE, "EASTERN").map((o) => o.value)).toEqual([
      "America/New_York",
    ]);
    expect(filterSearchableOptions(IANA_LIKE, "ist").map((o) => o.value)).toEqual([
      "Asia/Kolkata",
    ]);
  });

  it("finds entries at the beginning and the end of long lists", () => {
    // Regression: the timezone dropdown must surface matches from
    // anywhere in the ~400-entry IANA list, not just the top.
    const first = filterSearchableOptions(IANA_LIKE, "abidjan");
    expect(first.map((o) => o.value)).toEqual(["Africa/Abidjan"]);
    const last = filterSearchableOptions(IANA_LIKE, "kiritimati");
    expect(last.map((o) => o.value)).toEqual(["Pacific/Kiritimati"]);
    // Shared-prefix matches keep list order (start before end).
    const pacific = filterSearchableOptions(IANA_LIKE, "pacific/");
    expect(pacific.map((o) => o.value)).toEqual(["Pacific/Auckland", "Pacific/Kiritimati"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSearchableOptions(IANA_LIKE, "mars/olympus")).toEqual([]);
  });
});

describe("filterSearchableOptions — real IANA list", () => {
  const zones: string[] =
    typeof Intl.supportedValuesOf === "function"
      ? (Intl.supportedValuesOf("timeZone") as string[])
      : [];

  it("matches the first and last zones of the real list", () => {
    if (zones.length === 0) return;
    const options = zones.map((z) => ({ value: z, label: z }));
    const first = zones[0];
    const last = zones[zones.length - 1];
    expect(filterSearchableOptions(options, first)).toContainEqual({
      value: first,
      label: first,
    });
    expect(filterSearchableOptions(options, last)).toContainEqual({
      value: last,
      label: last,
    });
  });

  it("matches a mid-list zone by city fragment", () => {
    if (!zones.includes("Asia/Kolkata")) return;
    const options = zones.map((z) => ({ value: z, label: z }));
    const hits = filterSearchableOptions(options, "kolkata").map((o) => o.value);
    expect(hits).toContain("Asia/Kolkata");
  });
});

describe("SearchableSelect — trigger rendering (closed state)", () => {
  it("renders the placeholder trigger without opening the popup", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        value=""
        options={[{ value: "a", label: "Alpha" }]}
        onChange={() => {}}
        placeholder="Pick one"
        ariaLabel="Pick one"
      />
    );
    expect(html).toContain("Pick one");
    expect(html).toContain('aria-haspopup="listbox"');
    // Closed popovers render no popup content (Base UI portals need
    // a DOM); the combobox input and option list mount on open.
    expect(html).not.toContain('role="listbox"');
  });

  it("shows the selected label once a value is picked", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        value="a"
        options={[{ value: "a", label: "Alpha" }]}
        onChange={() => {}}
        placeholder="Pick one"
        ariaLabel="Pick one"
      />
    );
    expect(html).toContain("Alpha");
    expect(html).not.toContain("Pick one</span>");
  });

  it("renders a disabled read-only trigger that shows the selection", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        value="a"
        options={[{ value: "a", label: "Alpha" }]}
        onChange={() => {
          throw new Error("must not fire when disabled");
        }}
        placeholder="Pick one"
        ariaLabel="Pick one"
        disabled
      />
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("disabled");
  });
});

describe("SearchableSelect — popover composition contract (regression)", () => {
  const src = readFileSync(
    `${process.cwd()}/src/components/workspace/searchable-select.tsx`,
    "utf8"
  );

  it("anchors width to the trigger with the stack's own CSS variable", () => {
    // Base UI exposes --anchor-width on the popup; the Radix
    // --radix-popover-trigger-width variable does not exist here
    // and silently detached the dropdown width from its trigger.
    expect(src).toContain("w-[var(--anchor-width)]");
    // The class must never reference the Radix variable, which
    // does not exist in this Base UI stack (it is only named in
    // the doc comment above as the thing to avoid).
    expect(src).not.toContain("w-[var(--radix-popover-trigger-width)]");
  });

  it("bounds the option list and never the wrapper", () => {
    // The cap must live on the element that actually scrolls.
    // A previous regression put max-h on the ScrollArea root
    // (which does not scroll), so the list grew unbounded.
    expect(src).toContain("max-h-[min(15rem,var(--available-height))]");
    expect(src).toContain("overflow-y-auto");
    expect(src).toContain("overscroll-contain");
    expect(src).not.toContain("ScrollArea");
  });

  it("flips above the trigger when there is no room below", () => {
    expect(src).toContain('side="bottom"');
    expect(src).toContain("collisionAvoidance");
    expect(src).toContain('side: "flip"');
    expect(src).toContain('align: "shift"');
    expect(src).toContain("collisionPadding");
  });

  it("supports keyboard selection without a mouse", () => {
    expect(src).toContain("onKeyDown");
    expect(src).toContain("ArrowDown");
    expect(src).toContain("ArrowUp");
    expect(src).toContain("Home");
    expect(src).toContain("End");
    expect(src).toContain("scrollIntoView");
    expect(src).toContain('role="combobox"');
    expect(src).toContain("aria-activedescendant");
    expect(src).toContain('aria-autocomplete="list"');
  });

  it("keeps the Escape/outside-click dismissal contract", () => {
    // Base UI Popover dismisses on Escape and outside pointer
    // press by default; assert no custom handler swallows them.
    expect(src).not.toContain("onEscapeKeyDown");
    expect(src).not.toContain("onPointerDownOutside");
    expect(src).not.toContain("modal");
  });
});
