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

describe("assignment dialog is a four-step wizard", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("covers method, members, notifications, customer messages, and deliveries", () => {
    for (const section of [
      "How should leads be assigned?",
      "Assigned team members",
      "Notify assigned team member",
      "Salesperson Notifications",
      "Messages to leads",
      "Advanced notification settings",
      "Add member",
      "Recent alert deliveries",
      "Review & save",
    ]) {
      expect(dialog).toContain(section);
    }
    expect(dialog).toContain('"sequences"');
    expect(dialog).toContain("WhatsApp Template to Lead");
    // Member editing is inline within the wizard steps — no side
    // panel, no nested dialog or modal.
    expect(dialog).not.toContain("<Sheet");
    expect(dialog).not.toContain("SheetContent");
    expect(dialog).not.toContain("@/components/ui/sheet");
    expect(dialog).not.toContain("Drawer");
    expect(dialog).not.toContain("<Dialog");
    expect(dialog).toContain("renderMemberEditor");
    expect(dialog).not.toContain("Nested tabs");
  });

  it("renders only the active step with Back/Continue navigation", () => {
    expect(dialog).toContain("AssignmentStepper");
    expect(dialog).toContain("ASSIGNMENT_STEPS");
    expect(dialog).toContain('step === "assign"');
    expect(dialog).toContain('step === "notify"');
    expect(dialog).toContain('step === "sequences"');
    expect(dialog).toContain('step === "review"');
    expect(dialog).toContain("Assignment progress");
    expect(dialog).toContain("Step ${index + 1}: ${s.label}");
    expect(dialog).toContain("Continue →");
    expect(dialog).toContain("← Back");
    expect(dialog).toContain('"Save Assignment"');
    // Navigation commits the open editor before validating.
    expect(dialog).toContain("const activeDrafts = commitOpenEditor();");
    expect(dialog).toContain("validateAssignStep");
    expect(dialog).toContain("validateNotifyStep");
    expect(dialog).toContain("validateSequencesStep");
    expect(dialog).toContain("AssignmentReviewSummary");
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

  it("distinguishes linked members from external contacts without leaking details", () => {
    expect(dialog).toContain("External contact (no login)");
    expect(dialog).toContain("External contact");
    expect(dialog).toContain("contacts receive notifications only — the lead stays Unassigned");
    // Contact details live in the inline member editor, not the main list.
    expect(dialog).toContain("Contact details");
  });

  it("labels the step-2 email field with a roster fallback note", () => {
    // The entered address is authoritative; the roster email is
    // only a fallback. Contact fields live on the Step 2
    // notification cards now, not in the Step 1 member form.
    expect(dialog).toContain("Email address");
    expect(dialog).toContain("Leave empty to use the roster address");
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
    expect(dialog).toContain("rosterById.get(userId)?.email");
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
    // Radio cards, share inputs, the notify switch, and the template
    // selector render disabled — values stay readable, nothing is
    // focusable or changeable. (Template language lives only in
    // state; it has no visible field at all. Activation lives in the
    // footer Pause/Resume row in edit mode; view mode keeps a
    // read-only header badge instead.)
    const hits = dialog.split("disabled={readOnly}").length - 1;
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(dialog).not.toContain('aria-label="Automatic assignment"');
    expect(dialog).not.toContain('title="Automatic assignment"');
    expect(dialog).not.toContain("onCheckedChange={setEnabled}");
    expect(dialog).toContain('id="assign-mode-rr"');
    expect(dialog).toContain("Share percentage");
    expect(dialog).toContain('ariaLabel="WhatsApp template (optional)"');
    expect(dialog).not.toContain("Template language");
  });

  it("hides every mutating action in view mode and keeps the saved readouts", () => {
    // Add/Edit/Remove/Configure controls render only outside view
    // mode (no inline editor ever opens read-only)...
    expect(dialog).toContain("{readOnly ? null : (");
    expect(dialog).toContain("if (readOnly) return;");
    expect(dialog).toContain("onClick={confirmEdit}");
    // ...while names, sequence statuses, and the paused-until line
    // stay visible.
    expect(dialog).toContain("Paused until {formatPausedUntilFull(");
    expect(dialog).toContain("sequenceStatusText(");
  });

  it("swaps the footer to Close-only and blocks the mutating submitters", () => {
    expect(dialog).toContain("if (readOnly || busy !== null) return;");
    expect(dialog).toContain("if (readOnly || !pauseFor) return;");
    expect(dialog).toContain("if (readOnly) return;");
    // Close-only footer in view mode; the Save pair stays for edit.
    expect(dialog).toContain("readOnly ? (");
    expect(dialog).toContain("onClick={() => onOpenChange(false)}");
    expect(dialog).toContain('"Save Assignment"');
    expect(dialog).not.toContain("ConfigFooterActions");
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
    expect(dialog).toContain('busy === "save"');
    expect(dialog).toContain("disabled={loading || busy !== null}");
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
    // Save contract: the template persists only while team
    // notifications are enabled.
    expect(dialog).toContain("notifyEnabled && templateName.trim()");
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

  it("adds a clearly labelled customer-facing section in the inline member editor", () => {
    expect(dialog).toContain("WhatsApp messages to lead");
    expect(dialog).toContain("on initial assignment only");
    expect(dialog).toContain("reassignment does not");
    expect(dialog).toContain("openGroup");
    expect(dialog).toContain("Show advanced options");
    expect(dialog).toContain("<AssigneeSequenceEditor");
  });

  it("keeps the salesperson notification template separate from the customer sequence", () => {
    // The team notification template stays its own section; the
    // customer sequence lives in the inline member editor. The
    // sequence is never the notification template.
    expect(dialog).toContain("Notify assigned team member");
    expect(dialog).toContain("WhatsApp template (optional)");
    expect(dialog).toContain("WhatsApp messages to lead");
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

  it("shows the sequence status in the messages section and stays read-only in view mode", () => {
    // One-line per-member status with a Configure entry point; the
    // full editor opens inline below the member row and is edit-only
    // (hidden behind the readOnly gate).
    expect(dialog).toContain("sequenceStatusText");
    expect(dialog).toContain("No sequence configured");
    expect(dialog).toContain("Sequence configured");
    expect(dialog).toContain("Configure");
    expect(dialog).toContain("openMessages(");
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

describe("assignment dialog open-editor commit on save (Assignee-2 phone regression)", () => {
  const dialogSrc = src("src/components/workspace/table-assignment-dialog.tsx");

  it("validates the open form with the same rules as Done", async () => {
    const { validateAssigneeForm } = await import("./table-assignment-dialog");
    const drafts = [{ key: "a-1", user_id: "u-1" }];
    expect(
      validateAssigneeForm({ key: "a-1", user_id: null, display_name: "amra", email: "", phone: "+917795020122" }, drafts),
    ).toBeNull();
    expect(
      validateAssigneeForm({ key: "a-1", user_id: null, display_name: "  ", email: "", phone: "+917795020122" }, drafts),
    ).toBe("Give the assignee a display name.");
    expect(
      validateAssigneeForm({ key: "a-1", user_id: null, display_name: "amra", email: "", phone: "  " }, drafts),
    ).toBe("Link a team member or enter an email address or phone number.");
    expect(
      validateAssigneeForm({ key: "a-2", user_id: "u-1", display_name: "B", email: "", phone: "" }, drafts),
    ).toBe("That team member is already on this table.");
  });

  it("detects pristine Add panels and merges edits synchronously", async () => {
    const { isPristineNewAssigneeForm, mergeOpenFormEdit } = await import("./table-assignment-dialog");
    const blank = { user_id: null, display_name: "", email: "", phone: "", whatsapp_numbers: [] };
    expect(isPristineNewAssigneeForm(blank)).toBe(true);
    expect(isPristineNewAssigneeForm({ ...blank, phone: "+917795020122" })).toBe(false);
    const drafts = [
      { key: "a-1", user_id: null, display_name: "One", email: "", phone: "", whatsapp_numbers: [] },
      { key: "a-2", user_id: null, display_name: "amra", email: "", phone: "", whatsapp_numbers: [] },
    ];
    // Editing Assignee 2's phone merges into the same index — the
    // value the server validates is the value shown in the editor.
    const merged = mergeOpenFormEdit(drafts, "edit", { ...drafts[1], phone: "+917795020122" }, "a-2");
    expect(merged).toHaveLength(2);
    expect(merged[1].phone).toBe("+917795020122");
    expect(merged[0]).toBe(drafts[0]);
    const added = mergeOpenFormEdit(drafts, "__new__", { key: "__new__", user_id: null, display_name: "N", email: "", phone: "+911234567890", whatsapp_numbers: [] }, "new-1");
    expect(added).toHaveLength(3);
    expect(added[2].key).toBe("new-1");
  });

  it("save commits the open editor before validating the payload", () => {
    // The save path must operate on the merged drafts (activeDrafts),
    // never on the stale pre-edit list.
    expect(dialogSrc).toContain("const activeDrafts = commitOpenEditor();");
    expect(dialogSrc).toContain("mergeOpenFormEdit(");
    expect(dialogSrc).toContain("assignees: activeDrafts.map((d) => ({");
    expect(dialogSrc).toContain("phone: d.phone.trim() || null,");
    // Validation itself is untouched: strict E.164 on both tiers.
    expect(dialogSrc).toContain("validateAssigneeForm(form, drafts)");
    expect(dialogSrc).not.toContain("normalizeAssigneePhone = ");
  });
});

describe("assignment dialog four-step sidebar navigation", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("renders a persistent left sidebar on desktop with a compact fallback", () => {
    expect(dialog).toContain('layout="vertical"');
    expect(dialog).toContain("md:block");
    expect(dialog).toContain("md:hidden");
    // Sidebar reuses the existing stepper interaction contract.
    expect(dialog).toContain("onStepClick={readOnly ? undefined : goToStep}");
  });

  it("never skips required steps", () => {
    expect(dialog).toContain('const order: AssignmentStep[] = ["assign", "notify", "sequences", "review"];');
    expect(dialog).toContain("if (!completedSteps.includes(target)) return;");
  });

  it("keeps the step 1 member form to link + share only", () => {
    // No display-name/email/phone inputs in the members-slot editor.
    expect(dialog).toContain("External contact — name and notification details are collected in Step 2.");
  });

  it("wires hover previews without changing selection", () => {
    expect(dialog).toContain("TemplatePreviewPopover");
    expect(dialog).toContain("TemplatePreviewCard");
    expect(dialog).toContain("renderOptionPreview");
    expect(dialog).toContain("templateDetails.get(");
  });
});

describe("assignment dialog member rows stay compact (details live in the inline editor)", () => {  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("lists members with avatar, name, share, edit, and remove only", () => {
    // One compact row per member: avatar initials, display name,
    // linked/external caption, read-only share text, Edit, Remove.
    expect(dialog).toContain("MemberInitials");
    expect(dialog).toContain("Add member");
    expect(dialog).toContain("ShareSelect");
    // The share is a Select in the Add/Edit form (validated 0–100
    // on commit, exactly 100% across active members in
    // percentage mode); the list row keeps read-only text.
    expect(dialog).toContain("assign-share");
    expect(dialog).not.toContain("patchDraft(d.key, { weight");
    // No activate/deactivate toggles in the list — availability
    // moved to the inline member editor.
    expect(dialog).not.toContain("Deactivate");
    // No contact columns in the list — emails, phones, and extra
    // numbers live in the inline member editor.
    expect(dialog).not.toContain("<TableHead>Name</TableHead>");
    expect(dialog).not.toContain("WhatsApp number{");
  });

  it("keeps allocation totals visible with inline validation", () => {
    expect(dialog).toContain("Total allocation:");
    expect(dialog).toContain("must total exactly 100%");
  });

  it("member editor holds the link, share, availability, and messages", () => {
    // The inline editor now holds only Step 1 basics (link, share)
    // plus availability and customer sequences. Contact details,
    // alert switches, and extra numbers moved to the Step 2
    // per-salesperson cards.
    expect(dialog).not.toContain('aria-label="Contact details"');
    expect(dialog).not.toContain('aria-label="Notification preferences"');
    expect(dialog).toContain("Availability");
    expect(dialog).not.toContain('aria-label="Member receives new leads"');
    expect(dialog).toContain("Show advanced options");
    expect(dialog).toContain("Email alerts");
    expect(dialog).toContain("WhatsApp alerts");
  });
});

describe("assignment dialog footer activation (no toggle, Pause/Resume row)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("has no Automatic toggle or section — activation lives in the footer", () => {
    expect(dialog).not.toContain('aria-label="Automatic assignment"');
    // No configuration section for activation; the footer pill and
    // Pause/Resume buttons are the only activation UI (plus a
    // read-only header badge in view mode).
    expect(dialog).not.toContain('title="Automatic assignment"');
    expect(dialog).not.toContain("onCheckedChange={setEnabled}");
    expect(dialog).toContain('aria-label="Assignment status"');
  });

  it("renders a separate right-aligned status row above Cancel/Save", () => {
    expect(dialog).toContain('aria-label="Assignment status"');
    expect(dialog).toContain('aria-label="Pause automatic assignment"');
    expect(dialog).toContain('aria-label="Resume automatic assignment"');
    // Pill + action on their own row, divider, then footer actions.
    expect(dialog).toContain("Active");
    expect(dialog).toContain("Paused");
    expect(dialog).toContain('role="separator"');
    expect(dialog).toContain('"Save Assignment"');
    // Right-edge alignment: both rows justify-end in one column.
    expect(dialog).toContain("justify-end");
  });

  it("offers footer navigation on every step without clipping", () => {
    // readOnly → Close; review → Cancel + Back + Save Assignment;
    // other steps → Cancel + Back (past step 1) + Continue. Every
    // branch offers a way out, and the shared shell keeps the footer
    // fixed (shrink-0, outside the scroll body) at every height and
    // zoom — buttons are never resized or clipped to fit.
    expect(dialog).toContain('"Save Assignment"');
    expect(dialog).toContain("Continue →");
    expect(dialog).toContain("← Back");
    const exits = dialog.split("onClick={() => onOpenChange(false)}").length - 1;
    expect(exits).toBeGreaterThanOrEqual(3);
  });

  it("auto-activates new valid configs and preserves existing state", async () => {
    const { resolveEnabledOnSave } = await import("./table-assignment-dialog");
    expect(
      resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: true, weightInvalid: false }),
    ).toBe(true);
    expect(
      resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: false, weightInvalid: false }),
    ).toBe(false);
    expect(
      resolveEnabledOnSave({ isNew: true, persistedEnabled: false, hasActiveAssignee: true, weightInvalid: true }),
    ).toBe(false);
    expect(
      resolveEnabledOnSave({ isNew: false, persistedEnabled: true, hasActiveAssignee: true, weightInvalid: false }),
    ).toBe(true);
    expect(
      resolveEnabledOnSave({ isNew: false, persistedEnabled: false, hasActiveAssignee: true, weightInvalid: false }),
    ).toBe(false);
  });

  it("pauses/resumes through a narrow status endpoint without touching drafts", () => {
    expect(dialog).toContain("/assignment/status");
    expect(dialog).toContain('JSON.stringify({ action })');
    expect(dialog).toContain("submitStatus");
    // Status updates only after the backend confirms (then reload).
    expect(dialog).toContain("await load();");
  });

  it("closes the dialog only after a fully successful save — never on failure or Pause/Resume", () => {
    // The save block: success toast, refresh, then close. Slicing
    // from the success toast to the next function isolates the save
    // tail from the Cancel buttons and pause/resume paths elsewhere
    // in the file.
    const start = dialog.indexOf('toast.success("Assignment settings saved for this table.")');
    const end = dialog.indexOf("const submitPause", start);
    const tail = dialog.slice(start, end);
    expect(tail.length).toBeGreaterThan(0);
    // Refresh-before-close so the workspace shows current state.
    expect(tail.indexOf("await load();")).toBeGreaterThan(-1);
    expect(tail.indexOf("onOpenChange(false);")).toBeGreaterThan(tail.indexOf("await load();"));
    // Exactly one close in the save path, gated on every touched
    // sequence persisting: a sequence failure keeps the dialog open
    // for retry; create and edit share this path (no isNew branch).
    expect(tail.split("onOpenChange(false);")).toHaveLength(2);
    expect(tail).toContain("sequencesOk");
    // Duplicate-submit guard: Save stays disabled while saving.
    expect(dialog).toContain("disabled={loading || busy !== null}");
    // Pause/Resume never close the dialog.
    const pauseBody = dialog.slice(dialog.indexOf("const submitPause"), dialog.indexOf("const submitStatus"));
    const statusBody = dialog.slice(dialog.indexOf("const submitStatus"), dialog.indexOf("const loadNotifications"));
    expect(pauseBody).not.toContain("onOpenChange(false)");
    expect(statusBody).not.toContain("onOpenChange(false)");
  });
});

describe("simplified assignment UX (four steps + inline member editor)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("shows exact empty-roster states and stays navigable", () => {
    // Step 1 allows zero members (no error); Steps 2–4 show the
    // specified empty states instead of member editors.
    expect(dialog).toContain("No team members assigned. Salesperson notifications are not configured.");
    expect(dialog).toContain("No team members assigned. There are no customer message sequences to configure.");
    expect(dialog).toContain("No team members assigned");
    expect(dialog).toContain("automatic team assignment is");
    expect(dialog).toContain("new leads will stay Unassigned until members");
    expect(dialog).not.toContain("Add at least one team member to continue.");
  });

  it("defaults new configurations to Round Robin and preserves the saved method", () => {
    expect(dialog).toContain('useState<"round_robin" | "percentage">("round_robin")');
    expect(dialog).toContain('setMode(data.config?.mode ?? "round_robin")');
  });

  it("switches between Round Robin and Percentage-based without touching members", () => {
    expect(dialog).toContain('if (v === "round_robin" || v === "percentage") setMode(v)');
    // Switching never rewrites drafts — only the mode flag changes.
    expect(dialog).not.toContain("setDrafts([])");
  });

  it("adds and removes members with sensible defaults", () => {
    expect(dialog).toContain("onClick={startAdd}");
    expect(dialog).toContain("onClick={() => requestRemove(d)}");
    expect(dialog).toContain("Confirm?");
    expect(dialog).toContain("is_active: true,");
    // New members default to Email notifications OFF; the user opts
    // in per salesperson in Step 2.
    expect(dialog).toContain("notify_email: false,");
  });

  it("validates percentage allocation with a visible total", () => {
    expect(dialog).toContain("Total allocation:");
    expect(dialog).toContain("must total exactly 100%");
    expect(dialog).toContain("ShareSelect");
    const fields = src("src/components/workspace/assignment-field-controls.tsx");
    expect(fields).toContain('"10", "20", "30", "40", "50", "60", "70", "80", "90", "100"');
    expect(fields).toContain("legacy value");
    // One combined typed-input + quick-select control writes the
    // same draft value; the wizard validates the commit (0–100) and
    // the step gate still requires exactly 100% across members.
    expect(dialog).toContain('id="assign-share"');
    expect(dialog).toContain("between 0 and 100");
    expect(dialog).toContain("validateShareValue");
    expect(fields).toContain('inputMode="numeric"');
    expect(fields).toContain("Choose a preset share percentage for");
  });

  it("anchors the quick picks below the input with safe dismissal", () => {
    // The popover opens under the control aligned to its left edge,
    // stays in the viewport (flip/shift + padding, portal above the
    // modal), and closes on selection; Escape/outside-click dismiss
    // through the controlled onOpenChange wiring.
    const fields = src("src/components/workspace/assignment-field-controls.tsx");
    expect(fields).toContain('align="start"');
    expect(fields).toContain('side="bottom"');
    expect(fields).toContain("collisionPadding={8}");
    expect(fields).toContain("onOpenChange={setOpen}");
    expect(fields).toContain("setOpen(false)");
    expect(fields).toContain('role="listbox"');
    expect(fields).toContain('aria-selected={o === trimmed}');
  });

  it("commits an open member editor before validating the payload", () => {
    // The stale-editor regression stays fixed under the new layout:
    // save merges the open inline editor, then validates + submits.
    expect(dialog).toContain("const activeDrafts = commitOpenEditor();");
    expect(dialog).toContain("mergeOpenFormEdit(");
    expect(dialog).toContain("assignees: activeDrafts.map((d) => ({");
  });

  it("shows the team template when any WhatsApp notification is on", () => {
    // No master notification switch: per-salesperson WhatsApp
    // toggles are the source of truth; the shared template picker
    // appears when at least one member has WhatsApp alerts on.
    expect(dialog).not.toContain("onCheckedChange={setNotifyEnabled}");
    expect(dialog).toContain("Choose a notification template or turn notifications off.");
    expect(dialog).toContain("notifyEnabled && templateName.trim()");
    expect(dialog).toContain('"Preview notification template"');
  });

  it("reports customer-sequence status per member and configures inline", () => {
    expect(dialog).toContain("sequenceStatusText");
    expect(dialog).toContain("No sequence configured");
    expect(dialog).toContain("openMessages(");
    expect(dialog).toContain('openGroup === "msg"');
    expect(dialog).toContain("Configure");
  });

  it("computes the customer-message status line", async () => {
    const { sequenceStatusText } = await import("./table-assignment-dialog");
    expect(sequenceStatusText({ sequence: null })).toBe("No sequence configured");
    expect(sequenceStatusText({ sequence: { items: [] } })).toBe("No sequence configured");
    expect(sequenceStatusText({ sequence: { items: [{}, {}] } })).toBe(
      "Sequence configured · 2 templates",
    );
    expect(sequenceStatusText({ sequence: { items: [{}] } })).toBe(
      "Sequence configured · 1 template",
    );
  });

  it("preserves per-assignee templates, delays, and notification channels", () => {
    expect(dialog).toContain("WhatsappNumbersEditor");
    expect(dialog).toContain("delay_seconds");
    expect(dialog).toContain("onDelayChange");
    expect(dialog).toContain('ariaLabel="Link team member"');
    expect(dialog).toContain("Email alerts");
    expect(dialog).toContain("WhatsApp alerts");
  });

  it("keeps external notification-only recipients supported", () => {
    expect(dialog).toContain("External contact (no login)");
    expect(dialog).toContain(
      "Link a team member or enter an email address or phone number.",
    );
  });

  it("exposes pause controls per saved member without rewriting owners", () => {
    expect(dialog).toContain("Pause temporarily");
    expect(dialog).toContain("Resume / extend pause");
    expect(dialog).toContain("submitPause");
    expect(dialog).toContain("Saving never rewrites existing lead owners.");
  });

  it("keeps assignment scoped to the table and persisted through the same API", () => {
    expect(dialog).toContain("/api/flows/${encodeURIComponent(flowId)}/assignment");
    expect(dialog).toContain('method: "PUT"');
    expect(dialog).toContain("phone: d.phone.trim() || null,");
    expect(dialog).toContain("resolveEnabledOnSave");
  });

  it("uses one identical dialog for Create and Edit Assignment", () => {
    // No separate create/edit components, layouts, or step orders —
    // the same ConfigDialog + sidebar + four steps serve both. Edit
    // only differs by hydrating saved state (toDraft) and the
    // readOnly view-mode gate.
    expect(dialog).toContain("export function TableAssignmentDialog");
    expect(dialog).not.toMatch(/CreateAssignmentDialog|EditAssignmentDialog/);
    expect(dialog).toContain('width="assignment"');
    expect(dialog).toContain('aria-label="Assignment steps"');
    expect(dialog).toContain("assignees.map(toDraft)");
    expect(dialog).toContain("viewMode = false");
  });

  it("enforces India-only phone input without a master notification switch", () => {
    // No table-level notification toggle remains; per-salesperson
    // WhatsApp switches drive the template section.
    expect(dialog).not.toContain("onCheckedChange={setNotifyEnabled}");
    expect(dialog).toContain("IndiaPhoneInput");
    expect(dialog).toContain("+91");
    // Legacy free-text phone inputs are gone from the member editor.
    expect(dialog).not.toContain("Phone (with country code)");
    expect(dialog).toContain("normalizeWhatsappNumberInput");
  });
});

