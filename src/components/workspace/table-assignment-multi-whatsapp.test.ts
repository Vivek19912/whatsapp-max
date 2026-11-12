import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE,
  normalizeWhatsappNumberInput,
  validateWhatsappNumberDrafts,
} from "./table-assignment-dialog";

// Structural contract for the multi-number WhatsApp editor in the
// per-table Assignment dialog. There is no live-DB harness here,
// so this pins the migration SQL text; behavior parity with the
// validators above is asserted branch by branch.
const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "150_lead_assignment_multi_whatsapp.sql"),
  "utf8"
);

describe("multi-WhatsApp migration contract (150)", () => {
  it("adds a JSONB recipient list on assignees (additive, no backfill)", () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS whatsapp_numbers JSONB NOT NULL DEFAULT '\[\]'/
    );
    expect(migration).not.toMatch(/DROP COLUMN/);
    expect(migration).not.toMatch(/UPDATE public\.lead_assignment_table_assignees/);
  });

  it("dedupes the outbox per recipient, preserving email dedup", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS recipient_key TEXT NOT NULL DEFAULT ''/);
    expect(migration).toMatch(
      /UNIQUE \(account_id, flow_run_id, assignee_id, channel, recipient_key\)/
    );
    // RLS posture untouched: no new policies needed for either column.
    expect(migration).not.toMatch(/CREATE POLICY/);
  });
});

describe("WhatsApp number draft helpers", () => {
  it("normalizes India E.164 numbers and rejects the rest", () => {
    expect(normalizeWhatsappNumberInput("+91 98765 43210")).toBe("+919876543210");
    expect(normalizeWhatsappNumberInput("+91-9876543210")).toBe("+919876543210");
    expect(normalizeWhatsappNumberInput("9876543210")).toBeNull();
    expect(normalizeWhatsappNumberInput("123")).toBeNull();
  });

  it("requires the +91 country code and exactly 10 digits", () => {
    // Non-Indian numbers are rejected even when valid E.164.
    expect(normalizeWhatsappNumberInput("+14155550123")).toBeNull();
    expect(normalizeWhatsappNumberInput("+911234567890")).toBe("+911234567890");
    // Short, long, and prefix-less inputs are rejected.
    expect(normalizeWhatsappNumberInput("+91123456789")).toBeNull();
    expect(normalizeWhatsappNumberInput("+9112345678901")).toBeNull();
    expect(normalizeWhatsappNumberInput("+919876543210")).toBe("+919876543210");
  });

  it("supports at least five numbers per assignee", () => {
    expect(MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE).toBeGreaterThanOrEqual(5);
    const five = Array.from({ length: 5 }, (_, i) => ({
      phone: `+9112345678${i}0`,
    }));
    expect(validateWhatsappNumberDrafts(five, "+919999999999", "Asha")).toBeNull();
  });

  it("rejects invalid numbers, duplicates, and over-capacity lists", () => {
    expect(
      validateWhatsappNumberDrafts([{ phone: "bad" }], "", "Asha")
    ).toMatch(/invalid/i);
    expect(
      validateWhatsappNumberDrafts(
        [{ phone: "+911234567890" }, { phone: "+911234567890" }],
        "",
        "Asha"
      )
    ).toMatch(/already configured/);
    expect(
      validateWhatsappNumberDrafts([{ phone: "+911234567891" }], "+911234567891", "Asha")
    ).toMatch(/already configured/);
    const over = Array.from({ length: MAX_WHATSAPP_NUMBERS_PER_ASSIGNEE + 1 }, (_, i) => ({
      phone: `+91123456${String(100 + i)}`,
    }));
    expect(validateWhatsappNumberDrafts(over, "", "Asha")).toMatch(/at most/);
  });
});

describe("WhatsApp numbers editor contract", () => {
  const dialogSrc = readFileSync(
    join(process.cwd(), "src", "components", "workspace", "table-assignment-dialog.tsx"),
    "utf8"
  );
  const editorSrc = readFileSync(
    join(process.cwd(), "src", "components", "workspace", "assignment-field-controls.tsx"),
    "utf8"
  );

  it("renders a per-number template picker with add/remove actions in Step 2", () => {
    // The multi-number editor lives in the Step 2 salesperson card
    // (WhatsappNumbersEditor), not in a buried advanced section.
    expect(editorSrc).toContain("WhatsApp numbers");
    expect(editorSrc).toContain("Add WhatsApp Number");
    expect(editorSrc).toContain("Remove extra WhatsApp number");
    expect(editorSrc).toContain("Template for extra WhatsApp number");
    // Each row reuses the approved-templates picker — never a free-text field.
    expect(editorSrc).toContain("Table default template");
    expect(dialogSrc).toContain("WhatsappNumbersEditor");
  });

  it("keeps email configuration single and separate", () => {
    // One email input per assignee on their Step 2 card; no email
    // list anywhere, and no duplicate email control in the dialog.
    expect(dialogSrc).toContain("Email address");
    expect(dialogSrc).not.toMatch(/Extra Email|extra-emails|email_numbers/i);
    expect(editorSrc).not.toMatch(/Extra Email|extra-emails|email_numbers/i);
  });

  it("persists numbers with per-number templates on save", () => {
    expect(dialogSrc).toContain("whatsapp_numbers: d.whatsapp_numbers.map");
    expect(dialogSrc).toContain("template_name: n.template_name.trim() || null");
    expect(editorSrc).toContain("onChange(numbers");
  });
});
