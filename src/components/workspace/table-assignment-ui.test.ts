// Per-table Assignment UI entry points — source pins.
//
// The Assignment action must be reachable from the single Workspace
// actions menu for BOTH Meta Lead Ads tables and Flow tables
// (owner-gated), rendering one shared single-panel dialog keyed
// by flow.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  decodeTemplateKey,
  encodeTemplateKey,
  formatDeliveryDetail,
  formatTemplateCategory,
  isTemplateSelectionValid,
  payloadAssignees,
  toTemplateOptions,
} from "./table-assignment-dialog";
import { filterSearchableOptions } from "./searchable-select";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("assignment entry points in the workspace actions menu", () => {
  const page = src("src/app/(dashboard)/workspace/page.tsx");
  const menu = src("src/components/workspace/workspace-actions-menu.tsx");

  it("shows Assignment with View and Edit in the Automation group (owner only, no sheet actions)", () => {
    // The page wires view/edit openers into the single menu; the
    // visible labels live in the menu component.
    expect(page).toContain("WorkspaceActionsMenu");
    expect(page).toContain("showAssignment={isOwner}");
    expect(page).toContain("onOpenAssignment={(mode) => {");
    expect(page).toContain("setAssignmentDialogOpen(true)");
    expect(page).toContain("setAssignmentViewMode(mode === 'view')");
    expect(page).toContain("viewMode={assignmentViewMode}");
    expect(page).not.toContain("label: 'Configure Sheet'");
    expect(page).not.toContain("label: 'Open Sheet'");
    expect(page).not.toContain("key: 'assignment'");
    // The single menu renders both actions under one heading with
    // no sheet entry points and no second overflow menu.
    expect(menu).toContain("Assignment");
    expect(menu).not.toContain("Auto-send WhatsApp");
    expect(menu).toContain("Automation");
    // View/Edit render through one shared row component, so the
    // accessible labels are template expressions over the label.
    expect(menu).toContain("aria-label={`View ${label}`}");
    expect(menu).toContain("aria-label={`Edit ${label}`}");
    expect(menu).toContain("Travel CRM Settings");
    expect(menu).not.toContain("Configure Sheet");
    expect(menu).not.toContain("Open Sheet");
    expect(menu).not.toContain("More actions");
  });

  it("shows Assignment for Flow tables too (owner only, no sheet actions)", () => {
    expect(page).toContain("TableAssignmentDialog");
    expect(page).not.toContain("Configure Sheet\" : null");
    // Owner-gated menu entry for both table kinds; the Automation
    // group renders whenever either entry is permitted.
    expect(page).toContain("showAssignment");
    expect(menu).toContain("Assignment");
    expect(page).toContain("isMetaTable");
  });

  it("mounts one shared dialog keyed by flow for both table kinds", () => {
    expect(page).toContain("key={`assign-${flowId}`}");
    expect(page).toContain("open={assignmentDialogOpen}");
    // Meta-only sheets/whatsapp dialogs keep their own gates.
    expect(page).toContain("{isMetaTable && flowId ? (");
  });
});

