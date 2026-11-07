import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RecordingsTable,
  PAGE_SIZE,
} from "./recordings-table";
import type { CallRecording } from "@/lib/recordings/recordings";

const root = process.cwd();

// ---------------------------------------------------------------------------
// RecordingsTable — SSR covers static markup (headers, order,
// numbers, labels); interaction (row select, play, pagination)
// stays owned by the tested page wiring and Base UI.
// ---------------------------------------------------------------------------

function recording(over: Partial<CallRecording> = {}): CallRecording {
  // Local-zone construction (like the lib tests) so time/date
  // assertions hold in any test environment timezone.
  const at = new Date(2026, 9, 6, 16, 7).toISOString();
  return {
    id: "r-1",
    account_id: "acct-1",
    contact_id: "c-1",
    conversation_id: null,
    uploaded_by: "u-1",
    uploader_name: "Vikas",
    contact_name: "Akash",
    storage_bucket: "call-recordings",
    storage_path: "account-acct-1/1.ogg",
    file_name: "20261006_040707.435+0530_out_Akash.ogg",
    mime_type: "audio/ogg",
    file_size: 59400,
    duration_seconds: 16,
    recorded_at: at,
    created_at: at,
    direction: "out",
    phone_number: "+918953065369",
    call_type: "phone",
    workspace_table_name: "Meta Lead Ads",
    ...over,
  };
}

function html(
  recordings: CallRecording[] = [recording()],
  extra: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    <RecordingsTable
      recordings={recordings}
      loading={false}
      page={0}
      total={recordings.length}
      pageSize={PAGE_SIZE}
      onPage={() => {}}
      onPageSize={() => {}}
      {...extra}
    />,
  );
}

function headerCells(markup: string): string[] {
  const thead = markup.slice(markup.indexOf("<thead"), markup.indexOf("</thead>"));
  return [...thead.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, "").trim(),
  );
}

