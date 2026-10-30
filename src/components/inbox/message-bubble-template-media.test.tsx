// UI-only: template header images render inside the Inbox bubble.
// Rendered-component tests via react-dom/server static markup (no DOM
// harness in this repo). MediaImage resolves direct CDN URLs
// synchronously, so static markup contains the <img> for direct URLs.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  MessageBubble,
  resolveTemplateHeaderMedia,
  templateMediaKind,
} from "./message-bubble";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "conv-1",
    sender_type: "agent",
    content_type: "template",
    status: "sent",
    created_at: "2026-01-01T10:00:00Z",
    ...overrides,
  };
}

const IMG = "https://cdn.test/headers/gajanand.jpg";
const DOC = "https://cdn.test/headers/notice.pdf";

function html(
  message: Message,
  template?: { header_type?: "text" | "image" | "video" | "document"; header_media_url?: string } | null,
): string {
  return renderToStaticMarkup(
    <MessageBubble message={message} template={template} />,
  );
}

describe("resolveTemplateHeaderMedia (pure resolver)", () => {
  it("prefers the row media_url when present", () => {
    expect(
      resolveTemplateHeaderMedia(
        { media_url: IMG, media_mime_type: "image/jpeg" },
        { header_type: "image", header_media_url: "https://cdn.test/other.jpg" },
      ),
    ).toEqual({ kind: "image", url: IMG });
  });

  it("falls back to the approved template header image", () => {
    expect(
      resolveTemplateHeaderMedia(
        {},
        { header_type: "image", header_media_url: IMG },
      ),
    ).toEqual({ kind: "image", url: IMG });
  });

  it("returns null when neither source has a URL", () => {
    expect(resolveTemplateHeaderMedia({}, null)).toBeNull();
    expect(
      resolveTemplateHeaderMedia({}, { header_type: "image" }),
    ).toBeNull();
    expect(
      resolveTemplateHeaderMedia({}, { header_type: "text", header_media_url: "" }),
    ).toBeNull();
  });

  it("never invents a URL from the template name", () => {
    expect(
      resolveTemplateHeaderMedia(
        { media_url: null },
        { header_type: "image", header_media_url: "   " },
      ),
    ).toBeNull();
  });
});

describe("template bubble rendering (actual component)", () => {
  it("1. template with image URL displays the image", () => {
    const out = html(
      msg({ content_text: "Namaste", template_name: "gajanand_kashi_notice_2026" }),
      { header_type: "image", header_media_url: IMG },
    );
    expect(out).toContain(`<img`);
    expect(out).toContain(IMG);
  });

  it("2. template text appears below the image", () => {
    const out = html(
      msg({ content_text: "Yatra details", template_name: "t1" }),
      { header_type: "image", header_media_url: IMG },
    );
    const imgIdx = out.indexOf("<img");
    const textIdx = out.indexOf("Yatra details");
    expect(imgIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(imgIdx);
  });

  it("3. image uses the correct existing URL for that template", () => {
    const other = "https://cdn.test/headers/other.jpg";
    const out = html(
      msg({ content_text: "Hi", template_name: "gajanand_kashi_notice_2026" }),
      { header_type: "image", header_media_url: IMG },
    );
    expect(out).toContain(IMG);
    expect(out).not.toContain(other);
  });

  it("3b. row media_url wins over the template fallback", () => {
    const rowUrl = "https://cdn.test/row/actual.jpg";
    const out = html(
      msg({
        content_text: "Hi",
        template_name: "t1",
        media_url: rowUrl,
        media_mime_type: "image/jpeg",
      }),
      { header_type: "image", header_media_url: IMG },
    );
    expect(out).toContain(rowUrl);
    expect(out).not.toContain(IMG);
  });

  it("4. template without an image continues displaying text normally", () => {
    const out = html(msg({ content_text: "Plain body", template_name: "t2" }), null);
    expect(out).toContain("Plain body");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<video");
    expect(out).toContain("Template");
  });

  it("5. missing image URL produces a graceful fallback", () => {
    const out = html(
      msg({ content_text: "Body stays", template_name: "t3" }),
      { header_type: "image" },
    );
    expect(out).toContain("Body stays");
    expect(out).not.toContain("<img");
  });

  it("6. broken image URL does not break the bubble", () => {
    const broken = "https://cdn.test/headers/missing.jpg";
    const out = html(
      msg({ content_text: "Body intact", template_name: "t4" }),
      { header_type: "image", header_media_url: broken },
    );
    // Static render keeps the <img> (client swaps to fallback on error);
    // the bubble, badge, body and timestamp must all survive.
    expect(out).toContain(broken);
    expect(out).toContain("Body intact");
    expect(out).toContain("Template");
  });

  it("7. existing document/PDF template rendering still works", () => {
    const out = html(
      msg({ content_text: "Doc body", template_name: "t5", media_file_name: "notice.pdf" }),
      { header_type: "document", header_media_url: DOC },
    );
    expect(out).toContain(DOC);
    expect(out).toContain("notice.pdf");
    expect(out).toContain("Doc body");
    expect(out).not.toContain("<img");
  });

  it("8. normal inbound/outbound media rendering remains unchanged", () => {
    const inbound = renderToStaticMarkup(
      <MessageBubble
        message={msg({
          sender_type: "customer",
          content_type: "image",
          content_text: "caption here",
          media_url: "https://cdn.test/inbound.jpg",
        })}
      />,
    );
    expect(inbound).toContain("https://cdn.test/inbound.jpg");
    expect(inbound).toContain("caption here");

    const outbound = renderToStaticMarkup(
      <MessageBubble
        message={msg({
          sender_type: "agent",
          content_type: "document",
          content_text: "report.pdf",
          media_url: "https://cdn.test/report.pdf",
          media_file_name: "report.pdf",
        })}
      />,
    );
    expect(outbound).toContain("report.pdf");

    // templateMediaKind behavior untouched.
    expect(
      templateMediaKind({ media_url: IMG, media_mime_type: "image/jpeg" }),
    ).toBe("image");
  });

  it("9. badge and delivery status remain visible with a header image", () => {
    const out = html(
      msg({
        content_text: "Body",
        template_name: "t6",
        status: "delivered",
        interactive_buttons: undefined,
      }),
      { header_type: "image", header_media_url: IMG },
    );
    expect(out).toContain("Template");
    // Non-read outbound renders "Unseen" per locked Seen/Unseen semantics.
    expect(out).toContain("Unseen");
    // Timestamp renders.
    expect(out).toMatch(/\d{1,2}:\d{2} [AP]M/);
  });
});
