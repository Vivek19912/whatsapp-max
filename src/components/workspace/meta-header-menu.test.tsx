import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { resolveMetaHeaderLabel } from "@/lib/meta-lead-ads/header-labels";
import { MetaColumnHeaderMenu } from "./meta-header-menu";

// Meta Lead Ads custom headers — Flow Tables must remain untouched.
//
// The menu + dialog live ONLY on Meta Lead Ads question headers:
// system columns, the Source column, and every Flow Table header
// render exactly as before. Structural guarantees are pinned by
// source assertions (Radix menus/dialogs portal-mount, so closed
// state renders only the trigger).

describe("MetaColumnHeaderMenu", () => {
  function render(customLabel: string | null) {
    return renderToStaticMarkup(
      <MetaColumnHeaderMenu
        columnKey="experience"
        originalLabel="How much experience do you have?"
        displayLabel={customLabel ?? "How much experience do you have?"}
        customLabel={customLabel}
        onRename={async () => {}}
        onRestore={async () => {}}
      />,
    );
  }

  it("renders the header trigger with an accessible label, dialog closed", () => {
    const html = render("Experience");
    expect(html).toContain("Experience");
    expect(html).toContain('aria-label="Column options for How much experience do you have?"');
    // Dialog closed: no rename form in the markup.
    expect(html).not.toContain("New Header Name");
    expect(html).not.toContain("Original Question");
  });

  it("renders the original text when no override is stored", () => {
    const html = render(null);
    expect(html).toContain("How much experience do you have?");
  });

  it("opens the rename dialog from the menu with the original question", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/meta-header-menu.tsx`,
      "utf8",
    );
    expect(src).toContain("setDialogOpen(true)");
    expect(src).toContain("Original Question");
    expect(src).toContain("New Header Name");
    expect(src).toContain("Cancel");
  });

  it("wires menu items with onClick (Base UI menus have no onSelect)", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/meta-header-menu.tsx`,
      "utf8",
    );
    // Regression guard for the dead-Rename-Header bug: this repo's
    // DropdownMenu is Base UI, whose items fire onClick — a Radix
    // onSelect handler would silently never run.
    expect(src).not.toContain("onSelect");
    expect(src).toContain("setDialogOpen(true)");
  });

  it("disables Restore Original Name without a stored override", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/meta-header-menu.tsx`,
      "utf8",
    );
    expect(src).toContain("disabled={!customLabel");
    expect(src).toContain("Restore Original Name");
    expect(src).toContain("Rename Header");
  });

  it("rejects empty names client-side before any save", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/meta-header-menu.tsx`,
      "utf8",
    );
    expect(src).toContain('draft.trim() === ""');
  });
});

describe("Flow Tables are unaffected", () => {
  it("non-Meta kinds always resolve to the original label", () => {
    for (const kind of ["whatsapp_flow", null, undefined, ""]) {
      expect(
        resolveMetaHeaderLabel({
          flowKind: kind,
          column: { key: "experience", system: false, label: "How much experience?" },
          labels: { "flow:experience": "Experience" },
        }),
      ).toBe("How much experience?");
    }
  });

  it("the workspace table renders the menu only on Meta question columns", () => {
    const page = readFileSync(
      `${process.cwd()}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    // Menu branch is gated on the Meta kind AND the renamable-column rule.
    expect(page).toContain("payload?.meta.kind === 'meta_lead_ads'");
    expect(page).toContain("isRenamableMetaColumn({ key: c.key, system: c.system })");
    expect(page).toContain("<MetaColumnHeaderMenu");
    // The default header path is byte-for-byte the old rendering.
    expect(page).toContain("{formatColumnLabel(c.label)}");
    // No other header cell type routes through the menu component.
    expect(page.split("<MetaColumnHeaderMenu").length - 1).toBe(1);
  });

  it("the Flow Tables API never reads or writes header labels", () => {
    const tableRoute = readFileSync(
      `${process.cwd()}/src/app/api/flows/[id]/table/route.ts`,
      "utf8",
    );
    expect(tableRoute).not.toContain("meta_lead_header_labels");
    expect(tableRoute).not.toContain("header-labels");
  });

  it("header labels live in their own table — flow_tables is untouched", () => {
    const lib = readFileSync(
      `${process.cwd()}/src/lib/flows/flow-tables.ts`,
      "utf8",
    );
    expect(lib).not.toContain("meta_lead_header_labels");
    expect(lib).not.toContain("header-label");
  });
});
