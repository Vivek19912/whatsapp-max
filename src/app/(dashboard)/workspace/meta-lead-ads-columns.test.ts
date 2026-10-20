// Meta Lead Ads tables — display-only customizations stay Meta-only.
//
// Pins the scope contract with source assertions (the page is too
// heavy to render here, following the columns-menu test pattern):
//   * the rename menu + option-label mapping render only for
//     kind === 'meta_lead_ads' tables;
//   * Flow Tables keep the original header path and raw answers;
//   * hidden identity columns stay restorable via the full Columns menu.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const page = () =>
  readFileSync(`${root}/src/app/(dashboard)/workspace/page.tsx`, "utf8");
const tableRoute = () =>
  readFileSync(`${root}/src/app/api/flows/[id]/table/route.ts`, "utf8");
const formsRoute = () =>
  readFileSync(
    `${root}/src/app/api/integrations/meta-lead-ads/forms/route.ts`,
    "utf8",
  );

describe("workspace page — Meta-only header menu", () => {
  it("renders the rename menu only for Meta Lead Ads question columns", () => {
    const src = page();
    const menuIdx = src.indexOf("<MetaColumnHeaderMenu");
    expect(menuIdx).toBeGreaterThan(-1);
    // The single menu usage sits behind the Meta-kind gate and the
    // per-column eligibility check.
    const gate = "payload?.meta.kind === 'meta_lead_ads' &&";
    const gateIdx = src.indexOf(gate);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(menuIdx);
    expect(src.slice(gateIdx, menuIdx)).toContain(
      "isRenamableMetaColumn({ key: c.key, system: c.system })",
    );
  });

  it("keeps the original header path for every other column", () => {
    expect(page()).toContain("{formatColumnLabel(c.label)}");
  });

  it("passes per-table default hidden ids while Flow Tables pass nothing", () => {
    const src = page();
    expect(src).toContain("useWorkspaceVisibility(accountId, flowId, metaDefaultHiddenIds)");
    expect(src).toContain("payload?.meta?.kind === 'meta_lead_ads'");
  });

  it("rename saves a custom label and restore clears it, per column", () => {
    const src = page();
    expect(src).toContain("onRename={(label) =>");
    expect(src).toContain("handleSaveHeaderLabel(c.key, label)");
    expect(src).toContain("onRestore={() => handleSaveHeaderLabel(c.key, null)}");
    expect(src).toContain("/header-labels");
    expect(src).toContain("method: 'PUT'");
  });

  it("the Columns menu still receives the full payload columns (restorable)", () => {
    expect(page()).toContain("flowColumns={payload?.columns ?? []}");
  });
});

describe("table route — Meta-only option labels", () => {
  it("applies option labels only inside the Meta branch", () => {
    const src = tableRoute();
    const gate = src.indexOf("const isMetaLeadFlow");
    const apply = src.indexOf("applyOptionLabelsToAnswers(row.answers");
    expect(gate).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(gate);
    // The shared row builder is untouched; mapping applies after it.
    expect(src).toContain(
      "row.answers = applyOptionLabelsToAnswers(row.answers, metaOptionLabels)",
    );
  });

  it("never touches the stored row, keys, or system columns", () => {
    const src = tableRoute();
    expect(src).not.toContain("vars.answers = ");
    expect(src).not.toContain("update({ answers");
  });
});

describe("forms sync — option metadata is persisted", () => {
  it("stores option key/value pairs verbatim on every sync", () => {
    const src = formsRoute();
    expect(src).toContain("options: Array.isArray(q.options)");
    expect(src).toContain("key: typeof o?.key");
    expect(src).toContain("value: typeof o?.value");
  });
});
