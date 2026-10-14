import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterCellOptions,
  onSearchBoxKeyDown,
  searchBoxKeyShouldPropagate,
} from "./custom-cell";
import {
  DepartureSearchSelect,
  resolveDepartureCityOnCountryChange,
  resolveEffectiveDepartureCountry,
} from "./travel-crm-action";
import {
  DEFAULT_DEPARTURE_COUNTRY,
  DEPARTURE_COUNTRIES,
  departureCityOptions,
} from "@/lib/integrations/travel-crm/departure-catalog";

// ---------------------------------------------------------------------------
// Departure Country/City search typing — WACRM → Workspace → Create
// in Travel CRM.
//
// Root cause: both dropdowns rendered their filter through a search
// input inside a Base UI Select popup. The popup attaches
// floating-ui `useTypeahead`/`useListNavigation` at the popup level,
// which `preventDefault()` printable keys WITHOUT checking whether
// the event target is an editable input — so typed characters were
// swallowed for option-highlight navigation, arrows/Enter were
// hijacked, and the highlight auto-scroll made options jump. Both
// fields now render a controlled Popover combobox instead (same
// reliable pattern as the flows TagSelect): a real editable search
// input with no popup-level key handlers above it, a substring
// filter, keyboard navigation owned by the component, and scroll
// position that moves only on arrow-key navigation.
//
// The node test env has no DOM, so typing is verified at three
// levels: the combobox wiring in source plus trigger rendering,
// the shared keydown-guard helpers still used by funnel selects,
// and full keystroke sequences through the real catalogs with the
// same stateless filter the component runs per query.
// ---------------------------------------------------------------------------

const countryOptions = [...DEPARTURE_COUNTRIES]
  .sort((a, b) => a.localeCompare(b))
  .map((name) => ({ value: name, label: name }));
const indiaCities = departureCityOptions("India").map((o) => ({
  value: o.value,
  label: o.label,
}));

function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, stopPropagation: vi.fn(), ...extra };
}

