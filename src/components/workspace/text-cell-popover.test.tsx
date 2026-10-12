import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TextCellPopover,
  TextEditorPanel,
  formatCharCount,
  isCancelKey,
  isDirtyDraft,
  isSaveShortcut,
  textEditorClassName,
} from "./text-cell-popover";
import { CustomCell } from "./custom-cell";
import type { WorkspaceField } from "@/lib/flows/workspace-fields";

// ---------------------------------------------------------------------------
// Long-text cell viewer/editor — one surface for READ + WRITE.
// SSR covers markup (portal content is client-mounted); pure helpers
// cover keys/counts/sizing; source patterns cover wiring that needs
// interaction (save path, guards, focus). Genuinely long fixture.
// ---------------------------------------------------------------------------

const LONG_TEXT = [
  "this is the gamethis is the gamethis is the gamethis is the game",
  "We are interested in a family package for 6N / 7D with cruise. 🎉",
  "Please share the best itinerary & \"special\" <deals> — don't normalize!",
  "Line four keeps going with more words so the value is very long. ".repeat(6),
].join("\n");

const root = process.cwd();
const popoverSrc = readFileSync(
  `${root}/src/components/workspace/text-cell-popover.tsx`,
  "utf8",
);
const cellSrc = readFileSync(
  `${root}/src/components/workspace/custom-cell.tsx`,
  "utf8",
);
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