describe("assignment dialog is a single panel", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("covers status, method, assignees, pauses, and deliveries (no timezone section)", () => {
    for (const section of [
      "Automatic assignment",
      "Distribution method",
      "WhatsApp template",
      "Add assignee",
      "Recent alert deliveries",
    ]) {
      expect(dialog).toContain(section);
    }
    expect(dialog).not.toContain("Step 1");
    expect(dialog).not.toContain("Step 4");
    expect(dialog).not.toContain("multi-step");
    expect(dialog).not.toContain("drawer");
  });

  it("is India-only: no timezone selector, IST everywhere", () => {
    // No dropdown, search field, options list, or section remains.
    expect(dialog).not.toContain("Table timezone");
    expect(dialog).not.toContain("assign-tz");
    expect(dialog).not.toContain("Search timezones");
    expect(dialog).not.toContain("No matching timezone");
    expect(dialog).not.toContain("COMMON_TIMEZONES");
    expect(dialog).not.toContain("allTimezones");
    expect(dialog).not.toContain("Select a timezone");
    // The single IANA zone drives saves and display (via the
    // shared constant — no per-table zone strings remain).
    expect(dialog).toContain("ASSIGNMENT_TIMEZONE");
    expect(dialog).toContain("@/lib/lead-assignment/table-validation");
    expect(dialog).toContain("IST");
    // Roster linking keeps its own search; pauses stay scoped.
    expect(dialog).toContain("SearchableSelect");
    expect(dialog).toContain("/api/flows/${encodeURIComponent(flowId)}/assignment/pause");
  });

  it("all reads and writes are table-scoped and surfaced with feedback", () => {
    expect(dialog).toContain("/api/flows/${encodeURIComponent(flowId)}/assignment");
    expect(dialog).toContain("toast.success");
    expect(dialog).toContain("toast.error");
  });

  it("distinguishes linked members from external recipients", () => {
    expect(dialog).toContain("External contact");
    expect(dialog).toContain("External recipient");
    expect(dialog).toContain("notifications only — the lead stays Unassigned");
  });

  it("labels the email field as the notification recipient with a roster fallback", () => {
    // The entered address is authoritative; the roster email is
    // only a fallback — the old "roster email is used" wording is gone.
    expect(dialog).toContain("Email for notifications (optional)");
    expect(dialog).toContain('id="assign-email"');
    expect(dialog).toContain("If left empty, the linked team");
    expect(dialog).not.toContain("optional — roster email is used");
  });

  it("resets the email when a different member is linked", () => {
    // Switching salespeople must not retain the previous
    // person's address; re-selecting the same member keeps a
    // typed address.
    expect(dialog).toContain("const changed = f.user_id !== userId");
    expect(dialog).toContain('email: changed ? member?.email || ""');
  });

  it("blocks saving an enabled email alert with no possible recipient", () => {
    expect(dialog).toContain("but there is no email address — enter one or turn Email alerts off");
    expect(dialog).toContain("rosterById.get(d.user_id)?.email");
  });
});

describe("assignment dialog view mode (read-only inspection)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("accepts a viewMode flag and derives a read-only gate from it", () => {
    expect(dialog).toContain("viewMode = false");
    expect(dialog).toContain("const readOnly = viewMode === true");
    expect(dialog).toContain("Viewing — switch to Edit to make changes.");
  });

  it("disables every editable control in view mode", () => {
    // Master switch, radio cards, template selector, and share
    // inputs render disabled — values stay readable, nothing is
    // focusable or changeable. (Template language lives only in
    // state; it has no visible field at all.)
    const hits = dialog.split("disabled={readOnly}").length - 1;
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(dialog).toContain('aria-label="Automatic assignment"');
    expect(dialog).toContain('id="assign-mode-rr"');
    expect(dialog).toContain("Share percentage for");
    expect(dialog).toContain('ariaLabel="WhatsApp template (optional)"');
    expect(dialog).not.toContain("Template language");
  });

  it("hides every mutating action in view mode and keeps the saved readouts", () => {
    // Add/Edit/Deactivate/Remove/Pause controls and the editor
    // cards render only outside view mode...
    expect(dialog).toContain("{readOnly ? null : <TableHead className=\"text-right\">Actions</TableHead>}");
    expect(dialog).toContain("!readOnly && (editingKey || pauseFor)");
    // ...while names, contact channels, notify flags, badges, and
    // the paused-until line stay visible.
    expect(dialog).toContain("notify_email ? \"Email on\" : \"Email off\"");
    expect(dialog).toContain("until {formatPausedUntilFull(saved.paused_until)}");
    expect(dialog).toContain("saved.available ? \"Available\" : saved.status_label");
  });

  it("swaps the footer to Close-only and blocks the mutating submitters", () => {
    expect(dialog).toContain("if (readOnly || busy !== null) return;");
    expect(dialog).toContain("if (readOnly || !pauseFor) return;");
    expect(dialog).toContain("if (readOnly) return;");
    // Close-only footer in view mode; the Save pair stays for edit.
    expect(dialog).toContain("readOnly ? (");
    expect(dialog).toContain("onClick={() => onOpenChange(false)}");
    expect(dialog).toContain('saveLabel="Save Assignment Settings"');
  });
});

