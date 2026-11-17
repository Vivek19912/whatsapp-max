// Workspace table hide/restore — scope contract pins.
//
// Follows the source-assertion pattern of the neighboring
// workspace test files (the page is too heavy to render here):
//   * eye icons + Manage Options render owner-only;
//   * the popup edits a draft and saves one hidden-ids array;
//   * the API restricts writes to the owner and validates ids
//     against the caller's own account;
//   * the migration isolates tenants and cascades on delete.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const header = () =>
  readFileSync(
    `${root}/src/components/workspace/workspace-header.tsx`,
    "utf8",
  );
const page = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const route = () =>
  readFileSync(
    `${root}/src/app/api/workspace/hidden-tables/route.ts`,
    "utf8",
  );
const migration = () =>
  readFileSync(
    `${root}/supabase/migrations/168_workspace_hidden_tables.sql`,
    "utf8",
  );

describe("workspace table selector — Manage Options (owner only)", () => {
  it("shows no eye icons in the dropdown; Manage Options stays owner-only", () => {
    const src = header();
    expect(src).toContain("Manage Options");
    expect(src).toContain("canManage");
    // The dropdown items render the plain table name only — no
    // eye indicators beside individual options.
    const selectStart = src.indexOf("<Select");
    const dialogStart = src.indexOf("<Dialog open={manageOpen}");
    expect(selectStart).toBeGreaterThan(-1);
    expect(dialogStart).toBeGreaterThan(selectStart);
    const dropdown = src.slice(selectStart, dialogStart);
    expect(dropdown).not.toContain("<Eye");
    expect(dropdown).not.toContain("<EyeOff");
    // The Manage Options popup keeps its eye / crossed-eye row
    // icons alongside the ON/OFF switches.
    const popup = src.slice(dialogStart);
    expect(popup).toContain("<Eye");
    expect(popup).toContain("<EyeOff");
    // Non-owners get the exact previous selector: no footer, no
    // dialog.
    expect(src).toContain("manageable = canManage === true");
  });

  it("edits visibility as a draft and saves one hidden-ids array", () => {
    const src = header();
    expect(src).toContain("draftVisible");
    expect(src).toContain("onSaveHidden(nextHidden)");
    expect(src).toContain("Switch");
    expect(src).toContain("Save");
    // Closing without saving discards the draft (state resets on
    // next open).
    expect(src).toContain("setManageOpen(false)");
  });

  it("the page filters the dropdown and never strands the selection", () => {
    const src = page();
    expect(src).toContain("visibleWorkspaceTables");
    expect(src).toContain("hiddenTableIds");
    expect(src).toContain("flows={visibleFlows ?? []}");
    expect(src).toContain("allFlows={flows}");
    expect(src).toContain("onSaveHidden={isOwner ? handleSaveHiddenTables");
  });
});

describe("hidden-tables API — owner-only writes, tenant-scoped reads", () => {
  it("reads for any member, writes for the owner only", () => {
    const src = route();
    expect(src).toContain("getCurrentAccount()");
    expect(src).toContain('requireRole("owner")');
  });

  it("rejects foreign flow ids instead of hiding them", () => {
    const src = route();
    expect(src).toContain(".eq(\"account_id\", accountId)");
    expect(src).toContain("Flow not found.");
  });

  it("keeps the collapsed trigger single-line without the source prefix", () => {
    const src = header();
    // The collapsed trigger strips the redundant `Meta Lead Ads · `
    // prefix and stays single-line (truncate); the dropdown menu
    // and Manage Options popup below it keep complete names.
    expect(src).toContain("stripMetaLeadAdsPrefix");
    expect(src).toContain("/^Meta Lead Ads\\s*·\\s*/");
    const triggerStart = src.indexOf("<SelectTrigger");
    const menuStart = src.indexOf("<SelectContent");
    expect(triggerStart).toBeGreaterThan(-1);
    expect(menuStart).toBeGreaterThan(triggerStart);
    const trigger = src.slice(triggerStart, menuStart);
    expect(trigger).toContain("truncate");
    expect(trigger).not.toContain("whitespace-normal");
    expect(trigger).not.toContain("break-words");
  });

  it("never truncates a table name inside the dropdown or popup", () => {
    const src = header();
    // Dropdown items and popup rows wrap instead of truncating.
    // (Scoped to the menu + dialog: the unrelated toolbar
    // overflow menu below legitimately keeps its own truncate.)
    const menuStart = src.indexOf("<SelectContent");
    const dialogEnd = src.indexOf("</Dialog>", menuStart);
    expect(menuStart).toBeGreaterThan(-1);
    expect(dialogEnd).toBeGreaterThan(menuStart);
    expect(src.slice(menuStart, dialogEnd)).not.toContain("truncate");
  });
});

describe("hidden-tables migration — visibility never touches leads", () => {
  it("keys hides by stable flow_id with tenant isolation", () => {
    const src = migration();
    expect(src).toContain("UNIQUE (account_id, flow_id)");
    expect(src).toContain("ON DELETE CASCADE");
    expect(src).toContain("is_account_member(account_id, 'owner')");
  });
});
