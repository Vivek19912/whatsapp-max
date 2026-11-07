import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Sequential sales follow-ups: UI wiring + migration contracts.
// Dialogs render through portals (no static DOM to assert), so these
// pin the source structure: record/history dialogs, schedule dialog
// attempt props, page routing, row-menu entry, and the SQL guard
// rails (unique open attempt, RLS, history-preserving import).
// ---------------------------------------------------------------------------

const root = process.cwd();
const src = (rel: string) => readFileSync(`${root}/${rel}`, "utf8");
const pageSrc = src("src/app/(dashboard)/workspace/page.tsx");
const scheduleSrc = src("src/components/workspace/schedule-followup-dialog.tsx");
const recordSrc = src("src/components/workspace/record-followup-result-dialog.tsx");
const historySrc = src("src/components/workspace/followup-history-dialog.tsx");
const menuSrc = src("src/components/workspace/row-actions-menu.tsx");
const migrationSrc = src("supabase/migrations/161_sales_followup_attempts.sql");

describe("record-result dialog", () => {
  it("collects an optional outcome + mandatory notes with validation", () => {
    expect(recordSrc).toContain("FOLLOWUP_OUTCOMES");
    expect(recordSrc).toContain("Follow-up Outcome (optional)");
    expect(recordSrc).toContain("Select outcome (optional)");
    expect(recordSrc).toContain("Follow-up Result / Notes");
    expect(recordSrc).toContain("FOLLOWUP_RESULT_MAX");
    expect(recordSrc).not.toContain("Choose the follow-up outcome.");
    expect(recordSrc).toContain("Describe the follow-up result.");
  });

  it("posts to the attempt result endpoint and refreshes", () => {
    expect(recordSrc).toContain("/sales-followups/${attemptId}/result");
    expect(recordSrc).toContain("outcome: outcome === \"\" ? null : outcome");
    expect(recordSrc).toContain("result_text: trimmed");
    expect(recordSrc).toContain("Save Result");
  });

  it("shows the lead, attempt number, and original schedule", () => {
    expect(recordSrc).toContain("Record Follow-up Result");
    expect(recordSrc).toContain("Follow-up {attemptNumber}");
    expect(recordSrc).toContain("formatInstant(scheduledAt)");
  });
});

describe("history dialog", () => {
  it("loads the timeline and renders every attempt in order", () => {
    expect(historySrc).toContain("/sales-followups?flow_run_id=");
    expect(historySrc).toContain("history.attempts.map((attempt)");
    expect(historySrc).toContain("Follow-up {attempt.attempt_number}");
    expect(historySrc).toContain("badgeForAttempt(attempt)");
  });

  it("exposes contextual actions without bypassing the sequence", () => {
    expect(historySrc).toContain("Record Result — Follow-up {active.attempt_number}");
    expect(historySrc).toContain("Schedule Follow-up {history.state.nextAttemptNumber}");
    expect(historySrc).toContain("Schedule Follow-up 1");
    expect(historySrc).toContain("Close sequence");
    expect(historySrc).toContain("Reopen sequence");
  });

  it("never invents its own numbering (server owns it)", () => {
    expect(historySrc).not.toContain("attempt_number + 1");
    expect(historySrc).toContain("onScheduleNext");
    expect(historySrc).toContain("onRecordResult(active)");
  });

  it("offers Edit Schedule only for future unresolved attempts", () => {
    expect(historySrc).toContain("onEditSchedule");
    expect(historySrc).toContain("Edit Schedule");
    expect(historySrc).toContain("attempt.completed_at === null");
    expect(historySrc).toContain("new Date(attempt.scheduled_at).getTime() > Date.now()");
  });
});

describe("schedule dialog sequencing", () => {
  it("numbers the attempt and supports in-place rescheduling", () => {
    expect(scheduleSrc).toContain("attemptNumber: number");
    expect(scheduleSrc).toContain("rescheduleAttemptId");
    expect(scheduleSrc).toContain("Schedule Follow-up ${attemptNumber}");
    expect(scheduleSrc).toContain("Reschedule Follow-up ${attemptNumber}");
    expect(scheduleSrc).toContain("/sales-followups/${rescheduleAttemptId}");
  });

  it("creates the attempt before writing cells/reminders (server first)", () => {
    const attemptIdx = scheduleSrc.indexOf("/sales-followups`");
    const cellIdx = scheduleSrc.indexOf("/workspace-values");
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(cellIdx).toBeGreaterThan(attemptIdx);
  });

  it("surfaces 409 sequencing errors without losing input", () => {
    expect(scheduleSrc).toContain("attemptJson?.error");
    expect(scheduleSrc).toContain("Could not schedule the follow-up.");
  });

  it("keeps the WhatsApp reminder integration intact", () => {
    expect(scheduleSrc).toContain("/followup-reminder");
    expect(scheduleSrc).toContain("recipient_phone: normalizedRecipient");
    expect(scheduleSrc).toContain("scheduled_for: iso");
  });
});

