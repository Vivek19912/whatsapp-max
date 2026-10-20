import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FlowAnswerCell } from "./flow-answer-cell";
import { TextCellPopover } from "./text-cell-popover";

// ---------------------------------------------------------------------------
// Editable flow-derived cells — display = override ?? original,
// originals recoverable, restore removes the row. SSR covers
// trigger markup (portal content is client-mounted); source
// patterns cover wiring that needs interaction (PUT/DELETE,
// focus, guards).
// ---------------------------------------------------------------------------

const root = process.cwd();
const cellSrc = readFileSync(
  `${root}/src/components/workspace/flow-answer-cell.tsx`,
  "utf8",
);
const popoverSrc = readFileSync(
  `${root}/src/components/workspace/text-cell-popover.tsx`,
  "utf8",
);

function renderCell(partial?: Partial<Parameters<typeof FlowAnswerCell>[0]>) {
  return renderToStaticMarkup(
    <FlowAnswerCell
      flowId="flow-1"
      runId="run-1"
      columnKey="Hotel"
      label="Hotel"
      original="5 Star Hotel"
      override={undefined}
      canEdit
      onChanged={vi.fn()}
      {...partial}
    />,
  );
}

describe("1+3. text cells display the original, then the override", () => {
  it("initially displays the original flow answer", () => {
    const html = renderCell();
    expect(html).toContain("5 Star Hotel");
  });

  it("an override replaces the display without touching the original prop", () => {
    const html = renderCell({ override: "4 Star Hotel" });
    expect(html).toContain("4 Star Hotel");
    // The original is still reachable for restore (wiring below).
    expect(cellSrc).toContain("originalValue={original}");
  });
});

describe("edited indicator (subtle, never a large badge)", () => {
  it("unedited cells carry no indicator", () => {
    const html = renderCell();
    expect(html).not.toContain('aria-label="Edited"');
  });

  it("edited cells carry a subtle dot with the original in its tooltip", () => {
    const html = renderCell({ override: "4 Star Hotel" });
    expect(html).toContain('aria-label="Edited"');
    expect(html).toContain("5 Star Hotel");
    expect(html).not.toContain("<svg");
  });
});

describe("restore affordance visibility rules", () => {
  it("restore UI is wired through the shared popover (original + action)", () => {
    expect(cellSrc).toContain("onRestore={() => request(\"DELETE\")}");
    expect(popoverSrc).toContain("Restore original");
    expect(popoverSrc).toContain("Original flow value:");
  });

  it("saves go through PUT flow-overrides with the exact value", () => {
    expect(cellSrc).toContain("/api/flows/${flowId}/flow-overrides");
    expect(cellSrc).toContain("onSave={(v) => request(\"PUT\", v)}");
  });

  it("parent refreshes after save/restore (no parallel persistence)", () => {
    // One shared request path refreshes on success for both PUT and
    // DELETE; failures return early without refreshing.
    const calls = cellSrc.split("onChanged()").length - 1;
    expect(calls).toBe(1);
    expect(cellSrc).not.toContain("workspace_values");
    expect(cellSrc).not.toContain("flow_runs");
  });
});

describe("10+11+12. select/number/date editing paths", () => {
  it("10. options render a chevron-less dropdown with Clear", () => {
    const html = renderCell({ options: ["5 Star Hotel", "4 Star Hotel"] });
    expect(html).toContain("[&amp;_svg]:hidden");
    expect(html).toContain("5 Star Hotel");
  });

  it("11+12. number/date answers reuse the exact-text popover (no normalization)", () => {
    const html = renderCell({ original: "042", override: undefined });
    expect(html).toContain("042");
    expect(cellSrc).toContain("<TextCellPopover");
  });

  it("read-only cells keep the plain/reader surface (never an editor)", () => {
    const blank = renderCell({ original: null, override: undefined, canEdit: false });
    expect(blank).not.toContain("popover-trigger");
    const filled = renderCell({ canEdit: false });
    expect(filled).toContain("popover-trigger");
    expect(filled).not.toContain("Restore original");
  });
});

describe("13+14+15+16. long text, empty entry, and clearing", () => {
  it("13. long text triggers the shared long-text popover", () => {
    const long = "word ".repeat(200);
    const html = renderCell({ original: long });
    expect(html).toContain("popover-trigger");
    expect(html).toContain("truncate");
  });

  it("system columns never render through the flow editor", () => {
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    expect(page).toContain("!c.system && flowId !== null");
  });
});

