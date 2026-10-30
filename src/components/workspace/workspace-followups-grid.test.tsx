// Follow-ups table must use the Leads table's visual grid system:
// sticky pastel headers from the shared header-color model, full
// cell borders, unified scrolling viewport, Workspace pagination.
// Rendered-component tests via react-dom/server static markup,
// rendering FollowupsTable directly with fixed rows (the view
// loads its rows client-side, so the full view SSR-renders empty).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  assignHeaderBackgrounds,
  HEADER_REFERENCE_FOLLOW_UP,
  HEADER_REFERENCE_NAME,
  HEADER_REFERENCE_PHONE,
} from "@/lib/flows/header-colors";
import { FollowupsTable, WorkspaceFollowupsView } from "./workspace-followups-view";

const BACKGROUNDS = assignHeaderBackgrounds(
  [
    { visId: "followups:lead", label: "Name" },
    { visId: "followups:phone", label: "Phone Number" },
    { visId: "followups:assignee", label: "Assigned To" },
    { visId: "followups:datetime", label: "Follow-up Date & Time" },
    { visId: "followups:reminder", label: "Reminder" },
    { visId: "followups:status", label: "Follow-up Status" },
    { visId: "followups:message", label: "Message" },
  ],
  null,
);

const ROWS = [
  {
    id: "fu-1",
    status: "scheduled",
    scheduled_for: "2026-03-10T05:30:00.000Z",
    message_text: "Call about Dubai package",
    template_name: null,
    followup_completed_at: null,
    followup_completed_by: null,
    sent_at: null,
    failed_at: null,
    cancelled_at: null,
    failure_reason: null,
    bucket: "today",
    lead: { runId: "run-1", name: "Rushikesh", phone: "+919999999999", contactId: "c-1", conversationId: "conv-1" },
    assignee: { userId: "u-1", display: "Asha" },
  },
  {
    id: "fu-2",
    status: "sent",
    scheduled_for: "2026-03-08T05:30:00.000Z",
    message_text: "Done deal",
    template_name: null,
    followup_completed_at: "2026-03-09T01:00:00.000Z",
    followup_completed_by: "u-1",
    sent_at: "2026-03-08T05:31:00.000Z",
    failed_at: null,
    cancelled_at: null,
    failure_reason: null,
    bucket: "completed",
    lead: { runId: "run-2", name: "Rahul", phone: "+918888888888", contactId: "c-2", conversationId: null },
    assignee: null,
  },
] as const;

function html(): string {
  return renderToStaticMarkup(
    <FollowupsTable
      items={[...ROWS]}
      headerBackgrounds={BACKGROUNDS}
      flowId="flow-1"
      followupFieldId="f-fu"
      confirmId={null}
      actingId={null}
      onAskConfirm={() => {}}
      onCancelConfirm={() => {}}
      onAct={() => {}}
      onReschedule={() => {}}
    />,
  );
}