function textField(partial?: Partial<WorkspaceField>): WorkspaceField {
  return {
    id: "field-text",
    account_id: "acct-1",
    flow_id: "flow-1",
    name: "Customer Response",
    field_type: "text",
    position: 7,
    options: null,
    default_value: null,
    currency_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function panel(partial?: Partial<Parameters<typeof TextEditorPanel>[0]>) {
  const noop = () => {};
  return renderToStaticMarkup(
    <TextEditorPanel
      fieldLabel="Customer Response"
      draft={LONG_TEXT}
      editable
      saving={false}
      expanded={false}
      dirtyNotice={false}
      onDraftChange={noop}
      onToggleExpand={noop}
      onCloseRequest={noop}
      onCancel={noop}
      onSave={noop}
      {...partial}
    />,
  );
}

describe("1+2. table cells stay compact and truncated", () => {
  it("short text renders normally in the trigger", () => {
    const html = renderToStaticMarkup(
      <TextCellPopover fieldLabel="Name" value="Rahul" editable={false} />,
    );
    expect(html).toContain("Rahul");
    expect(html).toContain("<button");
  });

  it("long text trigger truncates without growing the cell", () => {
    const html = renderToStaticMarkup(
      <TextCellPopover fieldLabel="Customer Response" value={LONG_TEXT} editable={false} />,
    );
    expect(html).toContain("truncate");
    // Closed popover: editor internals stay unmounted (portal).
    expect(html).not.toContain("<textarea");
  });
});

describe("3+4. clicking opens the editor with the full text", () => {
  it("trigger is a keyboard-accessible button wired to the popover", () => {
    const html = renderToStaticMarkup(
      <TextCellPopover fieldLabel="Customer Response" value={LONG_TEXT} editable />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("popover-trigger");
  });

  it("open panel shows the complete value", () => {
    const html = panel();
    expect(html).toContain("this is the game");
    expect(html).toContain("Please share the best itinerary");
    expect(html).toContain("Customer Response");
  });
});

describe("5+6. wrapping and internal scrolling", () => {
  it("textarea wraps (no wrap=off) inside both modes", () => {
    for (const expanded of [false, true]) {
      const html = panel({ expanded });
      expect(html).toContain("<textarea");
      expect(html).not.toContain('wrap="off"');
    }
  });

  it("compact caps height with internal scroll; expanded is roomier", () => {
    const compact = textEditorClassName(false);
    expect(compact).toContain("max-h-56");
    expect(compact).toContain("overflow-y-auto");
    const expanded = textEditorClassName(true);
    expect(expanded).toContain("max-h-[60vh]");
    expect(expanded).toContain("overflow-y-auto");
    expect(expanded).not.toBe(compact);
  });
});

describe("7. character count updates live", () => {
  it("formats singular/plural counts", () => {
    expect(formatCharCount(248)).toBe("248 characters");
    expect(formatCharCount(1)).toBe("1 character");
    expect(formatCharCount(0)).toBe("0 characters");
  });

  it("panel shows the count for the current draft", () => {
    expect(panel()).toContain(`${LONG_TEXT.length} characters`);
    expect(panel({ draft: "" })).toContain("0 characters");
    expect(panel()).toContain("Ctrl/Cmd + Enter to save");
  });
});

describe("8+9. save and cancel persistence behavior", () => {
  it("text saves through the existing workspace-values path", () => {
    expect(cellSrc).toContain("onSave={save}");
    expect(cellSrc).toContain("/api/flows/${flowId}/workspace-values");
    // Failed saves keep the editor open instead of closing.
    expect(popoverSrc).toContain("if (ok === false) return;");
  });

  it("cancel never persists (discards without touching onSave)", () => {
    const fn = popoverSrc.slice(
      popoverSrc.indexOf("function discardAndClose"),
      popoverSrc.indexOf("async function handleSave"),
    );
    expect(fn).not.toContain("onSave");
    expect(fn).toContain("setDraft(value)");
  });
});

describe("10+11+12. keyboard shortcuts", () => {
  it("Escape cancels", () => {
    expect(isCancelKey({ key: "Escape" })).toBe(true);
    expect(isCancelKey({ key: "Enter" })).toBe(false);
  });

  it("Ctrl+Enter and Cmd+Enter save; plain Enter does not", () => {
    expect(isSaveShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSaveShortcut({ key: "Enter", metaKey: true })).toBe(true);
    expect(isSaveShortcut({ key: "Enter" })).toBe(false);
    expect(isSaveShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSaveShortcut({ key: "a", ctrlKey: true })).toBe(false);
  });

  it("panel wires the shortcuts on the textarea", () => {
    expect(popoverSrc).toContain("isCancelKey(e)");
    expect(popoverSrc).toContain("isSaveShortcut(e)");
  });
});

describe("13. empty text cells open an empty editable surface", () => {
  it("empty draft renders an empty textarea with Save available", () => {
    const html = panel({ draft: "" });
    expect(html).toContain("<textarea");
    expect(html).toContain(">Save<");
    expect(html).toContain("0 characters");
  });

  it("dirty tracking distinguishes empty from entered text", () => {
    expect(isDirtyDraft("", "")).toBe(false);
    expect(isDirtyDraft("hello", "")).toBe(true);
    expect(isDirtyDraft("a", "b")).toBe(true);
  });
});

describe("14+15. exact text preservation", () => {
  it("line breaks survive into the editor", () => {
    const html = panel();
    expect(html).toContain("cruise. 🎉");
    expect(html).toContain("Please share");
  });

  it("emoji and special characters survive (escaped, never stripped)", () => {
    const html = panel();
    expect(html).toContain("🎉");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;deals&gt;");
    expect(html).toContain("don&#x27;t");
  });

  it("draft initializes to the exact value and saves it verbatim", () => {
    expect(popoverSrc).toContain("useState(value)");
    expect(popoverSrc).toContain("onSave?.(draft)");
    expect(popoverSrc).not.toMatch(/onSave\?\.\(draft\.trim\(\)\)/);
  });
});

describe("16+17. selects keep dropdown behavior (never the text editor)", () => {
  function renderCell(f: WorkspaceField, stored: string | null) {
    return renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={f}
        stored={stored}
        canEdit
        onSaved={vi.fn()}
        members={[]}
      />,
    );
  }

  it("single-select and assignee cells do not render the text popover", () => {
    for (const f of [
      textField({ name: "Type", field_type: "single_select", options: ["Fresh", "Hot"] }),
      textField({ name: "Stage", field_type: "single_select", options: ["New Lead"] }),
      textField({ name: "Assigned To", field_type: "single_select", options: ["Unassigned"] }),
      textField({ name: "Call Status", field_type: "single_select", options: ["Busy"] }),
    ]) {
      const html = renderCell(f, null);
      expect(html).not.toContain("popover-trigger");
    }
  });

  it("non-text inputs (url/date/number) keep their inline editors", () => {
    for (const f of [
      textField({ name: "Link", field_type: "url" }),
      textField({ name: "When", field_type: "date" }),
      textField({ name: "Count", field_type: "number" }),
    ]) {
      const html = renderCell(f, null);
      expect(html).not.toContain("popover-trigger");
    }
  });

  it("text cells do render the popover trigger", () => {
    const html = renderCell(textField(), "hello");
    expect(html).toContain("popover-trigger");
  });

  it("dropdown chips still render for saved select values", () => {
    const html = renderCell(
      textField({ name: "Lead Type", field_type: "single_select", options: ["Fresh", "Hot"] }),
      "Hot",
    );
    expect(html).toContain("Hot");
    expect(html).toContain("background-color");
  });
});

describe("18+19+20. table UX preserved (resize, sticky, scroll)", () => {
  it("column resizing, sticky headers, and scroll containers are intact", () => {
    expect(pageSrc).toContain("ColumnResizeHandle");
    expect(pageSrc).toContain("sticky top-0");
    expect(pageSrc).toContain("workspace-table-viewport");
    expect(pageSrc).toContain("overflow-auto");
  });
});

describe("21. popover escapes table overflow via portal", () => {
  it("content renders through the portal primitive", () => {
    const ui = readFileSync(`${root}/src/components/ui/popover.tsx`, "utf8");
    expect(ui).toContain("PopoverPrimitive.Portal");
    expect(popoverSrc).toContain("PopoverContent");
  });
});

describe("22+23+24. expand mode", () => {
  it("expand preserves the current text", () => {
    const html = panel({ expanded: true });
    expect(html).toContain("this is the game");
    expect(html).toContain("Please share the best itinerary");
    expect(html).toContain("Collapse editor");
  });

  it("expanded save/cancel affordances match compact behavior", () => {
    const html = panel({ expanded: true });
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
    expect(html).toContain(`${LONG_TEXT.length} characters`);
  });

  it("expand is opt-in (compact default) with a toggle back", () => {
    const compact = panel();
    expect(compact).toContain("Expand editor");
    expect(compact).not.toContain("Collapse editor");
    expect(popoverSrc).toContain("setExpanded(false)");
  });
});

describe("25. focus management", () => {  it("cursor is placed at the end on open; trigger regains focus on close", () => {
    expect(popoverSrc).toContain("setSelectionRange(el.value.length, el.value.length)");
    const closes = popoverSrc.split("focusTrigger()").length - 1;
    expect(closes).toBeGreaterThanOrEqual(2);
  });

  it("outside dismiss never saves; dirty outside-dismiss stays open", () => {
    // Escape bypasses the guard (explicit cancel); every other
    // passive dismissal hits the dirty guard below it.
    expect(popoverSrc).toContain('details?.reason === "escape-key"');
    const guardStart = popoverSrc.indexOf(
      "if (editable && isDirtyDraft(draft, value)) {",
    );
    const guardEnd = popoverSrc.indexOf("async function handleRestore", guardStart);
    const guard = popoverSrc.slice(guardStart, guardEnd);
    expect(guard).toContain("setDirtyNotice(true)");
    expect(guard).not.toContain("setOpen(false)");
  });
});

describe("26. two-line clamp for Customer Response / Next Action", () => {
  const LONG_PLAIN = "word ".repeat(120).trim();

  function renderPopover(value: string, twoLineClamp?: boolean) {
    return renderToStaticMarkup(
      <TextCellPopover
        fieldLabel="Customer Response"
        value={value}
        editable={false}
        twoLineClamp={twoLineClamp}
      />,
    );
  }

  function renderCell(name: string, stored: string | null, twoLineClamp?: boolean) {
    return renderToStaticMarkup(
      <CustomCell
        flowId="flow-1"
        runId="run-1"
        field={textField({ name })}
        stored={stored}
        canEdit
        onSaved={vi.fn()}
        members={[]}
        twoLineClamp={twoLineClamp}
      />,
    );
  }

  it("default trigger keeps single-line truncation (other columns unchanged)", () => {
    const html = renderPopover(LONG_PLAIN);
    expect(html).toContain("truncate");
    expect(html).not.toContain("line-clamp-2");
  });

  it("clamped trigger wraps to 2 lines with ellipsis styling", () => {
    const html = renderPopover(LONG_PLAIN, true);
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("whitespace-normal");
    expect(html).toContain("break-words");
    expect(html).toContain("leading-[22px]");
    // The clamped span no longer single-line truncates.
    expect(html).not.toContain("truncate");
  });

  it("clamping is visual only — the full text stays in the trigger markup", () => {
    const html = renderPopover(LONG_PLAIN, true);
    expect(html).toContain(LONG_PLAIN);
  });

  it("short and empty values render under the clamp without errors", () => {
    expect(renderPopover("OK", true)).toContain("OK");
    expect(renderPopover("OK", true)).toContain("line-clamp-2");
    expect(renderPopover("", true)).toContain("line-clamp-2");
  });

  it("CustomCell threads the clamp to editable and read-only text cells", () => {
    for (const canEdit of [true, false]) {
      const html = renderToStaticMarkup(
        <CustomCell
          flowId="flow-1"
          runId="run-1"
          field={textField()}
          stored={LONG_PLAIN}
          canEdit={canEdit}
          onSaved={vi.fn()}
          members={[]}
          twoLineClamp
        />,
      );
      expect(html).toContain("line-clamp-2");
      expect(html).toContain("popover-trigger");
    }
    // Opt-in: omitted prop keeps the old single-line trigger.
    expect(renderCell("Customer Response", LONG_PLAIN)).toContain("truncate");
    expect(renderCell("Customer Response", LONG_PLAIN)).not.toContain(
      "line-clamp-2",
    );
  });

  it("non-text cells never clamp (selects keep dropdowns)", () => {
    // Single-select/assignee fields never render the text
    // popover at all, clamped or not.
    for (const [f, stored] of [
      [
        textField({ name: "Type", field_type: "single_select", options: ["Fresh", "Hot"] }),
        "Fresh",
      ],
      [
        textField({ name: "Stage", field_type: "single_select", options: ["New Lead"] }),
        "New Lead",
      ],
    ] as const) {
      const selectHtml = renderToStaticMarkup(
        <CustomCell
          flowId="flow-1"
          runId="run-1"
          field={f}
          stored={stored}
          canEdit
          onSaved={vi.fn()}
          members={[]}
          twoLineClamp
        />,
      );
      expect(selectHtml).not.toContain("line-clamp-2");
      expect(selectHtml).not.toContain("popover-trigger");
    }
  });

  it("the page wires the clamp + padding + 448px width for exactly the two columns", () => {
    expect(pageSrc).toContain("twoLineClamp={isWideTextColumnName(f.name)}");
    expect(pageSrc).toContain("max-w-112 whitespace-normal px-3 py-2");
    // The clamp itself lives on the popover trigger (visual only).
    expect(popoverSrc).toContain("line-clamp-2");
    // Widths unchanged: the doubled 448px default still feeds
    // header and body from one source.
    expect(pageSrc).toContain("defaultColumnWidthsForFields(customFields)");
    expect(pageSrc).toContain("effectiveColumnWidths");
    // Click-to-edit popover path is intact.
    expect(pageSrc).toContain("<CustomCell");
    expect(cellSrc).toContain("onSave={save}");
  });

  it("the open editor still shows the complete original text", () => {
    const html = panel();
    expect(html).toContain("this is the game");
    expect(html).toContain("Please share the best itinerary");
    expect(html).not.toContain("line-clamp-2");
  });
});
