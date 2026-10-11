import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WhatsappIcon,
  WHATSAPP_ICON_BODY_PATH,
  WHATSAPP_ICON_HANDSET_PATH,
  WHATSAPP_ICON_VIEWBOX,
} from "./whatsapp-icon";

const root = process.cwd();

// ---------------------------------------------------------------------------
// WhatsappIcon — the ONE shared WhatsApp brand mark. Geometry must be
// the EXACT user-provided SVG path data (verbatim); rendering uses a
// cropped 346x346 viewBox so compact UI shows no empty gutter.
// ---------------------------------------------------------------------------

// Exact user-supplied path data, copied from the request. The icon
// module must reproduce these strings verbatim — never a redrawn,
// Font Awesome, or "WhatsApp-like" substitute.
const USER_BODY_PATH =
  "M173,0C77.45,0,0,77.45,0,173c0,31.43,8.38,60.91,23.04,86.31L0,346l89.87-21.25c24.67,13.54,53,21.25,83.13,21.25,95.55,0,173-77.45,173-173S268.55,0,173,0ZM173,315.01c-28.91,0-55.81-8.64-78.24-23.48l-53.1,13.52,14.89-50.75c-16.11-23.03-25.56-51.06-25.56-81.3,0-78.43,63.58-142.01,142.01-142.01s142.01,63.58,142.01,142.01-63.58,142.01-142.01,142.01Z";

const USER_HANDSET_PATH =
  "M213.54,195.84l41.86,19.73c1.92.91,3.15,2.85,2.98,4.97-.45,5.51-2.66,16.55-12.56,26.44-27.93,27.93-78.09-3.67-80.13-4.89-12.34-6.63-24.06-15.49-35.17-26.61-11.11-11.11-19.98-22.84-26.61-35.17-1.22-2.04-32.82-52.19-4.89-80.13,9.9-9.9,20.93-12.1,26.44-12.56,2.12-.17,4.07,1.06,4.97,2.98l19.73,41.86c.93,1.98.52,4.33-1.02,5.88l-14.71,14.71c-3.18,3.18-4.12,8.13-1.92,12.06,5.37,9.63,12.59,18.9,20.95,27.43,8.53,8.36,17.8,15.58,27.43,20.95,3.93,2.19,8.88,1.26,12.06-1.92l14.71-14.71c1.55-1.55,3.9-1.96,5.88-1.02Z";

describe("WhatsappIcon geometry", () => {
  it("uses the exact user-provided body path", () => {
    expect(WHATSAPP_ICON_BODY_PATH).toBe(USER_BODY_PATH);
  });

  it("uses the exact user-provided handset path", () => {
    expect(WHATSAPP_ICON_HANDSET_PATH).toBe(USER_HANDSET_PATH);
  });

  it("renders both user paths with currentColor and no hard-coded brand color", () => {
    const out = renderToStaticMarkup(<WhatsappIcon />);
    expect(out).toContain(`d="${USER_BODY_PATH}"`);
    expect(out).toContain(`d="${USER_HANDSET_PATH}"`);
    expect(out.match(/fill="currentColor"/g)).toHaveLength(2);
    expect(out).not.toContain("#25D366");
    expect(out).not.toContain("448 512");
    expect(out).not.toContain("380.9");
  });

  it("crops the wide supplied viewBox to the 346x346 mark area", () => {
    expect(WHATSAPP_ICON_VIEWBOX).toBe("0 0 346 346");
    expect(renderToStaticMarkup(<WhatsappIcon />)).toContain(
      'viewBox="0 0 346 346"',
    );
    expect(renderToStaticMarkup(<WhatsappIcon />)).not.toContain("1487.13");
  });
});

describe("WhatsappIcon sizing and accessibility", () => {
  it("defaults to compact 16x16", () => {
    const out = renderToStaticMarkup(<WhatsappIcon />);
    expect(out).toContain('width="16"');
    expect(out).toContain('height="16"');
  });

  it("scales to caller sizes without changing the SVG", () => {
    for (const size of [14, 18, 20, 24]) {
      const out = renderToStaticMarkup(<WhatsappIcon size={size} />);
      expect(out).toContain(`width="${size}"`);
      expect(out).toContain(`height="${size}"`);
      expect(out).toContain(`d="${USER_BODY_PATH}"`);
    }
  });

  it("is decorative by default (no duplicate screen-reader text)", () => {
    const out = renderToStaticMarkup(<WhatsappIcon />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("aria-label");
  });

  it("supports standalone meaningful usage via label", () => {
    const out = renderToStaticMarkup(<WhatsappIcon label="WhatsApp" />);
    expect(out).toContain('aria-label="WhatsApp"');
    expect(out).toContain('role="img"');
    expect(out).not.toContain("aria-hidden");
  });

  it("keeps the stable brand data-icon hook", () => {
    expect(renderToStaticMarkup(<WhatsappIcon />)).toContain(
      'data-icon="whatsapp-brand"',
    );
  });
});

describe("Single WhatsApp icon source across user-facing UI", () => {
  const consumers = [
    "src/components/recordings/recordings-table.tsx",
    "src/components/recordings/recording-drawer.tsx",
    "src/components/recordings/summary-cards.tsx",
    "src/components/calls/call-period-card.tsx",
    "src/components/team-members/recording-config-dialog.tsx",
  ];

  it("every WhatsApp-brand surface imports the shared component", () => {
    for (const file of consumers) {
      const src = readFileSync(`${root}/${file}`, "utf8");
      expect(src, file).toContain("@/components/icons/whatsapp-icon");
    }
  });

  it("no WhatsApp-brand surface uses a generic chat icon", () => {
    const table = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(table).not.toContain("MessageCircle");
    expect(table).not.toContain("WhatsappBrandIcon");
    const drawer = readFileSync(
      `${root}/src/components/recordings/recording-drawer.tsx`,
      "utf8",
    );
    expect(drawer).not.toContain("MessageCircle");
    const summary = readFileSync(
      `${root}/src/components/recordings/summary-cards.tsx`,
      "utf8",
    );
    expect(summary).not.toContain("MessageCircle");
    const card = readFileSync(
      `${root}/src/components/calls/call-period-card.tsx`,
      "utf8",
    );
    expect(card).not.toContain("MessageCircle");
    const dialog = readFileSync(
      `${root}/src/components/team-members/recording-config-dialog.tsx`,
      "utf8",
    );
    expect(dialog).not.toContain("MessageCircle");
  });

  it("the old duplicate WhatsApp mark is gone (no second variant)", () => {
    const icons = readFileSync(
      `${root}/src/components/icons/call-type-icons.tsx`,
      "utf8",
    );
    expect(icons).not.toContain("WhatsappBrandIcon");
    expect(icons).not.toContain("448 512");
    expect(icons).toContain("PhoneHandsetIcon");
  });

  it("owner configuration still distinguishes WhatsApp vs WhatsApp Business", () => {
    const dialog = readFileSync(
      `${root}/src/components/team-members/recording-config-dialog.tsx`,
      "utf8",
    );
    expect(dialog).toContain("{ value: 'whatsapp'");
    expect(dialog).toContain("{ value: 'whatsapp_business'");
    expect(dialog).toContain("WhatsApp Business");
  });

  it("underlying stored call_type values stay distinct in reporting UI", () => {
    const table = readFileSync(
      `${root}/src/components/recordings/recordings-table.tsx`,
      "utf8",
    );
    expect(table).toContain("'whatsapp'");
    expect(table).toContain("'whatsapp_business'");
  });
});
