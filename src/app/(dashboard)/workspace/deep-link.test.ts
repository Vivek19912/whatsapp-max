import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  findWorkspaceRowForContact,
  type FlowTableRow,
} from "@/lib/flows/flow-tables";

// ---------------------------------------------------------------------------
// Workspace ?contact= deep link (e.g. from Call Recordings →
// "Open in Workspace").
//
// Regression: the deep-link effect used to stamp appliedContactRef
// BEFORE checking payload, so on fresh navigation (payload null on
// the first run) the retry after rows arrived hit the
// already-applied guard and the lead was never selected. The effect
// must return before touching the ref while payload is missing, and
// stamp the ref only after a successful selection.
//
// The effect itself lives in the client page (no DOM under vitest's
// node environment — same constraint as workspace-table-grid.test),
// so ordering is pinned via the page source while matching
// semantics go through the real helper.
// ---------------------------------------------------------------------------

const root = process.cwd();
const pageSrc = readFileSync(
  `${root}/src/app/(dashboard)/workspace/page.tsx`,
  "utf8",
);

function effectSrc(): string {
  const start = pageSrc.indexOf("const deepLinkParams = useSearchParams()");
  expect(start).toBeGreaterThan(-1);
  const end = pageSrc.indexOf(
    "}, [deepLinkContactId, highlightOnly, payload, pageSize, selected]);",
    start,
  );
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

function row(partial?: Partial<FlowTableRow>): FlowTableRow {
  return {
    runId: "run-1",
    contactId: "c-1",
    conversationId: null,
    name: null,
    phone: null,
    startedAt: "2026-09-18T10:00:00.000Z",
    lastAdvancedAt: null,
    completedAt: null,
    status: "completed",
    runStatus: "completed",
    answers: {},
    ...partial,
  };
}

describe("deep link + payload null → ref remains unset", () => {
  it("returns before touching appliedContactRef while payload is missing", () => {
    const src = effectSrc();
    const guard = "if (!deepLinkContactId || !payload) return;";
    expect(src).toContain(guard);
    // The FIRST write to the ref must come after the payload guard —
    // otherwise a fresh navigation (payload null on run 1) marks the
    // param applied and the later retry is suppressed.
    const guardIdx = src.indexOf(guard);
    const writeIdx = src.indexOf("appliedContactRef.current =");
    expect(writeIdx).toBeGreaterThan(guardIdx);
  });
});

describe("deep link + payload later arrives → matching row is selected", () => {
  it("finds the row for the deep-linked contact once rows exist", () => {
    const rows = [row({ runId: "r-1", contactId: "c-9" }), row({ runId: "r-2" })];
    expect(findWorkspaceRowForContact(rows, "c-1")?.runId).toBe("r-2");
  });

  it("selects inside `if (row)` and stamps the ref only on success", () => {
    const src = effectSrc();
    const findIdx = src.indexOf("findWorkspaceRowForContact(payload.rows");
    expect(findIdx).toBeGreaterThan(-1);
    const tail = src.slice(findIdx);
    expect(tail).toContain("if (row)");
    const ifIdx = tail.indexOf("if (row)");
    const selectIdx = tail.indexOf("setSelected(row)");
    const writeIdx = tail.indexOf("appliedContactRef.current = deepLinkContactId");
    expect(selectIdx).toBeGreaterThan(ifIdx);
    // Stamped only after a successful selection — never before data.
    expect(writeIdx).toBeGreaterThan(selectIdx);
  });

  it("re-runs when the late payload arrives", () => {
    expect(pageSrc).toContain(
      "}, [deepLinkContactId, highlightOnly, payload, pageSize, selected]);",
    );
  });
});

describe("matching row is selected only once", () => {
  it("keeps the already-applied early-return guard", () => {
    const src = effectSrc();
    expect(src).toContain(
      "if (appliedContactRef.current === deepLinkContactId) return;",
    );
  });
});

describe("invalid contact ID → existing behavior unchanged", () => {
  it("matches nothing, so no selection fires", () => {
    const rows = [row({ runId: "r-1" })];
    expect(findWorkspaceRowForContact(rows, "c-evil")).toBeNull();
    expect(findWorkspaceRowForContact(rows, null)).toBeNull();
    expect(findWorkspaceRowForContact(rows, "")).toBeNull();
  });
});

describe("existing manual Workspace row selection remains unchanged", () => {
  it("row click still selects directly, independent of the deep link", () => {
    expect(pageSrc).toContain("onClick={() => setSelected(row)}");
  });
});

describe("cross-pagination locate (?contact= not on the loaded page)", () => {
  it("fires a targeted lookup only on a miss, once per param value", () => {
    const src = effectSrc();
    expect(src).toContain(
      "`/api/workspace/locate-contact?contact_id=${encodeURIComponent(deepLinkContactId)}&page_size=${pageSize}`",
    );
    expect(src).toContain(
      "if (selected || locatedContactRef.current === deepLinkContactId) return;",
    );
  });

  it("navigates through normal flow/view/page state on a hit", () => {
    const src = effectSrc();
    expect(src).toContain("setFlowId(body.flow_id);");
    expect(src).toContain("setView(body.view);");
    expect(src).toContain("setPage(body.page);");
  });

  it("validates the located coordinates before applying them", () => {
    const src = effectSrc();
    expect(src).toContain(
      "if (body.view !== 'completed' && body.view !== 'incomplete') return;",
    );
    expect(src).toContain(
      "if (!Number.isInteger(body.page) || body.page < 0) return;",
    );
  });

  it("a non-hit shows a notice and navigates nowhere (plain table otherwise)", () => {
    const src = effectSrc();
    expect(src).toContain("if (!body || body.found !== true) {");
    expect(src).toContain("setDeepLinkNotice(");
    // Never navigates to an unrelated lead on a miss.
    const missIdx = src.indexOf("if (!body || body.found !== true) {");
    const missBlock = src.slice(missIdx, missIdx + 600);
    expect(missBlock).not.toContain("setFlowId");
    expect(missBlock).not.toContain("setPage");
  });

  it("a manual selection wins over the lookup", () => {
    const src = effectSrc();
    // Manual row click sets `selected`; the locate branch bails
    // before fetching, so the user is never yanked away.
    expect(src.indexOf("if (selected")).toBeLessThan(
      src.indexOf("/api/workspace/locate-contact"),
    );
  });
});

describe("highlight-only mode (?contact=<id>&highlight=only)", () => {
  it("reads the mode from the query string (default off)", () => {
    const src = effectSrc();
    expect(src).toContain(
      "const highlightOnly = deepLinkParams.get('highlight') === 'only';"
    );
  });

  it("skips the drawer selection but still highlights the located row", () => {
    const src = effectSrc();
    const findIdx = src.indexOf("findWorkspaceRowForContact(payload.rows");
    expect(findIdx).toBeGreaterThan(-1);
    const tail = src.slice(findIdx);
    expect(tail).toContain("if (!highlightOnly) setSelected(row);");
    expect(tail).toContain("setHighlightContactId(deepLinkContactId)");
    // Highlight arms in both modes (drawer open or not).
    const markIdx = tail.indexOf("setHighlightContactId(deepLinkContactId)");
    const selectIdx = tail.indexOf("if (!highlightOnly) setSelected(row);");
    expect(markIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(-1);
  });

  it("keeps locate, pagination, scroll, and notice behavior identical", () => {
    const src = effectSrc();
    // The mode only gates setSelected: lookup, navigation, and
    // miss handling run exactly as before.
    expect(src).toContain("setFlowId(body.flow_id);");
    expect(src).toContain("setDeepLinkNotice(");
  });
});

describe("located lead is scrolled to and temporarily highlighted", () => {
  it("arms the highlight when the deep-linked row is selected", () => {
    const src = effectSrc();
    const findIdx = src.indexOf("findWorkspaceRowForContact(payload.rows");
    expect(findIdx).toBeGreaterThan(-1);
    const tail = src.slice(findIdx);
    // Same branch that selects the row also arms its highlight —
    // covers both the direct hit and the post-locate-navigation
    // hit, since locate routes back through this match.
    expect(tail).toContain("setHighlightContactId(deepLinkContactId)");
    const ifIdx = tail.indexOf("if (row)");
    const markIdx = tail.indexOf("setHighlightContactId(deepLinkContactId)");
    expect(markIdx).toBeGreaterThan(ifIdx);
  });

  it("scrolls the row into view and clears the highlight after ~4s", () => {
    expect(pageSrc).toContain("document.querySelector(");
    expect(pageSrc).toContain('`tr[data-contact-id="${highlightContactId}"]`');
    expect(pageSrc).toContain(
      "el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });",
    );
    expect(pageSrc).toContain(
      "window.setTimeout(() => setHighlightContactId(null), 4000);",
    );
  });

  it("hooks rows by stable contact id for the highlight lookup", () => {
    expect(pageSrc).toContain("data-contact-id={row.contactId ?? undefined}");
  });

  it("washes the row light blue with an accent — and nothing else", () => {
    // Light blue wash + blue left accent + fade transition.
    // (Border utilities only — the grid system forbids shadow
    // styling on the Workspace page.)
    expect(pageSrc).toContain("bg-blue-100/70");
    expect(pageSrc).toContain("border-l-4 border-l-blue-500");
    expect(pageSrc).toContain("duration-1000");
    // No singular "From Call Recording" badge, label, chip, or
    // text — the wash alone identifies the lead. (Pre-existing
    // "from Call Recordings" code comments are not UI.)
    expect(pageSrc).not.toMatch(/from call recording(?!s)/i);
  });

  it("renders the miss notice with a dismiss action", () => {
    expect(pageSrc).toContain("deepLinkNotice");
    expect(pageSrc).toContain('role="status"');
    expect(pageSrc).toContain("setDeepLinkNotice(null)");
  });
});
