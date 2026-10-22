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

  it("passes the raw ingested answer to Meta cells only", () => {
    const src = page();
    const idx = src.indexOf("rawOriginal={");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 200)).toContain("meta_lead_ads");
    expect(src.slice(idx, idx + 200)).toContain("row.rawAnswers?.[c.key]");
  });
});

describe("workspace page — Meta lead-details sidebar labels", () => {
  it("resolves sidebar answer labels through the shared header override map", () => {
    const src = page();
    const sheetIdx = src.indexOf('<SheetContent side="right"');
    expect(sheetIdx).toBeGreaterThan(-1);
    const resolverIdx = src.indexOf("resolveMetaHeaderDisplayLabel({");
    // The single resolver usage lives inside the lead drawer, wired
    // to the same override map as the table header.
    expect(resolverIdx).toBeGreaterThan(sheetIdx);
    const call = src.slice(resolverIdx, resolverIdx + 1400);
    expect(call).toContain("flowKind: payload.meta.kind");
    expect(call).toContain("labels: headerLabels");
    expect(call).toContain("formatOriginal: formatColumnLabel");
  });

  it("keeps sidebar answer values on the override-aware display map", () => {
    // Values still come from resolveFlowAnswers (agent overrides
    // win); only the <dt> labels changed — mappings untouched.
    expect(page()).toContain("display[c.key] ?? '—'");
  });

  it("the drawer never renders a bare original label anymore", () => {
    const src = page();
    const sheetIdx = src.indexOf('<SheetContent side="right"');
    expect(sheetIdx).toBeGreaterThan(-1);
    const sheet = src.slice(sheetIdx);
    // The Answers <dt> goes through the override resolver; a Flow
    // Table drawer (flowKind !== 'meta_lead_ads') falls through to
    // the same formatting as before, so its labels are unchanged.
    expect(sheet).toContain("resolveMetaHeaderDisplayLabel({");
    expect(sheet).not.toContain("{formatColumnLabel(c.label)}");
  });
});

describe("workspace page — Meta Lead Source removal", () => {
  it("drops the Lead Received column from the Meta table and menu only", () => {
    const src = page();
    // Scoped list: Meta tables filter out Lead Received (shown as
    // "Lead Source"); every other table keeps the field untouched.
    expect(src).toContain("customFieldsScoped");
    expect(src).toContain(
      "customFields.filter((f) => !isLeadReceivedField({ name: f.name }))",
    );
    // Visibility, widths, and the Columns menu all read the scoped
    // list — the field can no longer render or be re-enabled there.
    expect(src).toContain("customFieldsScoped,");
    expect(src).toContain("customFields={customFieldsScoped}");
  });

  it("keeps stored data, filters, and Flow Tables on the full field list", () => {
    const src = page();
    // The Filters panel metadata and the cell-save path still use
    // the complete list: nothing deleted, nothing unwritable.
    expect(src).toContain("customFields.map((f) => [f.name.trim().toLowerCase(), f]");
    expect(src).toContain("customFields.find((f) => f.id === fieldId)");
  });
});

describe("workspace page — Meta follow-up reminder hook", () => {
  it("opens the reminder dialog only from Meta follow-up saves", () => {
    const src = page();
    // The save handler gates the entire hook on Meta tables and the
    // canonical datetime column — Flow Table saves pass through
    // untouched.
    expect(src).toContain(
      "if (isMetaTable && followupFieldId !== null && fieldId === followupFieldId) {",
    );
    expect(src).toContain("followupFieldId");
    expect(src).toContain("f.field_type === 'datetime'");
    expect(src).toContain("isWorkspaceFollowupFieldName(f.name)");
  });

  it("renders the Create Follow-up Reminder dialog from that hook", () => {
    const src = page();
    expect(src).toContain("FollowupReminderDialog");
    expect(src).toContain("setReminderDialog");
    // An already-open dialog keeps its draft (no reopen storms).
    expect(src).toContain("prev !== null");
  });

  it("cancels the linked reminder when the follow-up is cleared", () => {
    const src = page();
    expect(src).toContain("cancelWorkspaceFollowupReminder(runId)");
    expect(src).toContain("/followup-reminder");
    expect(src).toContain("method: 'DELETE'");
  });

  it("the dialog reports failures without losing the draft", () => {
    const src = readFileSync(
      `${root}/src/components/workspace/followup-reminder-dialog.tsx`,
      "utf8",
    );
    expect(src).toContain("Create Follow-up Reminder");
    expect(src).toContain("Reminder Message");
    expect(src).toContain("Save Follow-up");
    // Failed saves keep the dialog open with the draft intact for
    // retry; nothing is created before confirmation.
    expect(src).toContain('role="alert"');
    expect(src).toContain("setSaving(false)");
    expect(src).toContain("message: trimmed === \"\" ? null : message");
  });

  it("Flow Tables never reach the reminder state or endpoint", () => {
    const src = page();
    // Every reminder touchpoint sits behind the Meta gate above;
    // there is no second call site.
    const opens = src.split("setReminderDialog").length - 1;
    expect(opens).toBe(3);
    const endpoints = src.split("/followup-reminder").length - 1;
    expect(endpoints).toBe(2);
  });
});

