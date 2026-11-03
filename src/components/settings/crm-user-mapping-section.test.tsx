import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression test for the dropdown UUID bug: Base UI's
// Select.Value only resolves an item's label from mounted popup
// items, so after the popup closes it falls back to the raw value
// (the UUID). Every mapping Select must pass an explicit,
// state-resolved label as SelectValue children — never rely on item
// registration. Table cells must never render raw ids.
const src = readFileSync(
  `${process.cwd()}/src/components/settings/crm-user-mapping-section.tsx`,
  "utf8",
);

describe("crm user mapping dropdown labels", () => {
  it("passes explicit labels to every SelectValue", () => {
    const selfClosing = (src.match(/<SelectValue[^>]*\/>/g) ?? []).length;
    expect(selfClosing).toBe(0);
    expect(src).toContain("{selectedWacrmLabel}");
    expect(src).toContain("{selectedCrmLabel}");
    expect(src).toContain("{editCrmLabel}");
  });

  it("never renders raw user ids in table cells or labels", () => {
    expect(src).not.toContain("m.wacrm_user_id}");
    expect(src).not.toContain("m.crm_user_id}");
    expect(src).toContain("Unknown salesperson");
    expect(src).toContain("Unknown user");
  });

  it("routes all trigger text through the display resolvers", () => {
    expect(src).toContain("resolveCrmDisplayName");
    expect(src).toContain("resolveWacrmDisplayName");
  });
});