describe("17+18. Name identity rules", () => {
  it("17. flow Name columns use key identity (page passes columnKey)", () => {
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    expect(page).toContain("columnKey={c.key}");
  });

  it("18. WhatsApp/system Name stays on the contact source", () => {
    const page = readFileSync(
      `${root}/src/app/(dashboard)/workspace/page.tsx`,
      "utf8",
    );
    // System cells render via cellText (contact name); the flow
    // editor only mounts for non-system columns.
    expect(page).toContain("cellText(row, c)");
  });
});

describe("TextCellPopover restore props (shared surface)", () => {
  it("unedited popovers show no restore UI", () => {
    const html = renderToStaticMarkup(
      <TextCellPopover fieldLabel="Hotel" value="5 Star Hotel" editable />,
    );
    expect(html).not.toContain("Restore original");
    expect(html).not.toContain('aria-label="Edited"');
  });

  it("edited popovers expose the dot (panel content mounts client-side)", () => {
    const html = renderToStaticMarkup(
      <TextCellPopover
        fieldLabel="Hotel"
        value="4 Star Hotel"
        editable
        originalValue="5 Star Hotel"
        onRestore={async () => true}
      />,
    );
    expect(html).toContain('aria-label="Edited"');
    expect(html).toContain("5 Star Hotel");
  });
});

describe("attachment cells open the file in a new tab", () => {
  it("renders the filename as a link to the existing media URL", () => {
    const html = renderCell({
      original: "Itinerary.pdf",
      fileUrl: "/api/whatsapp/media/m-2",
    });
    expect(html).toContain('href="/api/whatsapp/media/m-2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // The SAME filename keeps displaying — never rewritten.
    expect(html).toContain("Itinerary.pdf");
    // Link markup replaces the popover trigger (no <button> cell).
    expect(html).not.toContain("<button");
  });

  it("keeps truncation/ellipsis styling and a hover affordance", () => {
    const html = renderCell({
      original: "Lord Shiva 4K Wallpaper Ultra HD 3840x2160.jpg",
      fileUrl: "/api/whatsapp/media/m-1",
    });
    expect(html).toContain("truncate");
    expect(html).toContain("hover:underline");
  });

  it("leaves ordinary text cells untouched (no fileUrl → popover)", () => {
    const html = renderCell({ original: "5 Star Hotel" });
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain("<button");
  });

  it("renders nothing when the attachment cell is empty", () => {
    const html = renderCell({
      original: null,
      override: null,
      fileUrl: "/api/whatsapp/media/m-2",
    });
    // display is blank → no link (matches the blank-cell rule).
    expect(html).not.toContain('target="_blank"');
  });

  it("shows the edited dot when a Workspace override exists", () => {
    const html = renderCell({
      original: "Old.pdf",
      override: "New.pdf",
      fileUrl: "/api/whatsapp/media/m-2",
    });
    expect(html).toContain('aria-label="Edited"');
    expect(html).toContain("New.pdf");
  });

  it("compares the edited dot against the raw original for Meta tables", () => {
    // Display shows the mapped label; the dot keys off the raw answer.
    const edited = renderCell({
      original: "Adobe Premiere Pro",
      override: "Video Editing",
      rawOriginal: "adobe_premiere_pro",
    });
    expect(edited).toContain('aria-label="Edited"');
    expect(edited).toContain("Edited — original: adobe_premiere_pro");
    // Override identical to the raw original → not edited, no restore cue.
    const unedited = renderCell({
      original: "Adobe Premiere Pro",
      override: "adobe_premiere_pro",
      rawOriginal: "adobe_premiere_pro",
    });
    expect(unedited).not.toContain('aria-label="Edited"');
  });

  it("keeps legacy behavior without a raw original (Flow Tables)", () => {
    // No rawOriginal: edited state derives from the displayed value,
    // exactly as before this change.
    const edited = renderCell({ original: "Old.pdf", override: "New.pdf" });
    expect(edited).toContain('aria-label="Edited"');
    const same = renderCell({ original: "Same", override: "Same" });
    expect(same).not.toContain('aria-label="Edited"');
  });
});
