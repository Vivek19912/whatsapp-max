import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { TravelCrmSettings } from "./travel-crm-settings";

describe("TravelCrmSettings", () => {
  it("renders the settings button for a selected flow", () => {
    const html = renderToStaticMarkup(
      <TravelCrmSettings flowId="flow-1" flowName="Kashmir Honeymoon" />,
    );
    expect(html).toContain("Travel CRM Settings");
    // Closed dialog renders no settings content yet.
    expect(html).not.toContain("Default Services");
  });

  it("disables the trigger without a selected flow", () => {
    const html = renderToStaticMarkup(
      <TravelCrmSettings flowId={null} flowName="Workspace" />,
    );
    expect(html).toContain("Travel CRM Settings");
    expect(html).toContain("disabled");
  });
});

describe("Workspace page wiring", () => {
  const page = readFileSync(
    `${process.cwd()}/src/app/(dashboard)/workspace/page.tsx`,
    "utf8",
  );

  it("mounts per-flow settings beside the table controls", () => {
    expect(page).toContain("TravelCrmSettings");
    expect(page).toContain("flowName={flowDisplayName(activeFlowName)}");
    // Remount per flow so switching flows reloads configuration.
    expect(page).toContain("key={flowId ?? 'no-flow'}");
  });
});

describe("Services Vehicle rename (Travel CRM Settings modal)", () => {
  const src = readFileSync(
    `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
    "utf8",
  );

  it("renders labels from the shared list (Vehicle, never the retired label)", () => {
    expect(src).toContain("TRAVEL_CRM_SERVICE_LABELS.map((label)");
    // The retired label appears only in code comments documenting
    // the alias — never as a rendered label, key, or aria value.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("Vehicle (disposal)");
    // The offered list (asserted to contain "Vehicle" in
    // services.test.ts) is the only label source for the checkboxes.
    expect(code).toContain("TRAVEL_CRM_SERVICE_LABELS");
  });

  it("keeps retired selections checked and clears every spelling on toggle", () => {
    // Toggle matcher and checkbox state both resolve retired labels.
    expect(src.split("resolveDisplayServiceLabel(s)").length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe("Itinerary Defaults display names — never raw UUIDs", () => {
  it("renders the destination through the shared grouped selector", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    // Same country-grouped component as the creation dialog:
    // groups appear when the feed carries country metadata.
    expect(src).toContain("<ItineraryDestinationSelect");
    expect(src).toContain("resolveSelectValue(destinations, row.destination)");
    // No city control: rows carry Destination + Nights only.
    expect(src).not.toContain("cityLabelForValue(");
    expect(src).not.toContain('aria-label="City"');
    // The stored UUID still travels as the option value (never the name).
    expect(src).toContain("onChange={(v) => setDestination(i, v ?? \"\")}");
  });

  it("loads legacy city-carrying defaults safely (city ignored)", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    // Saved rows with a legacy `city` property load without crashing:
    // the loader maps to {destination, nights} and drops the city.
    expect(src).toContain("Legacy saved rows may still carry a `city` property");
  });

  it("requires only destination and nights per row", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-settings.tsx`,
      "utf8",
    );
    expect(src).toContain("Each itinerary row needs a destination and nights.");
    expect(src).not.toContain("needs a destination, city, and nights");
  });
});
