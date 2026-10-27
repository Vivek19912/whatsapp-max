import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  displayMessageStatus,
  documentDisplayName,
  interactiveRenderKind,
  templateMediaKind,
} from "./message-bubble";

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "interactive",
    status: "delivered",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const BUTTONS = [
  { id: "reply_travel", title: "Travel Agency Owner" },
  { id: "reply_tour", title: "Tour Operator" },
  { id: "reply_cab", title: "Cab services" },
];

describe("interactiveRenderKind", () => {
  it("incoming button reply → inbound-reply (tapped title, interactive_reply_id)", () => {
    const m = msg({
      sender_type: "customer",
      content_text: "Travel Agency Owner",
      interactive_reply_id: "reply_travel",
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "inbound-reply",
      buttons: [],
    });
  });

  it("outgoing bot prompt with stored buttons → outgoing-prompt, buttons in order", () => {
    const m = msg({
      sender_type: "bot",
      content_text: "What best describes your business?",
      interactive_buttons: BUTTONS,
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "outgoing-prompt",
      buttons: BUTTONS,
    });
  });

  it("outgoing bot prompt with NULL interactive_buttons (historical row) → plain", () => {
    const m = msg({
      sender_type: "bot",
      content_text: "Awesome! Ubaid ✨ What best describes your business?",
      interactive_buttons: undefined,
    });
    expect(interactiveRenderKind(m)).toEqual({
      kind: "plain",
      buttons: [],
    });
  });

  it("outgoing bot prompt with an empty buttons array → plain (safe render)", () => {
    const m = msg({ sender_type: "bot", interactive_buttons: [] });
    expect(interactiveRenderKind(m)).toEqual({ kind: "plain", buttons: [] });
  });

  it("malformed stored entries are filtered out instead of crashing the render", () => {
    const m = msg({
      sender_type: "bot",
      interactive_buttons: [
        { id: "a", title: "Yes" },
        null,
        { id: "b" },
        { title: "No title id" },
        { id: "c", title: 42 as unknown as string },
      ] as Message["interactive_buttons"],
    });
    const r = interactiveRenderKind(m);
    expect(r.kind).toBe("outgoing-prompt");
    expect(r.buttons).toEqual([{ id: "a", title: "Yes" }]);
  });

  it("non-interactive content types → plain (untouched)", () => {
    expect(
      interactiveRenderKind(msg({ content_type: "text", content_text: "hi" })),
    ).toEqual({ kind: "plain", buttons: [] });
  });
});

describe("documentDisplayName", () => {
  it("prefers the persisted original filename", () => {
    expect(
      documentDisplayName({
        media_file_name: "invoice.pdf",
        content_text: "Q3 report",
      }),
    ).toBe("invoice.pdf");
  });

  it("falls back to the caption (inbound docs store caption||filename there)", () => {
    expect(
      documentDisplayName({ media_file_name: null, content_text: "Q3 report" }),
    ).toBe("Q3 report");
  });

  it("falls back to a generic label when nothing is stored", () => {
    expect(documentDisplayName({})).toBe("Document");
    expect(
      documentDisplayName({ media_file_name: "  ", content_text: "  " }),
    ).toBe("Document");
  });
});

describe("templateMediaKind", () => {
  it("returns null without a media_url", () => {
    expect(templateMediaKind({})).toBeNull();
    expect(templateMediaKind({ media_url: "  " })).toBeNull();
  });

  it("maps mime prefixes to image/video/document", () => {
    expect(
      templateMediaKind({ media_url: "https://x/y", media_mime_type: "image/jpeg" }),
    ).toBe("image");
    expect(
      templateMediaKind({ media_url: "https://x/y", media_mime_type: "video/mp4" }),
    ).toBe("video");
    expect(
      templateMediaKind({
        media_url: "https://x/y.pdf",
        media_mime_type: "application/pdf",
      }),
    ).toBe("document");
  });

  it("falls back to URL extension when mime is missing", () => {
    expect(templateMediaKind({ media_url: "https://cdn.test/hero.jpg" })).toBe(
      "image",
    );
    expect(templateMediaKind({ media_url: "https://cdn.test/clip.mp4" })).toBe(
      "video",
    );
    expect(templateMediaKind({ media_url: "https://cdn.test/file.pdf" })).toBe(
      "document",
    );
  });
});

describe("displayMessageStatus (Seen/Unseen semantics, locked)", () => {
  it("only Meta read renders Seen", () => {
    expect(displayMessageStatus("read")).toBe("Seen");
  });

  it("sent and delivered both render Unseen", () => {
    expect(displayMessageStatus("sent")).toBe("Unseen");
    expect(displayMessageStatus("delivered")).toBe("Unseen");
  });

  it("failed and sending keep their own labels", () => {
    expect(displayMessageStatus("failed")).toBe("Failed");
    expect(displayMessageStatus("sending")).toBe("Sending");
  });
});