describe("workspace page — Meta unified table (no Completed/Incomplete tabs)", () => {
  it("hides the completion tabs on Meta tables only", () => {
    const src = page();
    const gateIdx = src.indexOf("{isMetaTable ? null : (");
    expect(gateIdx).toBeGreaterThan(-1);
    const block = src.slice(gateIdx, gateIdx + 400);
    expect(block).toContain('aria-label="Completion filter"');
    expect(src).toContain("{VIEWS.map((v) => (");
    expect(src).toContain("onClick={() => selectView(v.id)}");
  });

  it("forces view=all for the Meta table request and empty state", () => {
    const src = page();
    expect(src).toContain(
      "payload?.meta?.kind === 'meta_lead_ads' ? 'all' : view",
    );
    expect(src).toContain("view: effectiveView,");
    expect(src).toContain("effectiveView === 'all'");
  });

  it("Flow Tables keep their tabs and selected view", () => {
    const src = page();
    // The tab buttons, selection handler, and per-view request key
    // are untouched — only Meta tables bypass them.
    expect(src).toContain("aria-selected={view === v.id}");
    expect(src).toContain("const selectView = useCallback(");
    expect(src).toContain("${flowId}|${effectiveView}|");
  });
});

describe("workspace page — Meta sidebar hides the metadata section", () => {
  it("gates the badge + Phone/Submission/Completed/Run-ID block to Flow Tables", () => {
    const src = page();
    const sheetIdx = src.indexOf('<SheetContent side="right"');
    expect(sheetIdx).toBeGreaterThan(-1);
    const sheet = src.slice(sheetIdx);
    // The whole metadata section renders only for non-Meta tables.
    expect(sheet).toContain("{isMetaTable ? null : (");
    expect(sheet).toContain("<StatusBadge status={selected.status} />");
    // Header (lead name + form name), Answers, recordings, and the
    // Travel CRM action stay outside the gate.
    const gateIdx = sheet.indexOf("{isMetaTable ? null : (");
    expect(sheet.indexOf("<SheetTitle>{selected.name ?? 'Run'}</SheetTitle>")).toBeLessThan(gateIdx);
    const gateEnd = sheet.indexOf("</dl>", gateIdx);
    expect(sheet.indexOf("Answers", gateEnd)).toBeGreaterThan(-1);
    expect(sheet.indexOf("LeadRecordings", gateEnd)).toBeGreaterThan(-1);
    expect(sheet.indexOf("TravelCrmAction", gateEnd)).toBeGreaterThan(-1);
  });
});

describe("workspace page — agent-scoped Meta tables", () => {
  it("loads assigned tables from the agent endpoint, not the full list", () => {
    const src = page();
    expect(src).toContain("const { accountId, accountRole, canEditSettings, canSendMessages } = useAuth();");
    expect(src).toContain("const isAgent = accountRole === 'agent';");
    expect(src).toContain("const flowsUrl = isAgent ? '/api/workspace/my-tables' : '/api/flows';");
    // Owner/admin/viewer behavior is untouched (same fetch + select).
    expect(src).toContain("fetch(flowsUrl,");
  });

  it("shows an agent-specific empty state with no assigned leads", () => {
    const src = page();
    expect(src).toContain("No leads assigned to you yet");
    expect(src).toContain("will appear here");
  });

  it("keeps the Assigned To cell read-only for agents on Meta tables", () => {
    const src = page();
    expect(src).toContain("isAgent && isMetaTable && isAssigneeField(f)");
    expect(src).toContain("canEdit={");
    // Admins keep the audited manual-assign path.
    expect(src).toContain("manualAssignMetaLead");
  });
});

describe("table route — Meta Source column position", () => {
  it("reorders Source after the last question column for Meta tables only", () => {
    const src = tableRoute();
    const gateIdx = src.indexOf("if (isMetaLeadFlow) {");
    expect(gateIdx).toBeGreaterThan(-1);
    const block = src.slice(gateIdx, gateIdx + 900);
    expect(block).toContain("META_SOURCE_COLUMN_KEY");
    expect(block).toContain("latest_recording");
    // Display order only: no stored-row, key, or Sheets writes.
    expect(block).not.toContain("vars.answers");
    expect(block).not.toContain("update({ answers");
  });
});

describe("table route — Meta-only option labels", () => {
  it("applies option labels only inside the Meta branch", () => {
    const src = tableRoute();
    const gate = src.indexOf("const isMetaLeadFlow");
    const apply = src.indexOf("applyOptionLabelsToAnswers(");
    expect(gate).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(gate);
    // The shared row builder is untouched; mapping applies after it,
    // with exact labels first and the type-based choice fallback.
    expect(src).toContain("row.answers = applyOptionLabelsToAnswers(");
    expect(src).toContain("metaChoiceKeys");
    expect(src).toContain("choiceQuestionKeys(stored, keys)");
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
