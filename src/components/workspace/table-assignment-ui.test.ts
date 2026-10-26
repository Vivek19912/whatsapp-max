// Per-table Assignment UI entry points — source pins.
//
// The Assignment action must be reachable from the Workspace
// header for BOTH Meta Lead Ads tables and Flow tables
// (owner-gated), rendering one shared single-panel dialog keyed
// by flow.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("assignment entry points in the workspace header", () => {
  const page = src("src/app/(dashboard)/workspace/page.tsx");

  it("shows Assignment for Meta tables next to Configure Sheet (owner only)", () => {
    expect(page).toContain("Assignment");
    expect(page).toContain("setAssignmentDialogOpen(true)");
    // Same owner + table gate family as Configure Sheet.
    expect(page).toContain("{isMetaTable && isOwner && flowId ?");
  });

  it("shows Assignment for Flow tables too (owner only, no sheet actions)", () => {
    expect(page).toContain("{!isMetaTable && isOwner && flowId ?");
    expect(page).toContain("TableAssignmentDialog");
    expect(page).not.toContain("Configure Sheet\" : null");
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

  it("covers status, method, timezone, assignees, pauses, and deliveries", () => {
    for (const section of [
      "Automatic assignment",
      "Distribution method",
      "Timezone",
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
});
