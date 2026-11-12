import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TemplatePreviewCard,
  renderPreviewText,
} from "./template-preview";
import {
  templateDetailKey,
  toTemplateDetails,
} from "./assignment-template-utils";

const rows = [
  {
    name: "hello_world",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    header_type: "image",
    header_content: null,
    header_media_url: "https://example.com/hero.jpg",
    body_text: "Hello {{1}},\nYour order {{2}} is ready.",
    footer_text: "Reply STOP to opt out",
    buttons: [
      { type: "QUICK_REPLY", text: "Track" },
      { type: "URL", text: "Visit", url: "https://example.com" },
    ],
    sample_values: { body: ["Asha", "123"] },
  },
  { name: "plain", language: "en_US", status: "APPROVED", category: null },
];

describe("toTemplateDetails", () => {
  it("indexes full rows by name+language and drops malformed rows", () => {
    const map = toTemplateDetails([
      ...rows,
      { name: "", language: "en_US" },
      { name: "hello_world", language: "en_US", body_text: "changed" },
      "nope",
    ] as Array<Record<string, unknown>>);
    expect(map.size).toBe(2);
    const detail = map.get(templateDetailKey({ name: "hello_world", language: "en_US" }));
    expect(detail?.bodyText).toContain("{{1}}");
    expect(detail?.headerMediaUrl).toBe("https://example.com/hero.jpg");
    expect(detail?.buttons).toHaveLength(2);
    expect(detail?.sampleValues).toEqual({ body: ["Asha", "123"] });
    // First row wins on duplicates.
    expect(detail?.bodyText).not.toBe("changed");
  });

  it("normalizes missing content to safe empties (never fabricated)", () => {
    const map = toTemplateDetails(rows as Array<Record<string, unknown>>);
    const plain = map.get(templateDetailKey({ name: "plain", language: "en_US" }))!;
    expect(plain.bodyText).toBe("");
    expect(plain.headerType).toBeNull();
    expect(plain.headerMediaUrl).toBeNull();
    expect(plain.footerText).toBeNull();
    expect(plain.buttons).toEqual([]);
    expect(plain.category).toBeNull();
  });
});

describe("renderPreviewText", () => {
  it("substitutes sample values and keeps unknown placeholders", () => {
    expect(
      renderPreviewText("Hi {{1}}, code {{9}}", { body: ["Asha"] }, "body"),
    ).toBe("Hi Asha, code {{9}}");
    expect(renderPreviewText("No vars", undefined)).toBe("No vars");
  });
});

describe("TemplatePreviewCard (rendered output)", () => {
  it("shows header image, full body, footer, buttons and variables", () => {
    const map = toTemplateDetails(rows as Array<Record<string, unknown>>);
    const detail = map.get(templateDetailKey({ name: "hello_world", language: "en_US" }))!;
    const html = renderToStaticMarkup(<TemplatePreviewCard detail={detail} />);
    expect(html).toContain("hello_world");
    expect(html).toContain("UTILITY");
    expect(html).toContain("https://example.com/hero.jpg");
    // Full body with sample substitution and preserved newline.
    expect(html).toContain("Hello Asha,");
    expect(html).toContain("Your order");
    expect(html).toContain("Reply STOP to opt out");
    expect(html).toContain("Track");
    expect(html).toContain("Visit");
  });

  it("shows an unavailable image state instead of fabricating one", () => {
    const map = toTemplateDetails([
      { name: "img", language: "en_US", header_type: "image" },
    ] as Array<Record<string, unknown>>);
    const html = renderToStaticMarkup(
      <TemplatePreviewCard detail={map.get(templateDetailKey({ name: "img", language: "en_US" }))!} />,
    );
    expect(html).toContain("Image header unavailable for preview");
    expect(html).not.toContain("<img");
  });

  it("handles empty bodies without crashing", () => {
    const map = toTemplateDetails(rows as Array<Record<string, unknown>>);
    const html = renderToStaticMarkup(
      <TemplatePreviewCard detail={map.get(templateDetailKey({ name: "plain", language: "en_US" }))!} />,
    );
    expect(html).toContain("No message body stored");
  });
});