describe("assignment dialog assignee lookups (Add-crash regression)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("normalizes a config-null GET response (missing `assignees` key) to []", () => {
    // Unconfigured tables return { flow, config: null } with no
    // `assignees` key; before normalization this crashed the
    // assignee table the moment a local draft existed
    // (payload truthy, .assignees undefined → .find throws).
    expect(payloadAssignees({ flow: { id: "f", kind: "x", form_db_id: null }, config: null } as never)).toEqual([]);
    expect(payloadAssignees(null)).toEqual([]);
    expect(payloadAssignees(undefined)).toEqual([]);
  });

  it("passes real assignee rows through untouched", () => {
    const rows = [
      { id: "a-1", display_name: "Asha" },
      { id: "a-2", display_name: "Ext" },
    ];
    expect(payloadAssignees({ config: null, assignees: rows } as never)).toBe(rows);
  });

  it("routes every per-row lookup through the normalized map", () => {
    // Desktop table, mobile cards, and the pause card all read from
    // one lookup built on the normalized payload — no bare
    // `payload?.assignees.find` remains to throw on the
    // missing-key shape.
    expect(dialog).toContain("savedById");
    expect(dialog).toContain("payloadAssignees(payload)");
    expect(dialog).not.toContain("payload?.assignees.find");
    expect(dialog).not.toContain("payload.assignees.find");
  });

  it("guards the save against duplicate submissions and keeps drafts on failure", () => {
    // Re-entrancy guard (also view-mode blocked): the footer Save
    // is disabled while saving, and the handler itself bails when
    // a save is in flight.
    expect(dialog).toContain("if (readOnly || busy !== null) return;");
    expect(dialog).toContain("saving={busy === ");
    // Drafts are rebuilt from the server only after a successful
    // save; the catch path only surfaces the error, so the form
    // values survive for a retry.
    expect(dialog).toContain("await load();");
    expect(dialog).toContain("setSaveError(message)");
  });
});