describe("icon cleanup (minimal visual noise)", () => {
  it("summary cards use typography only, no decorative icons", () => {
    const out = renderToStaticMarkup(
      <WorkspaceFollowupsView flowId="flow-1" followupFieldId="f-fu" onTableRefresh={() => {}} />,
    );
    expect(out).not.toContain("lucide-triangle-alert");
    expect(out).not.toContain("lucide-clock");
    expect(out).not.toContain("lucide-calendar");
    expect(out).not.toContain("lucide-check");
    // Counts still render as plain typography.
    expect(out).toContain(">Overdue<");
    expect(out).toContain(">Tomorrow<");
  });

  it("table actions are text buttons; only the shared Dial control keeps its glyph", () => {
    const out = renderToStaticMarkup(
      <FollowupsTable
        items={[...ROWS]}
        headerBackgrounds={BACKGROUNDS}
        flowId="flow-1"
        followupFieldId="f-fu"
        confirmId={null}
        actingId={null}
        onAskConfirm={() => {}}
        onCancelConfirm={() => {}}
        onAct={() => {}}
        onReschedule={() => {}}
      />,
    );
    expect(out).toContain(">Complete<");
    expect(out).toContain(">Reschedule<");
    expect(out).toContain(">Inbox<");
    expect(out).not.toContain("lucide-check");
    expect(out).not.toContain("lucide-rotate-ccw");
    const svgs = out.match(/<svg/g) ?? [];
    const phones = out.match(/lucide-phone/g) ?? [];
    expect(svgs.length).toBe(phones.length); // shared Dial glyph only
    expect(phones.length).toBeGreaterThan(0);
    expect(out).toContain("lucide-phone");
  });

  it("statuses render as subtle text badges without icons", () => {
    const out = renderToStaticMarkup(
      <FollowupsTable
        items={[...ROWS]}
        headerBackgrounds={BACKGROUNDS}
        flowId="flow-1"
        followupFieldId="f-fu"
        confirmId={null}
        actingId={null}
        onAskConfirm={() => {}}
        onCancelConfirm={() => {}}
        onAct={() => {}}
        onReschedule={() => {}}
      />,
    );
    expect(out).toContain("rounded-full");
    expect(out).toContain("Pending");
    expect(out).toContain("Completed");
    expect(out).toContain("Reminder sent");
  });
});
describe("follow-ups grid matches the Leads table system", () => {
  it("headers resolve through the shared positional palette with Leads semantics", () => {
    expect(BACKGROUNDS[0]).toBe(HEADER_REFERENCE_NAME);
    expect(BACKGROUNDS[1]).toBe(HEADER_REFERENCE_PHONE);
    expect(BACKGROUNDS[5]).toBe(HEADER_REFERENCE_FOLLOW_UP);
    // Adjacency guarantee from the shared builder: no two neighbours match.
    for (let i = 1; i < BACKGROUNDS.length; i += 1) {
      expect(BACKGROUNDS[i]).not.toBe(BACKGROUNDS[i - 1]);
    }
    const out = html();
    expect(out).toContain(`background-color:${HEADER_REFERENCE_NAME}`);
    expect(out).toContain(`background-color:${HEADER_REFERENCE_FOLLOW_UP}`);
    const fills = out.match(/background-color:#[0-9a-f]{6}/g) ?? [];
    expect(fills.length).toBeGreaterThanOrEqual(7);
  });

  it("uses the Leads sticky header row, dividers, and scrolling viewport", () => {
    const out = html();
    // Sticky opaque header row with th-level dividers (same as Leads).
    expect(out).toContain("sticky top-0 z-20 h-11");
    expect(out).toContain("border-r border-b border-border");
    // Unified scrolling viewport inside the rounded card shell.
    expect(out).toContain("workspace-table-viewport");
    expect(out).toContain("overflow-hidden rounded-xl border");
    // Header labels render in Leads typography.
    expect(out).toContain("Lead Name");
    expect(out).toContain("Phone Number");
    expect(out).toContain("Follow-up Date &amp; Time");
    expect(out).toContain("Follow-up Status");
  });

  it("lead name and phone render in separate columns; date and time share one cell", () => {
    const out = html();
    const nameIdx = out.indexOf("Rushikesh");
    const phoneIdx = out.indexOf("+919999999999");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(phoneIdx).toBeGreaterThan(nameIdx);
    // Phone no longer nested under the name cell.
    expect(out).not.toMatch(/Rushikesh[\s\S]{0,120}text-xs text-muted-foreground/);
    // Combined date-time cell keeps the underlying instant's display.
    expect(out).toMatch(/\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [ap]m/i);
    // No standalone Time header remains.
    expect(out).not.toContain(">Time<");
  });

  it("vertical separators extend through header and body rows", () => {
    const out = html();
    // Every one of the 8 headers carries a right border (last- suppressed).
    const headBorders = out.match(/border-r border-b border-border/g) ?? [];
    expect(headBorders.length).toBeGreaterThanOrEqual(8);
    // Body cells carry matching right borders; row content renders.
    expect(out).toContain("Rushikesh");
    expect(out).toContain("+919999999999");
    expect(out).toContain("Asha");
  });

  it("Actions header reuses the Dial action-column treatment", () => {
    const out = html();
    expect(out).toContain("bg-[#F1F5F9]");
    expect(out).toContain("[html[data-mode=dark]_&amp;]:bg-muted");
    expect(out).toContain(">Actions<");
  });

  it("message and status cells keep their content with grid borders", () => {
    const out = html();
    expect(out).toContain("Call about Dubai package");
    expect(out).toContain("Reminder sent");
    expect(out).toContain("Pending");
    expect(out).toContain("Completed");
  });
});
