// Contract for 173: Meta-lead customer numbers block follow-up
// reminders. 173 adds ONE read-only helper (is_meta_lead_phone)
// and wires it into the two reminder-creation routes. No tables,
// records, templates, or assignment logic change. No live-DB harness
// exists here, so the SQL text is pinned.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  `${process.cwd()}/supabase/migrations/173_meta_lead_phone_guard.sql`,
  "utf8",
);

const reminderRoute = readFileSync(
  `${process.cwd()}/src/app/api/flows/[id]/followup-reminder/route.ts`,
  "utf8",
);

const followupsRoute = readFileSync(
  `${process.cwd()}/src/app/api/followups/route.ts`,
  "utf8",
);

const dialog = readFileSync(
  `${process.cwd()}/src/components/workspace/schedule-followup-dialog.tsx`,
  "utf8",
);

describe("173 centralized Meta-lead phone predicate", () => {
  it("defines is_meta_lead_phone over answers phone keys + Meta-provenance contacts", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.is_meta_lead_phone(");
    for (const key of ["phone_number", "phone", "mobile", "mobile_number", "whatsapp_number"]) {
      expect(sql).toContain(`s.answers ->> '${key}'`);
    }
    expect(sql).toContain("regexp_replace(v, '\\D', '', 'g')");
    expect(sql).toContain("'91' || regexp_replace");
    expect(sql).toContain("is_meta_lead_phone(TEXT)");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("GRANT EXECUTE");
    expect(sql).toContain("TO authenticated");
  });

  it("scopes to the caller's account and never writes", () => {
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("v_account_id");
    expect(sql).toMatch(/s\.account_id = v_account_id/);
    expect(sql).toMatch(/c\.account_id = v_account_id/);
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE (meta_lead_submissions|flow_runs|contacts|whatsapp_followups)\b/i);
    expect(sql).not.toMatch(/\bINSERT INTO\b/i);
  });

  it("covers hidden/disabled/history rows and Meta-only contacts", () => {
    // No form, status, or visibility filter on submissions.
    expect(sql).not.toMatch(/meta_form_id/);
    expect(sql).not.toMatch(/status IN/);
    // Contacts count only with Meta provenance.
    expect(sql).toContain("meta_lead_submissions s2");
    expect(sql).toContain("f.kind = 'meta_lead_ads'");
  });
});

describe("creation routes enforce the guard before any write", () => {
  it("workspace followup-reminder POST validates explicitly-set numbers and supports dry-run pre-check", () => {
    // Guard runs before update/insert branches.
    expect(reminderRoute).toContain("isMetaLeadPhoneNumber(supabase, outgoingRecipient)");
    expect(reminderRoute.indexOf("isMetaLeadPhoneNumber")).toBeLessThan(
      reminderRoute.indexOf(".update({"),
    );
    expect(reminderRoute.indexOf("isMetaLeadPhoneNumber")).toBeLessThan(
      reminderRoute.indexOf(".insert({"),
    );
    expect(reminderRoute).toContain("META_LEAD_PHONE_ERROR");
    expect(reminderRoute).toContain("META_LEAD_PHONE_CODE");
    // Read-only pre-validation: runs every check, writes nothing.
    expect(reminderRoute).toContain("validate_only");
    expect(reminderRoute).toContain("{ valid: true }");
  });

  it("generic followups POST validates the snapshot recipient before insert", () => {
    expect(followupsRoute).toContain("isMetaLeadPhoneNumber(supabase, recipient_phone)");
    expect(followupsRoute.indexOf("isMetaLeadPhoneNumber")).toBeLessThan(
      followupsRoute.indexOf('.insert({'),
    );
    expect(followupsRoute).toContain("META_LEAD_PHONE_ERROR");
  });
});

describe("schedule dialog surfaces the rejection inline without partial saves", () => {
  it("pre-validates before the cell write and rolls the cell back on rejection", () => {
    // Pre-check precedes the workspace-values PUT in handleSubmit.
    expect(dialog.indexOf("validate_only: true")).toBeLessThan(
      dialog.indexOf("/api/flows/${flowId}/workspace-values"),
    );
    expect(dialog).toContain("setRecipientError");
    expect(dialog).toContain("META_LEAD_PHONE_CODE");
    // Rollback restores the pre-save cell value.
    expect(dialog).toContain("value: initialValue");
  });

  it("highlights the Send reminder to input and keeps the entered number", () => {
    expect(dialog).toContain('aria-invalid={recipientError !== null}');
    expect(dialog).toContain('id="fu-recipient-error"');
    // Typing clears only the error — the entered number stays put
    // (rejection paths never reset the recipient input).
    expect(dialog).toContain("setRecipientError(null)");
    expect(dialog).toContain("setRecipient(e.target.value)");
  });
});