describe("workspace page wiring", () => {
  it("routes follow-up cell clicks through sequential state", () => {
    expect(pageSrc).toContain("openFollowupForRow");
    expect(pageSrc).toContain("/sales-followups?flow_run_id=");
    expect(pageSrc).toContain("result_required");
    expect(pageSrc).toContain("setRecordModal");
    expect(pageSrc).toContain("setHistoryModal");
    expect(pageSrc).toContain("attemptNumber:");
  });

  it("renders record + history dialogs with table refresh", () => {
    expect(pageSrc).toContain("<RecordFollowupResultDialog");
    expect(pageSrc).toContain("<FollowupHistoryDialog");
    expect(pageSrc).toContain("setHistoryRefreshSeq((n) => n + 1)");
  });

  it("opens reschedule mode from history with the saved instant", () => {
    // initialValue carries the stored ISO so the dialog prefills
    // the saved date/time (never tomorrow/1:30 PM); the PATCH
    // updates the same attempt in place.
    expect(pageSrc).toContain("onEditSchedule={(attempt)");
    expect(pageSrc).toContain("initialValue: attempt.scheduled_at");
    expect(pageSrc).toContain("rescheduleAttemptId: attempt.id");
  });

  it("adds follow-up history to the row actions menu (Meta only)", () => {
    expect(pageSrc).toContain("onOpenFollowups");
    expect(menuSrc).toContain("onOpenFollowups");
    expect(menuSrc).toContain("Follow-up history");
  });
});

describe("migration guard rails", () => {
  it("creates the attempts table with sequencing constraints", () => {
    expect(migrationSrc).toContain("CREATE TABLE IF NOT EXISTS sales_followup_attempts");
    expect(migrationSrc).toContain("uq_sales_followup_open_attempt");
    expect(migrationSrc).toContain("WHERE completed_at IS NULL");
    expect(migrationSrc).toContain("uq_sales_followup_attempt_number");
    expect(migrationSrc).toContain("CREATE TABLE IF NOT EXISTS sales_followup_closures");
  });

  it("relaxes completion to optional outcome via an additive migration", () => {
    const migration162 = src("supabase/migrations/162_sales_followup_optional_outcome.sql");
    // 161 is never rewritten: 162 drops + re-adds only the
    // completion CHECK, preserving every saved row.
    expect(migration162).toContain("sales_followup_attempts_completed_check");
    expect(migration162).toContain("DROP CONSTRAINT");
    expect(migration162).toContain("IF EXISTS");
    expect(migration162).toContain("length(btrim(result_text)) > 0");
  });

  it("never auto-writes scheduling text into Next Action", () => {
    const resultSrc = src(
      "src/app/api/flows/[id]/sales-followups/[attemptId]/result/route.ts",
    );
    // The route no longer resolves the Next Action field at all:
    // neither status strings nor prompts are written on completion.
    expect(resultSrc).not.toContain("nextActionField");
    expect(resultSrc).not.toContain("Schedule Follow-up ${");
    // History keeps the scheduling action instead.
    expect(historySrc).toContain("onScheduleNext");
    expect(historySrc).toContain("Schedule Follow-up {history.state.nextAttemptNumber}");
  });

  it("scopes RLS to the account with agent+ writes", () => {
    expect(migrationSrc).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migrationSrc).toContain("is_account_member(account_id)");
    expect(migrationSrc).toContain("is_account_member(account_id, 'agent')");
  });

  it("imports existing pending schedules without inventing history", () => {
    expect(migrationSrc).toContain("INSERT INTO sales_followup_attempts");
    expect(migrationSrc).toContain("next follow-up date & time");
    expect(migrationSrc).toContain("'migrated'");
    expect(migrationSrc).toContain("NOT EXISTS");
  });
});