describe("assignment template selector (searchable, approved-only)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("round-trips (name, language) selector keys", () => {
    const key = encodeTemplateKey({ name: "new_lead_assigned", language: "en_US" });
    expect(typeof key).toBe("string");
    expect(decodeTemplateKey(key)).toEqual({ name: "new_lead_assigned", language: "en_US" });
    expect(decodeTemplateKey("")).toBeNull();
    expect(decodeTemplateKey("no-separator-here")).toBeNull();
    expect(decodeTemplateKey(encodeTemplateKey({ name: "", language: "en_US" }))).toBeNull();
  });

  it("builds searchable options keyed by (name, language)", () => {
    const options = toTemplateOptions([
      { name: "new_lead_assigned", language: "en_US", status: "APPROVED", category: "Utility" },
      { name: "new_lead_assigned", language: "en", status: "APPROVED", category: "Utility" },
      // Same pair twice collapses to one row; blanks are dropped.
      { name: "new_lead_assigned", language: "en_US", status: "APPROVED", category: "Utility" },
      { name: "", language: "en_US", status: "APPROVED", category: "Utility" },
      { name: "x", language: "", status: "APPROVED", category: "Utility" },
    ]);
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ label: "new_lead_assigned" });
    expect(options[0].hint).toContain("en_US");
    expect(options[0].hint).toContain("APPROVED");
    expect(options[1].hint).toContain("en");
    // Distinct selector values per language variant.
    expect(options[0].value).not.toBe(options[1].value);
    expect(decodeTemplateKey(options[0].value)).toEqual({
      name: "new_lead_assigned",
      language: "en_US",
    });
  });

  it("shows each template's real category, language, and status", () => {
    const options = toTemplateOptions([
      { name: "lead_reminder", language: "en_US", status: "APPROVED", category: "Utility" },
      { name: "promo_blast", language: "en", status: "APPROVED", category: "Marketing" },
      { name: "otp_login", language: "en", status: "APPROVED", category: "Authentication" },
      { name: "lowercase_cat", language: "en_US", status: "APPROVED", category: "utility" },
      { name: "legacy_row", language: "en_US", status: "APPROVED", category: null },
    ]);
    expect(options.map((o) => o.hint)).toEqual([
      "UTILITY · en_US · APPROVED",
      "MARKETING · en · APPROVED",
      "AUTHENTICATION · en · APPROVED",
      "UTILITY · en_US · APPROVED",
      "Category unavailable · en_US · APPROVED",
    ]);
  });

  it("falls back instead of guessing a category", () => {
    expect(formatTemplateCategory("Utility")).toBe("UTILITY");
    expect(formatTemplateCategory("MARKETING")).toBe("MARKETING");
    expect(formatTemplateCategory("authentication")).toBe("AUTHENTICATION");
    expect(formatTemplateCategory("  utility  ")).toBe("UTILITY");
    expect(formatTemplateCategory(null)).toBe("Category unavailable");
    expect(formatTemplateCategory(undefined)).toBe("Category unavailable");
    expect(formatTemplateCategory("")).toBe("Category unavailable");
    expect(formatTemplateCategory("SomethingElse")).toBe("Category unavailable");
    expect(formatTemplateCategory(42)).toBe("Category unavailable");
  });

  it("keeps search working across name, language, and category", () => {
    const options = toTemplateOptions([
      { name: "lead_reminder", language: "en_US", status: "APPROVED", category: "Utility" },
      { name: "promo_blast", language: "en", status: "APPROVED", category: "Marketing" },
    ]);
    expect(filterSearchableOptions(options, "promo").map((o) => o.label)).toEqual(["promo_blast"]);
    expect(filterSearchableOptions(options, "en_us").map((o) => o.label)).toEqual(["lead_reminder"]);
    expect(filterSearchableOptions(options, "marketing").map((o) => o.label)).toEqual(["promo_blast"]);
    expect(filterSearchableOptions(options, "utility").map((o) => o.label)).toEqual(["lead_reminder"]);
    expect(filterSearchableOptions(options, "no-such-template")).toEqual([]);
  });

  it("validates the selection against the loaded approved list", () => {
    const approved = [{ name: "new_lead_assigned", language: "en_US", status: "APPROVED", category: "Utility" }];
    // Empty = no template = always fine (alerts stay off).
    expect(isTemplateSelectionValid(approved, "", "")).toBe(true);
    // Exact pair matches; renamed/removed/unapproved does not.
    expect(isTemplateSelectionValid(approved, "new_lead_assigned", "en_US")).toBe(true);
    expect(isTemplateSelectionValid(approved, "new_lead_assigned", "en")).toBe(false);
    expect(isTemplateSelectionValid(approved, "deleted_tpl", "en_US")).toBe(false);
    // Unknown list (not loaded / failed) never blocks saving.
    expect(isTemplateSelectionValid(null, "new_lead_assigned", "en_US")).toBe(true);
  });

  it("replaces the manual text input with the searchable selector", () => {
    // No free-typed template name or language fields remain.
    expect(dialog).not.toContain('id="assign-wa-template"');
    expect(dialog).not.toContain('placeholder="new_lead_assigned"');
    // Searchable dropdown with inline search, keyboard support from
    // the shared component, and a clear/reset action.
    expect(dialog).toContain("WhatsApp template (optional)");
    expect(dialog).toContain("SearchableSelect");
    expect(dialog).toContain('searchPlaceholder="Search templates…');
    expect(dialog).toContain('placeholder="Select a template…');
    expect(dialog).toContain("Clear template selection");
    expect(dialog).toContain("/assignment/templates");
  });

  it("locks language to the selected template with no language UI field", () => {
    // The Template language label, input, and helper text are gone;
    // the language lives only in state and the save payload.
    expect(dialog).not.toContain("Template language");
    expect(dialog).not.toContain('id="assign-wa-lang"');
    expect(dialog).not.toContain("Follows the selected template");
    expect(dialog).not.toContain("Select a template above");
    expect(dialog).toContain("setTemplateLanguage(parsed.language)");
    expect(dialog).toContain("data.config?.whatsapp_template_name");
    // Save contract unchanged: actual name + language strings.
    expect(dialog).toContain("whatsapp_template_name: templateName.trim() || null");
    expect(dialog).toContain('whatsapp_template_language: templateLanguage.trim() || "en_US"');
    // Saved settings still reopen with the stored language intact.
    expect(dialog).toContain("whatsapp_template_language ?? ");
  });

  it("covers loading, error/retry, empty, disconnected, and stale states", () => {
    expect(dialog).toContain("Loading templates…");
    expect(dialog).toContain("Retry");
    expect(dialog).toContain("No approved templates found.");
    expect(dialog).toContain("sender is not connected");
    expect(dialog).toContain("no longer");
    expect(dialog).toContain("approved or available");
    expect(dialog).toContain("choose a replacement before saving");
  });
});