function rowNumbers(markup: string): string[] {
  const tbody = markup.slice(markup.indexOf("<tbody"), markup.indexOf("</tbody>"));
  // No. is the only cell holding a bare integer (durations carry ":").
  return [...tbody.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map((m) => m[1]);
}

describe("RecordingsTable columns", () => {
  it("orders headers No. | Time | Lead Name | Workspace Table | Call | Salesperson | Recording", () => {
    expect(headerCells(html())).toEqual([
      "No.",
      "Time",
      "Lead Name",
      "Workspace Table",
      "Call",
      "Salesperson",
      "Recording",
    ]);
  });

  it("has no Duration column header", () => {
    expect(headerCells(html())).not.toContain("Duration");
  });

  it("numbers rows sequentially from the page offset without restarting", () => {
    const rows = [recording({ id: "r-1" }), recording({ id: "r-2" })];
    expect(rowNumbers(html(rows, { page: 0, total: 60 }))).toEqual(["1", "2"]);
    expect(rowNumbers(html(rows, { page: 1, total: 60 }))).toEqual([
      String(PAGE_SIZE + 1),
      String(PAGE_SIZE + 2),
    ]);
  });

  it("uses the Workspace header treatment", () => {
    const out = html();
    const thead = out.slice(out.indexOf("<thead"), out.indexOf("</thead>"));
    expect(thead).toContain("h-16");
    expect(thead).toContain("font-bold");
    expect(thead).toContain("text-[15px]");
    expect(thead).toContain("border-r");
  });

  it("paints the header row with the Workspace header tint, never plain white", () => {
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    // Workspace "No." row-number reference tone (HEADER_REFERENCE_ROW).
    expect(src).toContain("[&_th]:bg-[#f1f5f9]");
  });

  it("separates body rows with Workspace dividers", () => {
    const out = html();
    const tbody = out.slice(out.indexOf("<tbody"), out.indexOf("</tbody>"));
    expect(tbody).toContain("border-r");
  });

  it("marks the open player's row via data-state like the design system", () => {
    // SSR renders every popover closed, so no row carries the
    // selected state by default — selection follows the single
    // openId, asserted in source below.
    const out = html();
    expect(out).not.toContain('data-state="selected"');
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(src).toContain("data-state={playerOpen ? 'selected' : undefined}");
  });
});

describe("Time cell", () => {
  it("shows time before date", () => {
    const out = html();
    // Local 4:07 PM on 06 Oct 2026 by construction above.
    expect(out).toContain("4:07 PM");
    expect(out).toContain("06 Oct 2026");
    expect(out.indexOf("4:07 PM")).toBeLessThan(out.indexOf("06 Oct 2026"));
  });

  it("renders no seconds", () => {
    const out = html();
    expect(out).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe("Workspace Table column", () => {
  it("shows the resolved table name with a full-name tooltip", () => {
    const out = html([recording({ workspace_table_name: "Meta Lead Ads" })]);
    expect(out).toContain("Meta Lead Ads");
    expect(out).toContain('title="Meta Lead Ads"');
  });

  it("shows an em dash for unlinked recordings", () => {
    const out = html([
      recording({ contact_id: null, contact_name: null, workspace_table_name: null }),
    ]);
    const tbody = out.slice(out.indexOf("<tbody"), out.indexOf("</tbody>"));
    expect(tbody).toContain("—");
  });

  it("shows an em dash when the table cannot be resolved", () => {
    const out = html([recording({ workspace_table_name: null })]);
    expect(out).toContain("—");
    expect(out).not.toContain("Untitled");
  });

  it("truncates long table names", () => {
    const out = html([
      recording({ workspace_table_name: "Instant Form for Couple Kashmir" }),
    ]);
    // Full name available via title; cell truncates.
    expect(out).toContain('title="Instant Form for Couple Kashmir"');
    expect(out).toContain("truncate");
  });
});

describe("Call column (merged type + direction)", () => {
  // Scope to the label's own span: sibling UI (avatar, Play button)
  // legitimately uses filled backgrounds elsewhere in the row.
  function labelSpan(markup: string, text: string): string {
    const idx = markup.indexOf(`> ${text}<`);
    const withIcon = idx === -1 ? markup.indexOf(text) : idx;
    const start = markup.lastIndexOf("<span", withIcon);
    return markup.slice(start, markup.indexOf("</span>", start));
  }

  it("Phone renders icon only with an accessible name and tooltip", () => {
    const out = html([recording({ call_type: "phone" })]);
    expect(out).toContain('data-icon="phone-handset"');
    expect(out).toContain('aria-label="Phone"');
    // Tooltip content is portal-mounted (no SSR markup); the wiring
    // is pinned by source instead.
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(src).toContain("<TooltipContent>{label}</TooltipContent>");
  });

  it("WhatsApp renders the brand icon only, named via tooltip", () => {
    const out = html([recording({ call_type: "whatsapp" })]);
    expect(out).toContain('data-icon="whatsapp-brand"');
    expect(out).toContain('aria-label="WhatsApp"');
    // Tooltip content carries the name; the cell shows no visible text.
    expect(out).not.toMatch(/>\s*WhatsApp\s*</);
  });

  it("WhatsApp Business displays as WhatsApp (merged reporting category)", () => {
    const out = html([recording({ call_type: "whatsapp_business" })]);
    expect(out).toContain('data-icon="whatsapp-brand"');
    // Same icon, same tooltip as whatsapp: one user-facing category.
    expect(out).toContain('aria-label="WhatsApp"');
    expect(out).not.toContain('aria-label="WhatsApp Business"');
    expect(out).not.toMatch(/>\s*WhatsApp Business\s*</);
  });

  it("Type column uses the single shared WhatsappIcon (no generic chat icon)", () => {
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(src).toContain("@/components/icons/whatsapp-icon");
    expect(src).not.toContain("WhatsappBrandIcon");
    expect(src).not.toContain("MessageCircle");
  });

  it("Unknown type shows an icon with an Unknown tooltip", () => {
    const out = html([recording({ call_type: null })]);
    expect(out).toContain('aria-label="Unknown"');
  });

  it("Type icons have no pill background", () => {
    const out = html([recording({ call_type: "whatsapp" })]);
    // Scope to the icon's own trigger span: sibling UI (avatar)
    // legitimately uses rounded-full elsewhere in the row.
    const at = out.indexOf('data-icon="whatsapp-brand"');
    const start = out.lastIndexOf("<span", at);
    const span = out.slice(start, out.indexOf("</span>", start));
    expect(span).not.toContain("rounded-full");
    expect(span).not.toContain("bg-");
  });

  it("Direction has icon plus text with no pill background", () => {
    const out = html([recording({ direction: "in" })]);
    expect(out).toContain("Incoming");
    const span = labelSpan(out, "Incoming");
    expect(span).not.toContain("rounded-full");
    expect(span).not.toContain("bg-");
  });

  it("Unknown direction renders as plain text", () => {
    const out = html([recording({ direction: null })]);
    expect(out).toContain("Unknown");
  });

  it("merges type and direction: phone icon beside Incoming text", () => {
    const out = html([recording({ call_type: "phone", direction: "in" })]);
    expect(out).toContain('data-icon="phone-handset"');
    expect(out).toContain("Incoming");
    const idx = out.indexOf("Incoming");
    const tdStart = out.lastIndexOf("<td", idx);
    const cell = out.slice(tdStart, out.indexOf("</td>", tdStart));
    expect(cell).toContain('data-icon="phone-handset"');
  });

  it("merges type and direction: WhatsApp icon beside Outgoing text", () => {
    const out = html([recording({ call_type: "whatsapp", direction: "out" })]);
    expect(out).toContain('data-icon="whatsapp-brand"');
    expect(out).toContain("Outgoing");
    const idx = out.indexOf("Outgoing");
    const tdStart = out.lastIndexOf("<td", idx);
    const cell = out.slice(tdStart, out.indexOf("</td>", tdStart));
    expect(cell).toContain('data-icon="whatsapp-brand"');
  });

  it("renders no directional arrow icons anywhere in the table", () => {
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(src).not.toContain("ArrowUp");
    expect(src).not.toContain("ArrowDown");
    for (const combo of [
      { call_type: "phone", direction: "in" },
      { call_type: "phone", direction: "out" },
      { call_type: "whatsapp", direction: "in" },
      { call_type: "whatsapp_business", direction: "out" },
      { call_type: null, direction: null },
    ] as const) {
      const out = html([recording(combo)]);
      // lucide arrows render as svg with these class fragments;
      // neither may appear in any Call cell.
      expect(out).not.toContain("arrow-up");
      expect(out).not.toContain("arrow-down");
    }
  });

  it("colors Incoming blue and Outgoing green, Unknown neutral", () => {
    // Scope to the OUTER span holding the visible direction text:
    // the type icon's own trigger span sits inside it, so step back
    // two opens from the text (trigger open, then outer open).
    const directionSpan = (markup: string, text: string): string => {
      const textIdx = markup.indexOf(`${text}</span>`);
      const triggerOpen = markup.lastIndexOf("<span", textIdx);
      const outerOpen = markup.lastIndexOf("<span", triggerOpen - 1);
      return markup.slice(outerOpen, textIdx);
    };
    expect(directionSpan(html([recording({ direction: "in" })]), "Incoming")).toContain(
      "text-blue-700",
    );
    expect(directionSpan(html([recording({ direction: "out" })]), "Outgoing")).toContain(
      "text-emerald-700",
    );
    expect(
      directionSpan(html([recording({ call_type: null, direction: null })]), "Unknown"),
    ).toContain("text-muted-foreground");
  });
});

describe("Salesperson column", () => {
  it("shows the uploader display name, never a bare user id", () => {
    const out = html([recording({ uploader_name: "Vikas" })]);
    expect(out).toContain("Vikas");
    expect(out).not.toContain("u-1");
  });

  it("falls back to Unknown when the name is unavailable", () => {
    const out = html([recording({ uploader_name: null })]);
    expect(out).toContain("Unknown");
  });
});

describe("Workspace pagination footer", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => recording({ id: `r-${i}` }));

  it("renders first/previous/numbered/next/last controls", () => {
    const out = html(many(25), { page: 2, total: 204, pageSize: 25 });
    for (const label of [
      "First page",
      "Previous page",
      "Next page",
      "Last page",
    ]) {
      expect(out).toContain(`aria-label="${label}"`);
    }
  });

  it("highlights the current page and shows the range", () => {
    const out = html(many(25), { page: 0, total: 204, pageSize: 25 });
    expect(out).toContain('aria-current="page"');
    expect(out).toContain("1–25 of 204");
    expect(out).toContain("Page 1 of 9");
  });

  it("offers the Workspace rows-per-page options", () => {
    // Base UI Select renders the trigger server-side; options
    // come from the shared WORKSPACE_PAGE_SIZES model.
    const out = html(many(25), { page: 0, total: 204, pageSize: 25 });
    expect(out).toContain('aria-label="Rows per page"');
  });

  it("numbers rows from the active page size, not a fixed constant", () => {
    const out = html(many(10), { page: 1, total: 60, pageSize: 10 as never });
    expect(rowNumbers(out)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(10 + i + 1)),
    );
  });
});
describe("Recordings page container", () => {
  // The shared DashboardShell main already provides p-4 sm:p-6
  // (same as /workspace); the page must not add a second inset or
  // a max-width cap that narrows the table versus Workspace.
  const pageSrc = readFileSync(
    `${root}/src/app/(dashboard)/recordings/page.tsx`,
    "utf8",
  );

  it("shares the shell gutter instead of double-insetting", () => {
    expect(pageSrc).not.toMatch(/max-w-\[1400px\]/);
    expect(pageSrc).toContain('<div className="flex w-full flex-col gap-4">');
  });

  it("keeps the tinted Workspace-style header treatment", () => {
    const tableSrc = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(tableSrc).toContain("[&_th]:bg-muted");
    expect(tableSrc).toContain("h-16");
  });
});

describe("Lead and Recording behavior", () => {
  // Lead cells hold only the name span now (the row's Play button
  // legitimately keeps its own rounded-full shape elsewhere).
  function leadCell(markup: string, name: string): string {
    const idx = markup.indexOf(`>${name}<`);
    const tdStart = markup.lastIndexOf("<td", idx);
    return markup.slice(tdStart, markup.indexOf("</td>", tdStart));
  }

  it("shows linked lead names with no avatar or initial", () => {
    const out = html();
    expect(out).toContain("Akash");
    const cell = leadCell(out, "Akash");
    expect(cell).not.toContain("rounded-full");
    expect(cell).not.toContain("bg-");
  });

  it("shows Unlinked with no avatar", () => {
    const out = html([recording({ contact_id: null, contact_name: null })]);
    const cell = leadCell(out, "Unlinked");
    expect(cell).not.toContain("rounded-full");
    expect(cell).not.toContain("bg-");
  });

  it("keeps the filename out of the table", () => {
    expect(html()).not.toContain("20261006_040707");
    expect(html()).not.toContain("59.4 KB");
  });

  it("keeps Play buttons with recording labels", () => {
    const out = html();
    expect(out).toContain('aria-label="Play recording of Akash"');
  });
});

describe("Compact Recording column", () => {
  it("headers the last column Recording, not Play", () => {
    expect(headerCells(html())).toContain("Recording");
    expect(headerCells(html())).not.toContain("Play");
  });

  it("shows only a Play button and duration per row by default", () => {
    // 16s fixture renders as 0:16 beside the trigger.
    const out = html();
    expect(out).toContain('aria-label="Play recording of Akash"');
    expect(out).toContain("0:16");
  });

  it("renders no Duration cells — duration lives only in the Recording readout", () => {
    // One row → exactly 7 cells and a single 0:16 (the Recording
    // cell readout). A Duration column would add an 8th cell and
    // a second 0:16.
    const out = html([recording()]);
    const tbody = out.slice(out.indexOf("<tbody"), out.indexOf("</tbody>"));
    expect(tbody.match(/<td[\s>]/g)).toHaveLength(7);
    expect(tbody.match(/0:16/g)).toHaveLength(1);
  });

  it("opens the player only from the Recording cell, never from the row", () => {
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    // No row-level opener: the body TableRow (up to the
    // Recording cell's Popover) carries no onClick, and no row
    // is a pointer surface.
    const bodyRow = src.slice(
      src.indexOf("recordings.map"),
      src.indexOf("<Popover"),
    );
    expect(bodyRow).not.toContain("onClick");
    expect(src).not.toContain("cursor-pointer");
    // The sole opener is the Recording cell's Play trigger, which
    // sets autoplay and flips this row's popover open.
    expect(src).toContain("setAutoplay(true)");
    expect(src).toContain("open={playerOpen}");
  });

  it("keeps the Play button small, blue, and circular", () => {
    const src = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(src).toContain("h-8 w-8");
    expect(src).toContain("rounded-full bg-blue-600");
  });

  it("renders no player chrome (seek, speeds, volume, audio) until opened", () => {
    // Closed popovers unmount their content: the row carries no
    // progress bar, speed group, sliders, or audio element.
    const out = html();
    expect(out).not.toContain("<audio");
    expect(out).not.toContain("Playback speed");
    expect(out).not.toContain('aria-label="Seek"');
    expect(out).not.toContain('aria-label="Volume"');
    expect(out).not.toContain("Close player");
  });

  it("opens no recording-details sidebar", () => {
    const pageSrc = readFileSync(
      `${root}/src/app/(dashboard)/recordings/page.tsx`,
      "utf8",
    );
    expect(pageSrc).not.toContain("RecordingDrawer");
    expect(pageSrc).not.toContain("recording-drawer");
  });
});

describe("Floating player popover", () => {
  const src = () =>
    readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );

  it("portals the player so rows never expand", () => {
    // The player is keyed per recording inside the popover
    // content; the shared ui/popover wrapper renders that
    // content in a Portal, outside the table layout entirely.
    expect(src()).toContain("PopoverContent");
    expect(src()).toContain("<RecordingPlayer");
    expect(src()).toContain("key={r.id}");
    const popover = readFileSync(
      `${root}/src/components/ui/popover.tsx`,
      "utf8",
    );
    expect(popover).toContain("PopoverPrimitive.Portal");
  });

  it("prefers above the row with flip/shift collision handling", () => {
    expect(src()).toContain('side="top"');
    expect(src()).toContain("collisionAvoidance={{ side: 'flip', align: 'shift' }}");
    expect(src()).toContain("collisionPadding={12}");
    expect(src()).toContain("max-w-[calc(100vw-2rem)]");
  });

  it("holds a single open player and resets autoplay on close", () => {
    expect(src()).toContain("const [openId, setOpenId] = useState<string | null>(null)");
    expect(src()).toContain("open={playerOpen}");
    expect(src()).toContain("else if (openId === r.id)");
  });

  it("closes stale players when filtering or pagination removes the row", () => {
    expect(src()).toContain("!recordings.some((r) => r.id === openId)");
  });

  it("pauses audio when the player unmounts", () => {
    const player = readFileSync(
      `${root}/src/components/recordings/recording-player.tsx`,
      "utf8",
    );
    expect(player).toContain("el?.pause()");
  });

  it("keeps Find / Link Lead reachable for unlinked recordings", () => {
    expect(src()).toContain("Find / Link Lead");
    expect(src()).toContain("onFindLead(r)");
    const pageSrc = readFileSync(
      `${root}/src/app/(dashboard)/recordings/page.tsx`,
      "utf8",
    );
    expect(pageSrc).toContain("LinkCallDrawer");
  });
});