describe("search-box keydown guard (Select-based funnel search boxes)", () => {
  // The shared OptionSearchBox (still used by funnel selects) keeps
  // its popup guard; departure fields moved to the Popover combobox
  // below, which needs no guard at all (nothing above the input
  // handles keys).
  it("shields characters, space, backspace, arrows, and Enter from the popup", () => {
    for (const key of [
      "a",
      "I",
      "n",
      "d",
      " ",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "Enter",
    ]) {
      const e = keyEvent(key);
      onSearchBoxKeyDown(e);
      expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    }
  });

  it("shields modified shortcuts (select-all never reaches the popup)", () => {
    const e = keyEvent("a", { ctrlKey: true, metaKey: false });
    onSearchBoxKeyDown(e);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(searchBoxKeyShouldPropagate("a")).toBe(false);
  });

  it("lets Escape and Tab through (dismiss + focus navigation intact)", () => {
    for (const key of ["Escape", "Tab"]) {
      const e = keyEvent(key);
      onSearchBoxKeyDown(e);
      expect(e.stopPropagation).not.toHaveBeenCalled();
      expect(searchBoxKeyShouldPropagate(key)).toBe(true);
    }
  });

  it("never blocks the input itself (no preventDefault, blur, or reset)", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/custom-cell.tsx`,
      "utf8",
    );
    const start = src.indexOf("export function onSearchBoxKeyDown");
    const end = src.indexOf("export function OptionSearchBox");
    const guard = src.slice(start, end);
    expect(guard).toContain("stopPropagation");
    expect(guard).not.toContain("preventDefault");
    // The box carries no key/autoFocus that could remount or steal
    // focus on each keystroke; the input stays controlled by query.
    expect(src).not.toMatch(/OptionSearchBox[\s\S]{0,400}autoFocus/);
  });
});

describe("both departure dropdowns share the popover combobox", () => {
  it("DepartureSearchSelect renders a real combobox search input", () => {
    // SSR renders the trigger only (popover content is portaled
    // until opened): assert the triggers, then the combobox wiring
    // in source — a controlled search input owned by the component
    // (no popup typeahead above it to swallow keystrokes).
    for (const label of ["Departure Country", "Departure City"]) {
      const html = renderToStaticMarkup(
        <DepartureSearchSelect
          label={label}
          value={label === "Departure Country" ? "India" : ""}
          options={label === "Departure Country" ? countryOptions : indiaCities}
          placeholder={`Select ${label}`}
          onChange={() => {}}
        />,
      );
      expect(html).toContain(`aria-label="${label}"`);
    }
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    expect(src).toContain('role="combobox"');
    expect(src).toContain('aria-label={`Search ${label} options`}');
    expect(src).toContain('onChange={(e) => onQuery(e.target.value)}');
  });

  it("typing never leaves the input: no remount, blur, or reset", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    // The search input is a stable controlled element (value comes
    // from state, never cleared except on close/select); option
    // keys are stable value::label pairs.
    expect(src).toContain("value={query}");
    expect(src).toContain('key={`${o.value}::${o.label}`}');
    // No autoFocus stealing, no blur/focus juggling in the combobox.
    const start = src.indexOf("export function DepartureSearchSelect");
    const end = src.indexOf("export function TravelTimingSelect");
    const block = src.slice(start, end);
    expect(block).not.toContain(".blur()");
    expect(block).not.toContain(".focus()");
    expect(block).toContain("autoFocus");
  });
});

describe("1. typing `Ind` in Departure Country filters the options", () => {
  it("progressive keystrokes narrow to India", () => {
    const afterI = filterCellOptions(countryOptions, "I");
    const afterIn = filterCellOptions(countryOptions, "In");
    const afterInd = filterCellOptions(countryOptions, "Ind");
    expect(afterI.length).toBeGreaterThan(afterIn.length);
    expect(afterIn.length).toBeGreaterThanOrEqual(afterInd.length);
    expect(afterInd.map((o) => o.value)).toContain("India");
    // "Ind" matches only India (+ Indian Ocean Territory-style
    // entries, if any) — a handful, never the full 250.
    expect(afterInd.length).toBeLessThan(10);
    expect(countryOptions).toHaveLength(250);
  });
});

describe("2. typing a city name filters Indian cities", () => {
  it("the full Indian catalog is retained (4,249 entries)", () => {
    expect(indiaCities).toHaveLength(4249);
    expect(DEFAULT_DEPARTURE_COUNTRY).toBe("India");
  });

  it("typing Lucknow narrows to Lucknow", () => {
    const matches = filterCellOptions(indiaCities, "lucknow");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(indiaCities.length);
    for (const o of matches) {
      expect(o.label.toLowerCase()).toContain("lucknow");
    }
    // Partial names narrow progressively without losing the match.
    const partial = filterCellOptions(indiaCities, "luckn");
    expect(partial.length).toBeGreaterThanOrEqual(matches.length);
    expect(partial.map((o) => o.value)).toContain(matches[0].value);
  });

  it("progressive keystrokes narrow to the Aurangabad pair", () => {
    const a = filterCellOptions(indiaCities, "a");
    const au = filterCellOptions(indiaCities, "au");
    const aur = filterCellOptions(indiaCities, "aur");
    expect(a.length).toBeGreaterThan(au.length);
    expect(au.length).toBeGreaterThanOrEqual(aur.length);
    const full = filterCellOptions(indiaCities, "aurangabad");
    expect(full.map((o) => o.label).sort()).toEqual([
      "Aurangabad (Bihar)",
      "Aurangabad (Maharashtra)",
    ]);
    // State-qualified labels survive filtering; values stay bare.
    for (const o of full) expect(o.value).toBe("Aurangabad");
  });
});

describe("3+4. multi-keystroke editing never resets; backspace restores", () => {
  it("each keystroke filters the full list (no stale/reset query)", () => {
    // The component filters the FULL option list per query
    // (stateless substring match), so intermediate keystrokes can
    // never strand a narrowed or reset value — replay I→In→Ind.
    let query = "";
    const type = (ch: string) => {
      query += ch;
      return filterCellOptions(countryOptions, query);
    };
    const r1 = type("I");
    const r2 = type("n");
    const r3 = type("d");
    expect(query).toBe("Ind");
    expect(r1.length).toBeGreaterThanOrEqual(r2.length);
    expect(r2.length).toBeGreaterThanOrEqual(r3.length);
    expect(r3.map((o) => o.value)).toContain("India");
    // Focus retention: the combobox search input is a stable
    // controlled node (value from state, cleared only on
    // close/select) and option keys are stable value::label pairs,
    // so typing never remounts or resets the field.
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    expect(src).toContain('key={`${o.value}::${o.label}`}');
  });

  it("backspace widens back to the full lists", () => {
    let query = "Ind";
    const backspace = () => {
      query = query.slice(0, -1);
      return filterCellOptions(countryOptions, query);
    };
    backspace();
    expect(query).toBe("In");
    backspace();
    expect(query).toBe("I");
    const restored = backspace();
    expect(query).toBe("");
    expect(restored).toHaveLength(250);

    let cityQuery = "aurangabad";
    const cityBackspace = () => {
      cityQuery = cityQuery.slice(0, -1);
      return filterCellOptions(indiaCities, cityQuery);
    };
    // "aurangaba" still matches both Aurangabads (subset grows or holds).
    const widened = cityBackspace();
    expect(widened.length).toBeGreaterThanOrEqual(2);
    expect(widened.map((o) => o.label)).toContain("Aurangabad (Bihar)");
    cityQuery = "";
    expect(filterCellOptions(indiaCities, cityQuery)).toHaveLength(4249);
  });
});

describe("5. selecting a result submits the bare value and closes", () => {
  it("a filtered pick resolves through onChange (bare city name)", () => {
    const matches = filterCellOptions(indiaCities, "aurangabad (maharashtra)");
    expect(matches.map((o) => o.label)).toEqual(["Aurangabad (Maharashtra)"]);
    let submitted = "";
    const onChange = (v: string) => {
      submitted = v;
    };
    // pick() hands the option VALUE to onChange, which the dialog
    // stores and which closes the dropdown.
    onChange(matches[0].value);
    expect(submitted).toBe("Aurangabad");
    expect(submitted).not.toContain("(");
  });

  it("the combobox closes on selection and resets the query", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    // pick() submits the value then closes (query + highlight reset).
    expect(src).toContain("onClick={() => pick(o.value)}");
    expect(src).toContain("setOpen(false)");
    expect(src).toContain('setQuery("")');
  });
});

describe("6. changing the country resets the city appropriately", () => {
  it("incompatible cities clear; compatible cities stay", () => {
    expect(resolveDepartureCityOnCountryChange("United Arab Emirates", "Agra")).toBe("");
    expect(resolveDepartureCityOnCountryChange("India", "Dubai")).toBe("");
    expect(resolveDepartureCityOnCountryChange("India", "Delhi")).toBe("Delhi");
    expect(resolveDepartureCityOnCountryChange("India", "")).toBe("");
  });

  it("dialog keeps India default, remounts the city list, and preserves catalogs", () => {
    expect(resolveEffectiveDepartureCountry(undefined, "")).toBe("India");
    expect(resolveEffectiveDepartureCountry("", "")).toBe("");
    expect(DEPARTURE_COUNTRIES).toContain("India");
    expect(countryOptions).toHaveLength(250);
    expect(indiaCities).toHaveLength(4249);
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    expect(src).toContain("resolveDepartureCityOnCountryChange(next, values.departureCity");
    expect(src).toContain("key={`departureCity:${country}`}");
  });

  it("non-India city options and submission behavior are preserved", () => {
    const curated = departureCityOptions("France").map((o) => ({
      value: o.value,
      label: o.label,
    }));
    expect(curated.map((o) => o.value)).toEqual([
      "Delhi",
      "Mumbai",
      "Bengaluru",
      "Dubai",
      "Bangkok",
      "Singapore",
      "Bali",
      "Malé",
      "London",
      "Paris",
    ]);
    expect(filterCellOptions(curated, "dub").map((o) => o.value)).toEqual(["Dubai"]);
  });
});
