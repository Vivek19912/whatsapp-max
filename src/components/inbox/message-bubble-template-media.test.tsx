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
    // the bubble, body, timestamp must all survive — with no badge.
    expect(out).toContain(broken);
    expect(out).toContain("Body intact");
    expect(out).not.toContain(">Template<");
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

  it("9. no badge on image headers; delivery status remains visible", () => {
    const out = html(
      msg({
        content_text: "Body",
        template_name: "t6",
        status: "delivered",
        interactive_buttons: undefined,
      }),
      { header_type: "image", header_media_url: IMG },
    );
    // Badge removed from image-header bubbles (alt text is not a badge).
    expect(out).not.toContain(">Template<");
    expect(out).not.toContain("bg-black/55");
    // Non-read outbound renders "Unseen" per locked Seen/Unseen semantics.
    expect(out).toContain("Unseen");
    // Timestamp renders.
    expect(out).toMatch(/\d{1,2}:\d{2} [AP]M/);
  });
});

describe("WhatsApp-style media template layout (rendered component)", () => {
  const LONG_BODY = [
    "*Namaste!* 🙏",
    "Kashi Yatra package for 4 days.",
    "• Specialist guidance",
    "• Daily aarti darshan",
    "Call *98765 43210* for details.",
    "",
    "*What's Next?*",
    "Reply to confirm your seat. 🙏",
  ].join("\n");

  function mediaHtml(body: string, url: string): string {
    return html(
      msg({ content_text: body, template_name: "promo" }),
      { header_type: "image", header_media_url: url },
    );
  }

  it("1. tall portrait poster fills the bubble width without distortion", () => {
    const out = mediaHtml("Poster body", "https://cdn.test/poster-tall.jpg");
    // Template img uses full parent width + contain (never cropped).
    expect(out).toMatch(/<img[^>]*w-full[^>]*object-contain/);
    // No narrow intrinsic-size or capped sizing on the template image.
    expect(out).not.toMatch(/<img[^>]*w-auto/);
    expect(out).not.toMatch(/<img[^>]*sm:max-w-\[320px\]/);
    expect(out).toContain("Poster body");
  });

  it("2. landscape promotional image uses the same full-width layout", () => {
    const out = mediaHtml("Landscape body", "https://cdn.test/banner-wide.png");
    expect(out).toMatch(/<img[^>]*w-full[^>]*object-contain/);
    expect(out).toContain("https://cdn.test/banner-wide.png");
  });

  it("3. square image renders undistorted with aligned text", () => {
    const out = mediaHtml("Square body", "https://cdn.test/square.webp");
    const imgIdx = out.indexOf("<img");
    const textIdx = out.indexOf("Square body");
    expect(imgIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(imgIdx);
    expect(out).toMatch(/<img[^>]*object-contain/);
  });

  it("4. long body keeps paragraphs, emojis, and line breaks", () => {
    const out = mediaHtml(LONG_BODY, IMG);
    expect(out).toContain("Kashi Yatra package for 4 days.");
    expect(out).toContain("🙏");
    expect(out).toContain("Reply to confirm your seat.");
    expect(out).toContain("whitespace-pre-wrap");
  });

  it("5. *bold* and bullet-like lines render naturally", () => {
    const out = mediaHtml(LONG_BODY, IMG);
    // Bold runs render as <strong> without raw asterisks.
    expect(out).toContain("<strong");
    expect(out).toContain("Namaste!");
    expect(out).not.toContain("*Namaste!*");
    expect(out).toContain("98765 43210");
    expect(out).not.toContain("*98765 43210*");
    expect(out).toContain("What&#x27;s Next?");
    // Bullets preserved as text.
    expect(out).toContain("Specialist guidance");
  });

  it("6. text-only template keeps the compact text layout", () => {
    const out = html(
      msg({ content_text: "*Hi* there", template_name: "plain" }),
      null,
    );
    expect(out).not.toContain("<img");
    expect(out).toContain("Hi");
    expect(out).not.toContain("*Hi*");
  });

  it("7. document/PDF template still renders the attachment card", () => {
    const out = html(
      msg({ content_text: "Doc body", template_name: "doc", media_file_name: "notice.pdf" }),
      { header_type: "document", header_media_url: DOC },
    );
    expect(out).toContain(DOC);
    expect(out).toContain("notice.pdf");
  });

  it("8. video template renders a full-width player", () => {
    const out = html(
      msg({ content_text: "Watch this", template_name: "vid" }),
      { header_type: "video", header_media_url: "https://cdn.test/clip.mp4" },
    );
    expect(out).toMatch(/<video[^>]*w-full/);
    expect(out).toContain("Watch this");
  });

  it("9/10. theme-aware bubble styling (light/dark via tokens)", () => {
    const out = mediaHtml("Themed body", IMG);
    // Theme tokens — no hardcoded hex colors in the media template branch.
    expect(out).toContain("bg-primary");
    expect(out).toContain("text-primary-foreground");
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("bubble stays compact: fixed content column, clipped overflow", () => {
    const out = mediaHtml("Compact", IMG);
    expect(out).toContain("w-[270px]");
    expect(out).toContain("sm:w-[320px]");
    expect(out).toContain("overflow-hidden");
  });

  it("timestamp/status row keeps padding and stays below the body", () => {
    const out = mediaHtml("Body text", IMG);
    const textIdx = out.indexOf("Body text");
    const timeIdx = out.search(/\d{1,2}:\d{2} [AP]M/);
    expect(timeIdx).toBeGreaterThan(textIdx);
    expect(out).toContain("Unseen");
  });

  it("ordinary inbound image message sizing is unchanged", () => {
    const out = renderToStaticMarkup(
      <MessageBubble
        message={msg({
          sender_type: "customer",
          content_type: "image",
          content_text: "plain photo",
          media_url: "https://cdn.test/photo.jpg",
        })}
      />,
    );
    // Ordinary path keeps intrinsic sizing + cover + cap.
    expect(out).toMatch(/<img[^>]*w-auto/);
    expect(out).toMatch(/<img[^>]*object-cover/);
  });
});

describe("template image top spacing (rendered component)", () => {
  const out = renderToStaticMarkup(
    <MessageBubble
      message={msg({
        content_text: "Top gap body",
        template_name: "promo",
      })}
      template={{ header_type: "image", header_media_url: "https://cdn.test/poster.jpg" }}
    />,
  );

  it("image sits ~4px from the bubble top with no in-flow gap row", () => {
    // Image wrapper keeps only pt-1 above the image.
    expect(out).toContain("px-2 pt-1");
    // No in-flow badge margins ahead of the image branch.
    expect(out).not.toContain("mt-1.5");
  });

  it("badge is gone but image position and size are unchanged", () => {
    expect(out).not.toContain(">Template<");
    expect(out).not.toContain("bg-black/55");
    expect(out).toContain("px-2 pt-1");
    expect(out).toMatch(/<img[^>]*w-full[^>]*object-contain/);
    expect(out).toContain("Top gap body");
  });

  it("horizontal sizing and image-to-text spacing are unchanged", () => {
    expect(out).toMatch(/<img[^>]*w-full[^>]*object-contain/);
    expect(out).toContain("px-2.5 pb-0.5 pt-1.5");
    expect(out).toContain("Top gap body");
  });

  it("video headers keep the existing in-flow badge layout", () => {
    const video = renderToStaticMarkup(
      <MessageBubble
        message={msg({ content_text: "Watch", template_name: "vid" })}
        template={{ header_type: "video", header_media_url: "https://cdn.test/clip.mp4" }}
      />,
    );
    expect(video).toContain("mt-1.5");
    expect(video).toContain(">Template<");
    expect(video).toMatch(/<video[^>]*w-full/);
    expect(video).not.toMatch(/<span[^>]*absolute[^>]*>([\s\S]*?)Template/);
  });
});
