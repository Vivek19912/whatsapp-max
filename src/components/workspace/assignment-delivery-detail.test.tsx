// Recent alert deliveries — Detail cell render contract.
//
// Unlike the source pins in table-assignment-ui.test.ts, these tests
// render the ACTUAL TableCell component used by the live Assignment
// dialog and assert on the produced HTML. If the cell ever stops
// routing through formatDeliveryDetail, the raw ISO timestamp leaks
// into the markup here and these tests fail.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AssignmentDeliveryDetailCell } from "./table-assignment-dialog";

function sent(sent_at: string | null) {
  return { status: "sent", sent_at, last_error: null as string | null };
}

function failed(last_error: string | null) {
  return { status: "failed", sent_at: null as string | null, last_error };
}

describe("assignment delivery Detail cell (rendered output)", () => {
  it("renders sent timestamps as DD-MM-YYYY hh:mm AM/PM in IST, never raw ISO", () => {
    // Exact production case: 2026-10-27T20:10:07.947Z is 01:40 IST.
    const html = renderToStaticMarkup(
      <AssignmentDeliveryDetailCell notification={sent("2026-10-27T20:10:07.947+00:00")} />,
    );
    expect(html).toContain("28-10-2026 01:40 AM");
    expect(html).not.toContain("2026-10-27T20:10:07.947");
    // The tooltip carries the same formatted value (truncated cell
    // still reveals the full detail on hover).
    expect(html).toContain('title="28-10-2026 01:40 AM"');
  });

  it("renders template errors verbatim without reformatting", () => {
    const err =
      'Template "new_lead_notification" (en_US) cannot be sent: it needs the lead\'s phone number';
    const html = renderToStaticMarkup(
      <AssignmentDeliveryDetailCell notification={failed(err)} />,
    );
    // Verbatim (HTML-escaped by React, never reformatted or truncated).
    expect(html).toContain("new_lead_notification");
    expect(html).toContain("cannot be sent");
    expect(html).toContain("needs the lead");
    // No date-like mangling of the message.
    expect(html).not.toContain("2026-");
  });

  it("renders retrying and empty states unchanged", () => {
    expect(
      renderToStaticMarkup(<AssignmentDeliveryDetailCell notification={failed(null)} />),
    ).toContain(">retrying<");
    expect(
      renderToStaticMarkup(<AssignmentDeliveryDetailCell notification={sent(null)} />),
    ).not.toContain("NaN");
  });
});