describe("assignment inline editing contract (one dialog, no panels)", () => {
  const dialog = src("src/components/workspace/table-assignment-dialog.tsx");

  it("renders exactly one dialog and never a nested dialog or sheet", () => {
    expect(dialog).toContain("<ConfigDialog");
    expect(dialog).not.toContain("<Dialog");
    expect(dialog).not.toContain("<Sheet");
    expect(dialog).not.toContain("SheetContent");
    expect(dialog).not.toContain("@/components/ui/sheet");
    expect(dialog).not.toContain("Drawer");
  });

  it("adds members through an inline form below the member list", () => {
    expect(dialog).toContain("renderMemberEditor(true, true)");
    expect(dialog).toContain("Add member");
    expect(dialog).toContain("Show advanced options");
  });

  it("edits a member inline directly below that member's row", () => {
    // STEP 1 edits use the compact editor; STEP 2 message/advanced
    // rows open the full editor. A single editingKey + editorSlot
    // keeps at most one editor visible across all steps.
    expect(dialog).toContain("editorSlot");
    expect(dialog).toContain("renderMemberEditor(false, true)");
    expect(dialog).toContain("renderMemberEditor(false)");
    expect(dialog).toContain("Save member");
  });

  it("keeps at most one editor open and never silently drops edits", () => {
    // Opening another editor first commits the current one; a failed
    // validation keeps the editor open with the error shown.
    expect(dialog).toContain("if (!commitOpenEditor()) return;");
    expect(dialog).toContain("const activeDrafts = commitOpenEditor();");
    expect(dialog).toContain("isPristineNewAssigneeForm");
  });

  it("collapses advanced groups by default and exposes them on demand", () => {
    expect(dialog).toContain("useState(false)");
    expect(dialog).toContain('useState<null | "contact" | "notify" | "avail" | "msg">(null)');
    expect(dialog).not.toContain('aria-label="Contact details"');
    expect(dialog).not.toContain('aria-label="Notification preferences"');
    expect(dialog).toContain('aria-label="Availability"');
    expect(dialog).toContain('aria-label="Customer messages"');
    expect(dialog).toContain("aria-expanded={openGroup");
    expect(dialog).toContain('aria-label="Salesperson notifications"');
  });

  it("confirms removal inline without a modal", () => {
    expect(dialog).toContain("requestRemove");
    expect(dialog).toContain("Confirm?");
    expect(dialog).toContain("Confirm remove");
  });

  it("opens a compact sequence-only panel from the Messages to leads section", () => {
    // Step 3 configures customer templates only: the row opens a
    // dedicated sequence panel, never the full member editor (no
    // link, name, share, availability, or notification fields).
    expect(dialog).toContain("openMessages");
    expect(dialog).toContain("renderSequencePanel");
    expect(dialog).toContain("commitSequenceEditor");
    expect(dialog).not.toContain('editorSlot === "messages" ? renderMemberEditor');
    // The panel commits sequence fields only — no member
    // validation, no share check, no contact requirements.
    expect(dialog).toContain("sequence: form.sequence,");
    expect(dialog).toContain("sequenceDirty: form.sequenceDirty,");
  });

  it("keeps email notifications off by default and hides the email field until enabled", () => {
    // New salespeople AND new external contacts start with
    // notify_email false (same emptyDraft); a roster email never
    // auto-enables the channel; the email input only renders after
    // the user explicitly opts in.
    expect(dialog).toContain("notify_email: false,");
    expect(dialog).toContain("notify_whatsapp: false,");
    expect(dialog).toContain("notify_email: a.notify_email === true,");
    expect(dialog).toContain("notify_whatsapp: a.notify_whatsapp === true,");
    expect(dialog).toContain("{d.notify_email ? (");
    expect(dialog).toContain("Both channels are off — no contact details needed.");
    // Saved ON preferences are preserved on load (strict opt-in
    // read, not a forced reset).
    expect(dialog).toContain("checked={d.notify_email}");
  });
});