describe("assignment dialog customer-facing sequence (WhatsApp messages to lead)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");
  const editor = src("src/components/workspace/assignee-sequence-editor.tsx");
  const configRoute = src(
    "src/app/api/integrations/meta-lead-ads/whatsapp/tables/[flowId]/config/route.ts",
  );

  it("adds a clearly labelled customer-facing section inside the assignee form", () => {
    expect(dialog).toContain("WhatsApp messages to lead");
    expect(dialog).toContain(
      "These templates are sent to a lead when this salesperson receives",
    );
    expect(dialog).toContain("Reassignment does not send");
    expect(dialog).toContain("customer-facing templates");
    expect(dialog).toContain("<AssigneeSequenceEditor");
  });

  it("keeps the salesperson notification template separate from the customer sequence", () => {
    // The notification template (WhatsApp alerts) stays its own
    // section; the customer sequence is a distinct labelled section.
    expect(dialog).toContain("WhatsApp notifications");
    expect(dialog).toContain("WhatsApp template (optional)");
    expect(dialog).toContain("WhatsApp messages to lead");
    // The customer sequence is never the notification template.
    expect(dialog).toContain("whatsapp_template_name");
    expect(dialog).toContain("assignee_key");
  });

  it("uses the existing stable salesperson key for internal and external assignees", () => {
    expect(dialog).toContain("salespersonKeyFor");
    expect(dialog).toContain("assignee-sequences");
    expect(dialog).toContain("draftKey(");
    expect(dialog).toContain("user_id");
    expect(dialog).toContain("email");
    expect(dialog).toContain("phone");
  });

  it("loads and saves each sequence through the existing per-salesperson config API", () => {
    expect(dialog).toContain("/api/integrations/meta-lead-ads/whatsapp/tables/");
    expect(dialog).toContain("/config");
    expect(dialog).toContain("assignee_key=");
    expect(dialog).toContain("assignee_key: key");
    expect(dialog).toContain("method: \"PUT\"");
  });

  it("saves each salesperson's sequence independently (never another's)", () => {
    // Saving iterates only the drafts the user changed, keyed by
    // each draft's own identity, so one assignee's save can never
    // overwrite another's sequence.
    expect(dialog).toContain("d.sequenceDirty && d.sequence");
    expect(dialog).toContain("draftKey(d)");
    expect(dialog).toContain("saveSequence(key, d.sequence");
  });

  it("handles empty/cleared sequences and the no-configure state", () => {
    expect(editor).toContain("No customer templates configured");
    expect(dialog).toContain("sequence: null");
    // Clearing a sequence persists the empty list (the config route
    // deletes the row).
    expect(dialog).toContain("templates: items.map");
  });

  it("gates customer sequences to Meta Lead Ads tables only", () => {
    expect(dialog).toContain('const isMetaTable = tableKind === "meta_lead_ads"');
    expect(dialog).toContain("{isMetaTable ? (");
  });

  it("shows the sequence order in the compact list and stays read-only in view mode", () => {
    // Compact per-assignee summary with ordered names; the full
    // editor is edit-only (hidden behind the readOnly gate).
    expect(dialog).toContain("<SequenceSummary");
    expect(dialog).toContain("Customer sequence");
    expect(dialog).toContain("No customer templates");
    expect(dialog).toContain("const readOnly = viewMode === true");
  });

  it("keeps the full delivery error available on hover in Recent alert deliveries", () => {
    // The Detail cell truncates visually but carries the complete
    // message as a tooltip so owners can diagnose failures. The
    // rendered-output test lives in assignment-delivery-detail.test.tsx.
    expect(dialog).toContain("Recent alert deliveries");
    expect(dialog).toContain("AssignmentDeliveryDetailCell");
    expect(dialog).toContain("const detail = formatDeliveryDetail(");
    expect(dialog).toContain('n.last_error ?? "retrying"');
  });

  it("formats ISO delivery timestamps as DD-MM-YYYY hh:mm AM/PM in IST", () => {
    // Production example: 2026-10-27T19:55:07.137Z is 01:25 IST the next day.
    expect(formatDeliveryDetail("2026-10-27T19:55:07.137+00:00")).toBe("28-10-2026 01:25 AM");
    expect(formatDeliveryDetail("2026-10-27T19:55:07.137Z")).toBe("28-10-2026 01:25 AM");
    // 12-hour clock edges: midnight renders as 12 AM, noon as 12 PM.
    expect(formatDeliveryDetail("2026-10-26T18:30:00.000Z")).toBe("27-10-2026 12:00 AM");
    expect(formatDeliveryDetail("2026-10-27T06:30:00.000Z")).toBe("27-10-2026 12:00 PM");
  });

  it("leaves non-date delivery details byte-for-byte untouched", () => {
    const err = 'Template "new_lead_notification" (en_US) cannot be sent: it needs the lead\'s phone number';
    expect(formatDeliveryDetail(err)).toBe(err);
    expect(formatDeliveryDetail("retrying")).toBe("retrying");
    expect(formatDeliveryDetail("")).toBe("");
    expect(formatDeliveryDetail(null)).toBe("");
    expect(formatDeliveryDetail(undefined)).toBe("");
    // Malformed timestamps never crash and never reformat.
    expect(formatDeliveryDetail("not-a-date")).toBe("not-a-date");
    expect(formatDeliveryDetail("2026-13-45T99:99")).toBe("2026-13-45T99:99");
    expect(formatDeliveryDetail("27-10-2026 01:25 AM")).toBe("27-10-2026 01:25 AM");
  });

  it("exposes category and status in the sequence editor options", () => {
    // The config route now returns category + status alongside the
    // existing name/language/slots, so the editor can present them.
    expect(configRoute).toContain("category: typeof t.category === 'string'");
    expect(configRoute).toContain("status: t.status");
    expect(editor).toContain("formatTemplateCategory");
  });

  it("labels variable mappings with the table's actual column headers", () => {
    // The config route builds the mapping catalog from this table's
    // real headers (Submission Time / Phone Number / question
    // headers incl. renames), not generic labels — while storing
    // the same stable field keys the drain resolves.
    expect(configRoute).toContain("buildTableVariableFields");
    expect(configRoute).toContain("meta_lead_header_labels");
    // The Assignment dialog feeds that catalog straight into the
    // editor's mapping dropdown.
    expect(dialog).toContain("fields={sequenceCatalog.fields}");
  });
});

